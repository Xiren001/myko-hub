-- Run in Supabase SQL Editor

alter table public.monday_subitems
  add column if not exists last_snapshot_ad_status text,
  add column if not exists last_snapshot_website_status text;
