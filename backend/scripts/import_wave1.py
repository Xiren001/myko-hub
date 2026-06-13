"""
One-time import of Wave 1 from Excel into Supabase.
Wave 1 is archived in Monday.com so it can only be seeded from the Excel export.

Usage:
  SUPABASE_URL=https://vegbhkqesgxjeqpwehcl.supabase.co \
  SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key> \
  python3 backend/scripts/import_wave1.py
"""

import os, json
import openpyxl
import urllib.request

SUPABASE_URL = os.environ["SUPABASE_URL"]
SERVICE_KEY  = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
EXCEL_PATH   = "/Users/xiren/Downloads/waves/Wave_1_1781376214.xlsx"

HEADERS = {
    "apikey": SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "resolution=merge-duplicates,return=representation",
}

def sb_post(table: str, rows: list) -> list:
    url = f"{SUPABASE_URL}/rest/v1/{table}"
    data = json.dumps(rows).encode()
    req = urllib.request.Request(url, data=data, headers=HEADERS, method="POST")
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())

def parse_wave1(path: str):
    wb = openpyxl.load_workbook(path)
    ws = wb.active

    items = []
    current_item = None
    current_group = "General"

    for row in ws.iter_rows(values_only=True):
        r = list(row)

        # Group header
        if r[0] and r[2] == "Try it free →":
            current_group = r[0]
            current_item = None
            continue

        # Parent item row: col A has name, col C has Creatives Status
        if r[0] and r[0] not in ("Wave 1", "Name", "Subitems") and r[2] and r[2] != "Try it free →":
            current_item = {
                "name": r[0],
                "group_name": current_group,
                "creatives_status": r[2] or None,
                "landing_page_status": r[3] or None,
                "drive_link": r[4] or None,
                "found_by": r[5] or None,
                "subitems": [],
            }
            items.append(current_item)
            continue

        # Subitem row: col A is None, col B has name, col C has AD Status
        if r[0] is None and r[1] and r[2] and r[0] != "Subitems":
            if r[1] == "Name":  # column header row
                continue
            if current_item is not None:
                platforms = ["Meta", "TikTok", "YouTube", "Pinterest", "Google Shopping", "Google Search"]
                sub = {
                    "name": r[1],
                    "ad_status": r[2] or None,
                    "website_status": r[3] or None,
                    "concluded": bool(r[4]),
                    "listed_for_proofread": bool(r[5]),
                    "product_name": r[6] or None,
                    "shopify_pdp_link": r[7] or None,
                    "page_link": r[8] or None,
                    "drive_link": r[9] or None,
                    "meta": bool(r[10]),
                    "tiktok": bool(r[11]),
                    "youtube": bool(r[12]),
                    "pinterest": bool(r[13]),
                    "google_shopping": bool(r[14]),
                    "google_search": bool(r[15]),
                }
                current_item["subitems"].append(sub)

    return items


def main():
    print("Parsing Wave 1 Excel…")
    items = parse_wave1(EXCEL_PATH)
    print(f"  Found {len(items)} products, {sum(len(i['subitems']) for i in items)} subitems")

    # Upsert wave
    waves = sb_post("monday_waves", [{"wave_number": 1, "name": "Wave 1"}])
    wave_id = waves[0]["id"]
    print(f"  Wave 1 id: {wave_id}")

    for item in items:
        subs = item.pop("subitems")
        item["wave_id"] = wave_id

        inserted = sb_post("monday_items", [item])
        item_id = inserted[0]["id"]

        for sub in subs:
            sub["item_id"] = item_id

        if subs:
            sb_post("monday_subitems", subs)

    print("Done.")

if __name__ == "__main__":
    main()
