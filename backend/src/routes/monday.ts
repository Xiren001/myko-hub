import express, { Router, Request, Response } from 'express'
import { supabase } from '../supabase'
import { authenticate, requireAdmin, AuthRequest } from '../middleware/auth'
import { enqueueNotification } from '../jobs/notificationScheduler'
import { computeWavesReport, normalizeTeamQueue } from '../utils/computeWavesReport'
import { generateWaveReportPdf } from '../utils/generateWaveReportPdf'
import { runWaveReportSnapshot, getCronSchedule } from '../jobs/waveReportCron'
import { runWaveReportMonthlySnapshot, getMonthlyCronSchedule } from '../jobs/waveReportMonthlyCron'
import { weekStartISO, recentWeekStarts } from '../utils/week'

const router = Router()

const MONDAY_TOKEN = process.env.MONDAY_API_TOKEN ?? ''
const WEBHOOK_URL = 'https://backend-production-1ba8.up.railway.app/api/monday/webhook'

const COUNTRY_TO_LANG: Record<string, string> = {
  'France': 'FR', 'Netherlands': 'NL', 'Italy': 'IT',
  'Finland': 'FI', 'Sweden': 'SE', 'Norway': 'NO',
  'Israel': 'IL', 'Brazil': 'BR', 'Japan': 'JP',
  'Denmark': 'DK', 'Czech Republic': 'CZ', 'Czechia': 'CZ',
  'Poland': 'PL', 'Turkey': 'TR', 'Türkiye': 'TR',
  'Lithuania': 'LT', 'Estonia': 'EE',
  'Slovakia': 'SK', 'Slovenia': 'SI', 'Romania': 'RO',
}

function parseCSVLine(line: string): string[] {
  const result: string[] = []
  let cur = ''
  let inQ = false
  for (const ch of line) {
    if (ch === '"') { inQ = !inQ }
    else if (ch === ',' && !inQ) { result.push(cur.trim()); cur = '' }
    else { cur += ch }
  }
  result.push(cur.trim())
  return result
}

// Parent board ID → wave number (0 = Stopped)
const PARENT_BOARD_MAP: Record<string, number> = {
  '5025397250': 1,
  '5029159813': 2,
  '5029160081': 3,
  '5029160187': 4,
  '5029160246': 5,
  '5029160273': 6,
  '5029160365': 7,
  '5029161574': 0,
}

// Subitem board ID → parent board ID
const SUBITEM_BOARD_MAP: Record<string, string> = {
  '5025397251': '5025397250',  // Wave 1
  '5029159814': '5029159813',
  '5029160083': '5029160081',
  '5029160188': '5029160187',
  '5029160247': '5029160246',
  '5029160274': '5029160273',
  '5029160368': '5029160365',
  '5029161575': '5029161574',
}

// Parent item column ID → DB field
const ITEM_COL: Record<string, string> = {
  'color_mkxw4s3y': 'creatives_status',
  'status':          'landing_page_status',
  'text_mkz2ha3m':  'drive_link',
  'text_mm281q7c':  'found_by',
}

// Subitem column ID → DB field
const SUB_COL: Record<string, string> = {
  'status':            'ad_status',
  'color_mky9244k':   'website_status',
  'boolean_mm44s1cb': 'concluded',
  'boolean_mm422ss1': 'listed_for_proofread',
  'text_mm42dhrv':    'product_name',
  'text_mm424p4q':    'shopify_pdp_link',
  'text_mkyb3bns':    'page_link',
  'text_mkyhbdbw':    'drive_link',
  'boolean_mm42f261': 'meta',
  'boolean_mm42w62':  'tiktok',
  'boolean_mm42mq1n': 'youtube',
  'boolean_mm42a1f1': 'pinterest',
  'boolean_mm426hge': 'google_shopping',
  'boolean_mm42rt51': 'google_search',
}

const BOOL_FIELDS = new Set(['concluded', 'listed_for_proofread', 'meta', 'tiktok', 'youtube', 'pinterest', 'google_shopping', 'google_search'])

// "People" column IDs on parent item boards, one per wave (Wave 7 / Stopped have none).
// Column IDs are unique across boards, so a flat list is enough — no need to key by board.
const PEOPLE_COL_IDS = [
  'multiple_person_mm5efmkj', // Wave 1
  'multiple_person_mm5nfge2', // Wave 2
  'multiple_person_mm5n31jq', // Wave 3
  'multiple_person_mm5pf2qx', // Wave 4
  'multiple_person_mm5gf5sd', // Wave 5
  'multiple_person_mm5h1tf3', // Wave 6
]

function findPeopleText(columnValues?: { id: string; text: string | null }[]): string | null {
  return columnValues?.find(cv => PEOPLE_COL_IDS.includes(cv.id) && cv.text)?.text ?? null
}

// Extracts the builder's name from a Website Status label like "Building - Dan"
function parseBuilderName(status: string): string | null {
  const m = status.match(/^building\s*-\s*(.+)$/i)
  return m ? m[1].trim() : null
}

// Maps a landing_page_status label to the phase timestamp column it should stamp.
// Order matters: check "ready to launch" before bare "ready".
function lpPhaseField(status: string): string | null {
  const s = status.toLowerCase().trim()
  if (s.includes('building'))        return 'lp_building_at'
  if (s === 'ready to launch')       return 'lp_ready_to_launch_at'
  if (s === 'ready')                 return 'lp_ready_at'
  if (s.includes('proofread'))       return 'lp_proofread_at'
  if (s === 'launched')              return 'lp_launched_at'
  return null
}

function parseWebhookValue(raw: unknown, field: string): unknown {
  if (raw === null || raw === undefined) return null
  let val: unknown = raw
  if (typeof raw === 'string' && (raw.startsWith('{') || raw.startsWith('"'))) {
    try { val = JSON.parse(raw) } catch { /* keep as-is */ }
  }
  if (BOOL_FIELDS.has(field)) {
    return (val as any)?.checked === 'true' || (val as any)?.checked === true
  }
  if (field.endsWith('_status')) {
    return (val as any)?.label?.text ?? null
  }
  return (val as any)?.value ?? (val as any)?.text ?? (typeof val === 'string' ? val : null)
}

async function mondayGql(query: string): Promise<any> {
  const res = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: { Authorization: MONDAY_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  return res.json()
}

// Logs one team-performance event. De-duped per (track, subitem, week, person) by the
// table's unique constraint — a duplicate insert (webhook retry, same-week re-trigger) is a no-op.
async function logTeamPerformanceEvent(
  track: 'ads' | 'web_dev',
  personName: string,
  mondaySubitemId: string,
  mondayItemId: string | null,
  occurredAt: Date,
): Promise<void> {
  const { error } = await supabase.from('team_performance_events').insert({
    track,
    person_name: personName,
    monday_subitem_id: mondaySubitemId,
    monday_item_id: mondayItemId,
    week_start: weekStartISO(occurredAt),
    occurred_at: occurredAt.toISOString(),
  })
  if (error && error.code !== '23505') console.error('logTeamPerformanceEvent error:', error)
}

// A new subitem = a new ad variant "made" — credit whoever is currently assigned
// via the parent item's People column (empty at creation time → nobody credited).
async function logAdsPerformanceEvents(mondayItemId: string, mondaySubitemId: string, peopleText: string | null): Promise<void> {
  if (!peopleText) return
  const names = peopleText.split(',').map(n => n.trim()).filter(Boolean)
  const now = new Date()
  for (const name of names) {
    await logTeamPerformanceEvent('ads', name, mondaySubitemId, mondayItemId, now)
  }
}

// One-time seed: scans Monday's *current* state (existing People assignments and existing
// "Building - <name>" statuses) and logs everything into THIS week, so the sheet isn't empty
// on day one. Does not attempt to reconstruct which week things actually happened in.
async function runTeamPerformanceBackfill(): Promise<{ ads: number; webDev: number }> {
  const now = new Date()
  let ads = 0

  const adsBoardIds = Object.entries(PARENT_BOARD_MAP)
    .filter(([, wave]) => wave >= 1 && wave <= 6)
    .map(([boardId]) => boardId)

  for (const boardId of adsBoardIds) {
    let cursor: string | null = null
    do {
      const cursorArg = cursor ? `, cursor: "${cursor}"` : ''
      const resp = await mondayGql(`{
        boards(ids: [${boardId}]) {
          items_page(limit: 50${cursorArg}) {
            cursor
            items { id column_values { id text } subitems { id } }
          }
        }
      }`)
      const page = resp?.data?.boards?.[0]?.items_page
      for (const item of page?.items ?? []) {
        const peopleText = findPeopleText(item.column_values)
        if (!peopleText) continue
        const names = peopleText.split(',').map((n: string) => n.trim()).filter(Boolean)
        for (const sub of item.subitems ?? []) {
          for (const name of names) {
            await logTeamPerformanceEvent('ads', name, String(sub.id), String(item.id), now)
            ads++
          }
        }
      }
      cursor = page?.cursor ?? null
    } while (cursor)
  }

  // Website Status is already mirrored locally — no need to re-hit Monday's API for this half.
  const { data: building } = await supabase
    .from('monday_subitems')
    .select('monday_subitem_id, website_status')
    .ilike('website_status', 'building - %')

  let webDev = 0
  for (const row of building ?? []) {
    const builder = parseBuilderName(row.website_status as string)
    if (builder) {
      await logTeamPerformanceEvent('web_dev', builder, row.monday_subitem_id as string, null, now)
      webDev++
    }
  }

  return { ads, webDev }
}

// When a subitem enters "Proofread" status, auto-create a proof_products entry
// so it appears in the Proofreading page. No-op if this subitem already has one —
// keyed by subitem ID, not product_name, so distinct subitems sharing a product
// name each still get their own row.
async function upsertProofProductFromSubitem(mondaySubitemId: string): Promise<void> {
  const { data: sub } = await supabase
    .from('monday_subitems')
    .select('product_name, name, page_link, drive_link, monday_url')
    .eq('monday_subitem_id', mondaySubitemId)
    .maybeSingle()
  if (!sub) return

  // skip English, EN, and ZA variants
  const variant = (sub.name as string | null)?.trim().toLowerCase() ?? ''
  if (!variant) return
  if (variant === 'english' || variant === 'en' || variant === 'za') return

  const productName = (sub.product_name ?? null) as string | null
  if (!productName) return

  const { data: existing } = await supabase
    .from('proof_products')
    .select('id')
    .eq('monday_subitem_id', mondaySubitemId)
    .maybeSingle()
  if (existing) return

  await supabase.from('proof_products').insert({
    monday_subitem_id: mondaySubitemId,
    product_name: productName,
    language:     null,
    pdp_url:      (sub.page_link ?? null) as string | null,
    drive_folder: (sub.drive_link ?? null) as string | null,
    monday_url:   (sub.monday_url ?? null) as string | null,
    done:         false,
    month_year:   new Date().toISOString().slice(0, 7),
  })
}

// ── Public webhook (no auth — Monday.com calls this) ──────────────────────
router.post('/webhook', async (req: Request, res: Response) => {
  const body = req.body as any

  // Challenge handshake when registering the webhook
  if (body.challenge) return res.json({ challenge: body.challenge })

  const event = body.event
  if (!event) return res.json({ ok: true })

  console.log('[monday webhook]', JSON.stringify(event))

  const boardId  = String(event.boardId)
  const pulseId  = String(event.pulseId ?? event.itemId ?? '')
  const isSub    = boardId in SUBITEM_BOARD_MAP

  try {
    // change_subitem_column_value fires from the parent board when a subitem column changes
    if (event.type === 'change_subitem_column_value') {
      const field = SUB_COL[event.columnId]
      if (!field) return res.json({ ok: true })
      const value = parseWebhookValue(event.value, field)
      const subPayload: Record<string, unknown> = { [field]: value, updated_at: new Date().toISOString() }
      if (field === 'ad_status' || field === 'website_status') {
        subPayload[`${field}_changed_at`] = new Date().toISOString()
      }

      await supabase.from('monday_subitems')
        .update(subPayload)
        .eq('monday_subitem_id', pulseId)

      // Stamp phase timestamp only if not already set (preserves original date)
      if (field === 'website_status' && typeof value === 'string' && value) {
        const tsField = lpPhaseField(value)
        if (tsField) {
          await supabase.from('monday_subitems')
            .update({ [tsField]: new Date().toISOString() })
            .eq('monday_subitem_id', pulseId)
            .is(tsField, null)
        }
        const builder = parseBuilderName(value)
        if (builder) await logTeamPerformanceEvent('web_dev', builder, pulseId, null, new Date())
      }

      if (field === 'website_status' && typeof value === 'string' && value.toLowerCase() === 'waiting for proofread') {
        await upsertProofProductFromSubitem(pulseId)
      }

      // Stamp when an ad subitem is first concluded (preserves original date)
      if (field === 'concluded' && value === true) {
        await supabase.from('monday_subitems')
          .update({ concluded_at: new Date().toISOString() })
          .eq('monday_subitem_id', pulseId)
          .is('concluded_at', null)
      }

    } else if (event.type === 'update_column_value') {
      const colMap = isSub ? SUB_COL : ITEM_COL
      const field  = colMap[event.columnId]
      if (!field) return res.json({ ok: true })

      const value = parseWebhookValue(event.value, field)
      const table = isSub ? 'monday_subitems' : 'monday_items'
      const idCol = isSub ? 'monday_subitem_id' : 'monday_item_id'

      const updatePayload: Record<string, unknown> = { [field]: value, updated_at: new Date().toISOString() }
      if (isSub && (field === 'ad_status' || field === 'website_status')) {
        updatePayload[`${field}_changed_at`] = new Date().toISOString()
      }

      await supabase.from(table)
        .update(updatePayload)
        .eq(idCol, pulseId)

      // Stamp phase timestamp only if not already set (preserves original date)
      if (typeof value === 'string' && value) {
        const isTracked = (!isSub && field === 'landing_page_status') || (isSub && field === 'website_status')
        if (isTracked) {
          const tsField = lpPhaseField(value)
          if (tsField) {
            await supabase.from(table)
              .update({ [tsField]: new Date().toISOString() })
              .eq(idCol, pulseId)
              .is(tsField, null)
          }
        }
      }

      if (isSub && field === 'website_status' && typeof value === 'string') {
        const builder = parseBuilderName(value)
        if (builder) await logTeamPerformanceEvent('web_dev', builder, pulseId, null, new Date())
      }

      if (isSub && field === 'website_status' && typeof value === 'string' && value.toLowerCase() === 'waiting for proofread') {
        await upsertProofProductFromSubitem(pulseId)
      }

      // Stamp when an ad subitem is first concluded (preserves original date)
      if (isSub && field === 'concluded' && value === true) {
        await supabase.from('monday_subitems')
          .update({ concluded_at: new Date().toISOString() })
          .eq('monday_subitem_id', pulseId)
          .is('concluded_at', null)
      }

    } else if (event.type === 'update_name' || event.type === 'change_name') {
      const name = typeof event.value === 'string' ? event.value : (event.value as any)?.name
      if (name) {
        const table = isSub ? 'monday_subitems' : 'monday_items'
        const idCol = isSub ? 'monday_subitem_id' : 'monday_item_id'
        await supabase.from(table)
          .update({ name, updated_at: new Date().toISOString() })
          .eq(idCol, pulseId)
      }

    } else if (event.type === 'change_subitem_name') {
      const name = typeof event.value === 'string' ? event.value : (event.value as any)?.name
      if (name) {
        await supabase.from('monday_subitems')
          .update({ name, updated_at: new Date().toISOString() })
          .eq('monday_subitem_id', pulseId)
      }

    } else if (event.type === 'create_subitem') {
      const data = await mondayGql(`{ items(ids: [${pulseId}]) { id name url column_values { id text } parent_item { id column_values { id text } } } }`)
      const sub = data?.data?.items?.[0]
      if (sub?.parent_item?.id) {
        const { data: parentItem } = await supabase.from('monday_items')
          .select('id').eq('monday_item_id', String(sub.parent_item.id)).single()
        if (parentItem) {
          const subCols: Record<string, unknown> = { monday_url: sub.url ?? null }
          for (const cv of sub.column_values ?? []) {
            const f = SUB_COL[cv.id]
            if (f) subCols[f] = BOOL_FIELDS.has(f) ? (cv.text === 'v' || cv.text === 'true') : (cv.text || null)
          }
          await supabase.from('monday_subitems').upsert({
            item_id: parentItem.id, monday_subitem_id: sub.id, name: sub.name, ...subCols,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'monday_subitem_id' })

          const peopleText = findPeopleText(sub.parent_item.column_values)
          await logAdsPerformanceEvents(String(sub.parent_item.id), String(sub.id), peopleText)
        }
      }

    } else if ((event.type === 'create_pulse' || event.type === 'create_item') && isSub && event.parentItemId) {
      // New subitem — fires on the subitems board; parentItemId is in the payload
      const parentItemId = String(event.parentItemId)
      const { data: parentItem } = await supabase.from('monday_items')
        .select('id').eq('monday_item_id', parentItemId).single()
      if (parentItem) {
        const data = await mondayGql(`{ items(ids: [${pulseId}, ${parentItemId}]) { id name url column_values { id text } } }`)
        const items = data?.data?.items ?? []
        const sub = items.find((i: any) => String(i.id) === pulseId)
        if (sub) {
          const subCols: Record<string, unknown> = { monday_url: sub.url ?? null }
          for (const cv of sub.column_values ?? []) {
            const f = SUB_COL[cv.id]
            if (f) subCols[f] = BOOL_FIELDS.has(f) ? (cv.text === 'v' || cv.text === 'true') : (cv.text || null)
          }
          await supabase.from('monday_subitems').upsert({
            item_id: parentItem.id, monday_subitem_id: sub.id, name: sub.name, ...subCols,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'monday_subitem_id' })

          const parentRaw = items.find((i: any) => String(i.id) === parentItemId)
          const peopleText = findPeopleText(parentRaw?.column_values)
          await logAdsPerformanceEvents(parentItemId, String(sub.id), peopleText)
        }
      }

    } else if ((event.type === 'create_pulse' || event.type === 'create_item') && !isSub && boardId in PARENT_BOARD_MAP) {
      await fetchAndUpsertItem(pulseId, boardId)

    } else if (event.type === 'item_restored' && boardId in PARENT_BOARD_MAP) {
      await fetchAndUpsertItem(pulseId, boardId)

    } else if (event.type === 'delete_pulse' || event.type === 'item_deleted' || event.type === 'item_archived' || event.type === 'subitem_deleted' || event.type === 'subitem_archived') {
      if (isSub) {
        await supabase.from('monday_subitems').delete().eq('monday_subitem_id', pulseId)
      } else {
        // Only delete if the item still belongs to this wave — prevents deleting an item
        // that was already re-assigned to another wave by move_pulse_into_board
        const { data: wave } = await supabase
          .from('monday_waves').select('id').eq('board_id', boardId).single()
        if (wave) {
          await supabase.from('monday_items').delete()
            .eq('monday_item_id', pulseId)
            .eq('wave_id', wave.id)
        }
      }

    } else if (event.type === 'move_pulse_into_group' && !isSub) {
      const groupName: string | null = event.destGroup?.title ?? null
      if (groupName) {
        await supabase.from('monday_items')
          .update({ group_name: groupName, updated_at: new Date().toISOString() })
          .eq('monday_item_id', pulseId)
      }

    } else if (event.type === 'move_pulse_into_board') {
      // boardId = the subscribed board (source), NOT the destination.
      // Query Monday.com to find where the item actually is now.
      const itemData = await mondayGql(`{ items(ids: [${pulseId}]) { board { id } group { title } } }`)
      const currentItem = itemData?.data?.items?.[0]
      if (currentItem) {
        const currentBoardId = String(currentItem.board?.id)
        const currentGroupName: string | null = currentItem.group?.title ?? null
        const { data: wave } = await supabase
          .from('monday_waves').select('id').eq('board_id', currentBoardId).single()
        if (wave) {
          const { data: updated } = await supabase.from('monday_items')
            .update({ wave_id: wave.id, group_name: currentGroupName, updated_at: new Date().toISOString() })
            .eq('monday_item_id', pulseId)
            .select('id')
          if (!updated?.length) {
            await fetchAndUpsertItem(pulseId, currentBoardId)
          }
        }
      }
    }
  } catch (err) {
    console.error('Monday webhook error:', err)
  }

  return res.json({ ok: true })
})

async function fetchAndUpsertItem(itemId: string, boardId: string): Promise<void> {
  const data = await mondayGql(`{
    items(ids: [${itemId}]) {
      id name
      group { title }
      column_values { id text }
      subitems { id name url column_values { id text } }
    }
  }`)

  const item = data?.data?.items?.[0]
  if (!item) return

  const { data: wave } = await supabase
    .from('monday_waves').select('id').eq('board_id', boardId).single()
  if (!wave) return

  const itemCols: Record<string, string | null> = {}
  for (const cv of item.column_values ?? []) {
    const f = ITEM_COL[cv.id]; if (f) itemCols[f] = cv.text || null
  }

  const { data: ins } = await supabase.from('monday_items').upsert({
    wave_id: wave.id, monday_item_id: item.id, name: item.name,
    group_name: item.group?.title ?? null, ...itemCols,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'monday_item_id' }).select('id').single()

  if (!ins) return

  for (const sub of item.subitems ?? []) {
    const subCols: Record<string, unknown> = { monday_url: sub.url ?? null }
    for (const cv of sub.column_values ?? []) {
      const f = SUB_COL[cv.id]
      if (f) subCols[f] = BOOL_FIELDS.has(f) ? (cv.text === 'v' || cv.text === 'true') : (cv.text || null)
    }
    await supabase.from('monday_subitems').upsert({
      item_id: ins.id, monday_subitem_id: sub.id, name: sub.name, ...subCols,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'monday_subitem_id' })
  }
}

// ── PATCH /api/monday/items/:itemId/timestamps ───────────────────────────
// Manually edit LP phase timestamps. Authenticated (any role).
const ALLOWED_TS_FIELDS = new Set([
  'lp_building_at', 'lp_ready_at', 'lp_proofread_at',
  'lp_ready_to_launch_at', 'lp_launched_at',
])

router.patch('/items/:itemId/timestamps', authenticate, async (req: AuthRequest, res: Response) => {
  const { itemId } = req.params
  const updates: Record<string, string | null> = {}
  for (const [key, val] of Object.entries(req.body)) {
    if (ALLOWED_TS_FIELDS.has(key)) updates[key] = (val as string | null) || null
  }
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid fields' })
  const { error } = await supabase.from('monday_items')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', itemId)
  if (error) return res.status(500).json({ error: error.message })
  return res.json({ ok: true })
})

// ── PATCH /api/monday/subitems/:subitemId/timestamps ─────────────────────
// Manually edit LP phase timestamps on a subitem. Authenticated (any role).
router.patch('/subitems/:subitemId/timestamps', authenticate, async (req: AuthRequest, res: Response) => {
  const { subitemId } = req.params
  const updates: Record<string, string | null> = {}
  for (const [key, val] of Object.entries(req.body)) {
    if (ALLOWED_TS_FIELDS.has(key)) updates[key] = (val as string | null) || null
  }
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid fields' })
  const { error } = await supabase.from('monday_subitems')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', subitemId)
  if (error) return res.status(500).json({ error: error.message })
  return res.json({ ok: true })
})

// ── POST /api/monday/sync/:boardId ────────────────────────────────────────
// Syncs a single wave board. Authenticated (any role).
router.post('/sync/:boardId', authenticate, async (req: AuthRequest, res: Response) => {
  if (!MONDAY_TOKEN) return res.status(500).json({ error: 'MONDAY_API_TOKEN not set' })

  const { boardId } = req.params

  const { data: wave, error: waveErr } = await supabase
    .from('monday_waves').select('id').eq('board_id', boardId).single()
  if (waveErr || !wave) return res.status(404).json({ error: 'Wave not found' })

  let cursor: string | null = null
  let count = 0
  const seenItemIds: string[] = []
  const seenSubitemIds: string[] = []

  try {
    do {
      const cursorArg = cursor ? `, cursor: "${cursor}"` : ''
      const resp = await mondayGql(`{
        boards(ids: [${boardId}]) {
          items_page(limit: 50${cursorArg}) {
            cursor
            items {
              id name
              group { title }
              column_values { id text }
              subitems { id name url column_values { id text } }
            }
          }
        }
      }`)

      const page = resp?.data?.boards?.[0]?.items_page
      if (!page) break
      cursor = page.cursor ?? null

      for (const item of page.items ?? []) {
        seenItemIds.push(item.id)
        const itemCols: Record<string, string | null> = {}
        for (const cv of item.column_values ?? []) {
          const f = ITEM_COL[cv.id]; if (f) itemCols[f] = cv.text || null
        }

        const { data: ins } = await supabase.from('monday_items').upsert({
          wave_id: wave.id, monday_item_id: item.id, name: item.name,
          group_name: item.group?.title ?? null, ...itemCols,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'monday_item_id' }).select('id').single()

        if (!ins) continue

        for (const sub of item.subitems ?? []) {
          seenSubitemIds.push(sub.id)
          const subCols: Record<string, unknown> = { monday_url: sub.url ?? null }
          for (const cv of sub.column_values ?? []) {
            const f = SUB_COL[cv.id]
            if (f) subCols[f] = BOOL_FIELDS.has(f) ? (cv.text === 'v' || cv.text === 'true') : (cv.text || null)
          }
          await supabase.from('monday_subitems').upsert({
            item_id: ins.id, monday_subitem_id: sub.id, name: sub.name, ...subCols,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'monday_subitem_id' })
        }
        count++
      }
    } while (cursor)

    // Delete items/subitems that no longer exist in Monday
    const { data: dbItems } = await supabase
      .from('monday_items').select('id, monday_item_id').eq('wave_id', wave.id)
    const orphanItems = (dbItems ?? []).filter(r => !seenItemIds.includes(r.monday_item_id))
    for (const orphan of orphanItems) {
      await supabase.from('monday_subitems').delete().eq('item_id', orphan.id)
      await supabase.from('monday_items').delete().eq('id', orphan.id)
    }

    if (seenSubitemIds.length > 0) {
      const { data: dbSubs } = await supabase
        .from('monday_subitems').select('id, monday_subitem_id')
        .in('item_id', (dbItems ?? []).filter(r => seenItemIds.includes(r.monday_item_id)).map(r => r.id))
      const orphanSubs = (dbSubs ?? []).filter(r => !seenSubitemIds.includes(r.monday_subitem_id))
      for (const orphan of orphanSubs) {
        await supabase.from('monday_subitems').delete().eq('id', orphan.id)
      }
    }

    return res.json({ ok: true, count, deleted: orphanItems.length })
  } catch (err: any) {
    return res.status(500).json({ error: err.message })
  }
})

// ── GET /api/monday/waves ─────────────────────────────────────────────────
router.get('/waves', authenticate, async (_req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('monday_waves')
    .select('*, monday_items(*, monday_subitems(*))')
    .order('wave_number')
    .order('name', { foreignTable: 'monday_items', ascending: true })
    .order('name', { foreignTable: 'monday_items.monday_subitems', ascending: true })

  if (error) return res.status(500).json({ error: error.message })
  return res.json(data)
})

// ── POST /api/monday/import ───────────────────────────────────────────────
// One-time seed from Monday.com API. Admin only.
router.post('/import', authenticate, requireAdmin, async (_req: AuthRequest, res: Response) => {
  if (!MONDAY_TOKEN) return res.status(500).json({ error: 'MONDAY_API_TOKEN not set' })

  const boards = [
    { waveNumber: 1, boardId: '5025397250', name: 'Wave 1' },
    { waveNumber: 2, boardId: '5029159813', name: 'Wave 2' },
    { waveNumber: 3, boardId: '5029160081', name: 'Wave 3' },
    { waveNumber: 4, boardId: '5029160187', name: 'Wave 4' },
    { waveNumber: 5, boardId: '5029160246', name: 'Wave 5' },
    { waveNumber: 6, boardId: '5029160273', name: 'Wave 6' },
    { waveNumber: 7, boardId: '5029160365', name: 'Wave 7' },
    { waveNumber: 0, boardId: '5029161574', name: 'Stopped' },
  ]

  const results: Record<string, string> = {}

  for (const board of boards) {
    try {
      const { data: wave, error: wErr } = await supabase
        .from('monday_waves')
        .upsert({ wave_number: board.waveNumber, board_id: board.boardId, name: board.name }, { onConflict: 'board_id' })
        .select('id').single()

      if (wErr || !wave) { results[board.name] = `wave error: ${wErr?.message}`; continue }

      let cursor: string | null = null
      let count = 0

      do {
        const cursorArg = cursor ? `, cursor: "${cursor}"` : ''
        const resp = await mondayGql(`{
          boards(ids: [${board.boardId}]) {
            items_page(limit: 50${cursorArg}) {
              cursor
              items {
                id name
                group { title }
                column_values { id text }
                subitems { id name url column_values { id text } }
              }
            }
          }
        }`)

        const page = resp?.data?.boards?.[0]?.items_page
        if (!page) break
        cursor = page.cursor ?? null

        for (const item of page.items ?? []) {
          const itemCols: Record<string, string | null> = {}
          for (const cv of item.column_values ?? []) {
            const f = ITEM_COL[cv.id]; if (f) itemCols[f] = cv.text || null
          }

          const { data: ins } = await supabase.from('monday_items').upsert({
            wave_id: wave.id, monday_item_id: item.id, name: item.name,
            group_name: item.group?.title ?? null, ...itemCols,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'monday_item_id' }).select('id').single()

          if (!ins) continue

          for (const sub of item.subitems ?? []) {
            const subCols: Record<string, unknown> = { monday_url: sub.url ?? null }
            for (const cv of sub.column_values ?? []) {
              const f = SUB_COL[cv.id]
              if (f) subCols[f] = BOOL_FIELDS.has(f) ? (cv.text === 'v' || cv.text === 'true') : (cv.text || null)
            }
            await supabase.from('monday_subitems').upsert({
              item_id: ins.id, monday_subitem_id: sub.id, name: sub.name, ...subCols,
              updated_at: new Date().toISOString(),
            }, { onConflict: 'monday_subitem_id' })
          }
          count++
        }
      } while (cursor)

      results[board.name] = `${count} items imported`
    } catch (err: any) {
      results[board.name] = `error: ${err.message}`
    }
  }

  return res.json({ ok: true, results })
})

// Registers change_column_value webhooks on all parent boards.
// Subitem boards are excluded — Monday.com rejects webhooks registered directly
// on them; subitem column changes are instead delivered as change_subitem_column_value
// events on the parent board's webhook (handled in POST /webhook below).
export async function registerMondayHooks(): Promise<Record<string, unknown>> {
  if (!MONDAY_TOKEN) throw new Error('MONDAY_API_TOKEN not set')

  const results: Record<string, unknown> = {}

  for (const boardId of Object.keys(PARENT_BOARD_MAP)) {
    const resp = await mondayGql(`
      mutation {
        create_webhook(board_id: ${boardId}, url: "${WEBHOOK_URL}", event: change_column_value) {
          id board_id
        }
      }
    `)
    results[boardId] = resp?.data?.create_webhook ?? resp?.errors
  }

  return results
}

// ── POST /api/monday/register-hooks ──────────────────────────────────────
// Registers change_column_value webhooks on all parent boards. Admin only.
router.post('/register-hooks', authenticate, requireAdmin, async (_req: AuthRequest, res: Response) => {
  if (!MONDAY_TOKEN) return res.status(500).json({ error: 'MONDAY_API_TOKEN not set' })

  const results = await registerMondayHooks()
  return res.json({ ok: true, results })
})

// ── POST /api/monday/register-group-move-hooks ───────────────────────────
// Registers item_moved_to_any_group webhooks on all parent boards. Admin only.
router.post('/register-group-move-hooks', authenticate, requireAdmin, async (_req: AuthRequest, res: Response) => {
  if (!MONDAY_TOKEN) return res.status(500).json({ error: 'MONDAY_API_TOKEN not set' })

  const results: Record<string, unknown> = {}

  for (const boardId of Object.keys(PARENT_BOARD_MAP)) {
    const resp = await mondayGql(`
      mutation {
        create_webhook(board_id: ${boardId}, url: "${WEBHOOK_URL}", event: item_moved_to_any_group) {
          id board_id
        }
      }
    `)
    results[boardId] = resp?.data?.create_webhook ?? resp?.errors
  }

  return res.json({ ok: true, results })
})

// ── POST /api/monday/register-item-move-hooks ────────────────────────────
// Registers create_item + item_deleted webhooks on all parent boards. Admin only.
router.post('/register-item-move-hooks', authenticate, requireAdmin, async (_req: AuthRequest, res: Response) => {
  if (!MONDAY_TOKEN) return res.status(500).json({ error: 'MONDAY_API_TOKEN not set' })

  const results: Record<string, unknown> = {}

  for (const boardId of Object.keys(PARENT_BOARD_MAP)) {
    const [created, deleted] = await Promise.all([
      mondayGql(`mutation { create_webhook(board_id: ${boardId}, url: "${WEBHOOK_URL}", event: create_item) { id board_id } }`),
      mondayGql(`mutation { create_webhook(board_id: ${boardId}, url: "${WEBHOOK_URL}", event: item_deleted) { id board_id } }`),
    ])
    results[boardId] = {
      create_item: created?.data?.create_webhook ?? created?.errors,
      item_deleted: deleted?.data?.create_webhook ?? deleted?.errors,
    }
  }

  return res.json({ ok: true, results })
})

// ── POST /api/monday/register-crud-hooks ─────────────────────────────────
// Registers create/edit/delete webhooks on all parent boards. Admin only.
router.post('/register-crud-hooks', authenticate, requireAdmin, async (_req: AuthRequest, res: Response) => {
  if (!MONDAY_TOKEN) return res.status(500).json({ error: 'MONDAY_API_TOKEN not set' })

  const events = ['create_subitem', 'change_name', 'change_subitem_name', 'subitem_deleted', 'item_restored']
  const results: Record<string, unknown> = {}

  for (const boardId of Object.keys(PARENT_BOARD_MAP)) {
    results[boardId] = {}
    for (const event of events) {
      const resp = await mondayGql(`
        mutation { create_webhook(board_id: ${boardId}, url: "${WEBHOOK_URL}", event: ${event}) { id board_id } }
      `)
      ;(results[boardId] as any)[event] = resp?.data?.create_webhook ?? resp?.errors
    }
  }

  return res.json({ ok: true, results })
})

// ── POST /api/monday/language-sales/upload ───────────────────────────────
router.post('/language-sales/upload', authenticate, express.text({ type: '*/*', limit: '5mb' }), async (req: AuthRequest, res: Response) => {
  const csvText = req.body as string
  const lines = csvText.split(/\r?\n/).filter(l => l.trim())
  // skip header row
  const langAgg: Record<string, { country: string; net_sales: number; cogs: number }> = {}
  for (const line of lines.slice(1)) {
    const cols = parseCSVLine(line)
    if (cols.length < 4) continue
    const country = cols[0]
    const net_sales = parseFloat(cols[2]) || 0
    const cogs = parseFloat(cols[3]) || 0
    const lang = COUNTRY_TO_LANG[country]
    if (!lang) continue
    if (!langAgg[lang]) langAgg[lang] = { country, net_sales: 0, cogs: 0 }
    langAgg[lang].net_sales += net_sales
    langAgg[lang].cogs += cogs
  }
  const rows = Object.entries(langAgg)
    .filter(([, d]) => d.net_sales > 0 || d.cogs > 0)
    .map(([lang_code, d]) => ({
      lang_code,
      country: d.country,
      net_sales: Math.round(d.net_sales * 100) / 100,
      cogs: Math.round(d.cogs * 100) / 100,
      updated_at: new Date().toISOString(),
    }))
  // replace all existing data with the new upload
  await supabase.from('language_sales').delete().neq('lang_code', '')
  const { error } = await supabase.from('language_sales').insert(rows)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ ok: true, uploaded: rows.length })
})

// ── POST /api/monday/product-sales/upload ────────────────────────────────
router.post('/product-sales/upload', authenticate, express.text({ type: '*/*', limit: '5mb' }), async (req: AuthRequest, res: Response) => {
  const csvText = req.body as string
  const lines = csvText.split(/\r?\n/).filter(l => l.trim())
  const rows: { product_title: string; net_sales: number; updated_at: string }[] = []
  const now = new Date().toISOString()
  for (const line of lines.slice(1)) {
    const cols = parseCSVLine(line)
    if (cols.length < 2) continue
    const product_title = cols[0]
    const net_sales = parseFloat(cols[1]) || 0
    if (!product_title) continue
    rows.push({ product_title, net_sales, updated_at: now })
  }
  await supabase.from('product_sales').delete().neq('product_title', '')
  const { error } = await supabase.from('product_sales').insert(rows)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ ok: true, uploaded: rows.length })
})

// ── GET /api/monday/team-performance ──────────────────────────────────────
// Rolling per-person weekly counts for the Team Performance sheet. Admin only.
router.get('/team-performance', authenticate, requireAdmin, async (req: AuthRequest, res: Response) => {
  const track = req.query.track === 'web_dev' ? 'web_dev' : 'ads'
  const weeksCount = Math.max(1, Math.min(52, parseInt(String(req.query.weeks ?? '10'), 10) || 10))
  const weeks = recentWeekStarts(weeksCount)

  const { data, error } = await supabase
    .from('team_performance_events')
    .select('person_name, week_start')
    .eq('track', track)
    .gte('week_start', weeks[0])
  if (error) return res.status(500).json({ error: error.message })

  const byPerson = new Map<string, Record<string, number>>()
  for (const row of data ?? []) {
    const counts = byPerson.get(row.person_name) ?? {}
    counts[row.week_start] = (counts[row.week_start] ?? 0) + 1
    byPerson.set(row.person_name, counts)
  }

  const people = Array.from(byPerson.entries())
    .map(([name, counts]) => ({
      name,
      counts,
      total: Object.values(counts).reduce((sum, n) => sum + n, 0),
    }))
    .sort((a, b) => b.total - a.total)

  return res.json({ weeks, people })
})

// ── GET /api/monday/team-performance/detail ───────────────────────────────
// Subitems credited to one person in one week, plus how many days each took
// to run its funnel (ads: created → concluded; web dev: building → launched).
router.get('/team-performance/detail', authenticate, requireAdmin, async (req: AuthRequest, res: Response) => {
  const track = req.query.track === 'web_dev' ? 'web_dev' : 'ads'
  const person = String(req.query.person ?? '')
  const week = String(req.query.week ?? '')
  if (!person || !week) return res.status(400).json({ error: 'person and week are required' })

  const { data: events, error } = await supabase
    .from('team_performance_events')
    .select('monday_subitem_id')
    .eq('track', track)
    .eq('person_name', person)
    .eq('week_start', week)
  if (error) return res.status(500).json({ error: error.message })

  const subitemIds = Array.from(new Set((events ?? []).map(e => e.monday_subitem_id as string)))
  if (!subitemIds.length) return res.json({ subitems: [], averageDays: null })

  const cols = track === 'web_dev'
    ? 'monday_subitem_id, product_name, name, lp_building_at, lp_launched_at'
    : 'monday_subitem_id, product_name, name, created_at, concluded, concluded_at'

  const { data: subs, error: subErr } = await supabase
    .from('monday_subitems')
    .select(cols)
    .in('monday_subitem_id', subitemIds)
  if (subErr) return res.status(500).json({ error: subErr.message })

  const DAY_MS = 1000 * 60 * 60 * 24
  const subitems = subitemIds.map(id => {
    const sub = (subs ?? []).find((s: any) => s.monday_subitem_id === id) as any
    const productName = sub?.product_name || sub?.name || id
    let days: number | null = null
    if (track === 'web_dev') {
      if (sub?.lp_building_at && sub?.lp_launched_at) {
        days = Math.round((new Date(sub.lp_launched_at).getTime() - new Date(sub.lp_building_at).getTime()) / DAY_MS)
      }
    } else if (sub?.concluded && sub?.concluded_at && sub?.created_at) {
      days = Math.round((new Date(sub.concluded_at).getTime() - new Date(sub.created_at).getTime()) / DAY_MS)
    }
    return { monday_subitem_id: id, product_name: productName, days }
  })

  const finished = subitems.filter(s => s.days !== null).map(s => s.days as number)
  const averageDays = finished.length
    ? Math.round((finished.reduce((sum, d) => sum + d, 0) / finished.length) * 10) / 10
    : null

  return res.json({ subitems, averageDays })
})

// ── POST /api/monday/team-performance/backfill ────────────────────────────
// One-time seed of the sheet from Monday's current state. Guarded by the
// team_performance_backfill singleton row — a second call is a no-op.
router.post('/team-performance/backfill', authenticate, requireAdmin, async (_req: AuthRequest, res: Response) => {
  const { error: guardErr } = await supabase.from('team_performance_backfill').insert({})
  if (guardErr) {
    if (guardErr.code === '23505') return res.json({ ok: true, alreadyRan: true })
    return res.status(500).json({ error: guardErr.message })
  }

  try {
    const result = await runTeamPerformanceBackfill()
    return res.json({ ok: true, alreadyRan: false, ...result })
  } catch (err) {
    console.error('team-performance backfill error:', err)
    return res.status(500).json({ error: 'Backfill failed' })
  }
})

// ── GET /api/monday/waves-weekly-report ──────────────────────────────────
router.get('/waves-weekly-report', authenticate, async (req: AuthRequest, res: Response) => {
  const { weekStart: weekStartParam } = req.query

  // If a specific week is requested, check for a saved snapshot first
  if (weekStartParam && typeof weekStartParam === 'string') {
    const { data: snap } = await supabase
      .from('wave_report_snapshots')
      .select('data, week_start, week_end')
      .eq('week_start', weekStartParam)
      .maybeSingle()

    if (snap) {
      return res.json({ ...normalizeTeamQueue(snap.data as any), isSnapshot: true })
    }
  }

  // Fall back to live computation
  const data = await computeWavesReport()
  return res.json({ ...data, isSnapshot: false })
})

// ── GET /api/monday/wave-report-snapshots ─────────────────────────────────
// List all available snapshot weeks (newest first)
router.get('/wave-report-snapshots', authenticate, async (_req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('wave_report_snapshots')
    .select('week_start, week_end, created_at')
    .order('week_start', { ascending: false })
  if (error) return res.status(500).json({ error: error.message })
  return res.json(data ?? [])
})

// ── POST /api/monday/wave-report-snapshot ─────────────────────────────────
// Manually trigger a snapshot for the current week (admin only)
router.post('/wave-report-snapshot', authenticate, requireAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    await runWaveReportSnapshot()
    return res.json({ ok: true })
  } catch (err: any) {
    return res.status(500).json({ error: err.message })
  }
})

// ── DELETE /api/monday/wave-report-snapshot/:weekStart ─────────────────────
router.delete('/wave-report-snapshot/:weekStart', authenticate, requireAdmin, async (req: AuthRequest, res: Response) => {
  const { weekStart } = req.params
  const { error } = await supabase
    .from('wave_report_snapshots')
    .delete()
    .eq('week_start', weekStart)
  if (error) return res.status(500).json({ error: error.message })
  return res.json({ ok: true })
})

// ── GET /api/monday/wave-report-snapshot/:weekStart/pdf ───────────────────
router.get('/wave-report-snapshot/:weekStart/pdf', authenticate, async (req: AuthRequest, res: Response) => {
  const { weekStart } = req.params

  let reportData: any
  let isSnapshot = false

  // Try snapshot first
  const { data: snap } = await supabase
    .from('wave_report_snapshots')
    .select('data')
    .eq('week_start', weekStart)
    .maybeSingle()

  if (snap) {
    reportData  = normalizeTeamQueue(snap.data as any)
    isSnapshot  = true
  } else {
    // Fall back to live data
    reportData = await computeWavesReport()
  }

  try {
    const pdfBuffer = await generateWaveReportPdf(reportData, isSnapshot)
    const filename  = `waves-report-${weekStart}.pdf`
    res.set({
      'Content-Type':        'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length':      String(pdfBuffer.length),
    })
    return res.send(pdfBuffer)
  } catch (err: any) {
    return res.status(500).json({ error: err.message })
  }
})

// ── GET /api/monday/wave-report-cron ──────────────────────────────────────
router.get('/wave-report-cron', authenticate, async (_req: AuthRequest, res: Response) => {
  const schedule = await getCronSchedule()
  return res.json(schedule)
})

// ── PUT /api/monday/wave-report-cron ──────────────────────────────────────
router.put('/wave-report-cron', authenticate, requireAdmin, async (req: AuthRequest, res: Response) => {
  const { day, hour, minute, timezone } = req.body
  if (
    typeof day !== 'number'      || day < 0      || day > 6      ||
    typeof hour !== 'number'     || hour < 0     || hour > 23    ||
    typeof minute !== 'number'   || minute < 0   || minute > 59  ||
    typeof timezone !== 'string' || !timezone.trim()
  ) {
    return res.status(400).json({ error: 'Invalid schedule fields' })
  }

  const value = JSON.stringify({ day, hour, minute, timezone: timezone.trim() })
  const { error } = await supabase
    .from('proof_notification_settings')
    .upsert({ key: 'wave_report_cron', value }, { onConflict: 'key' })

  if (error) return res.status(500).json({ error: error.message })
  return res.json({ ok: true, day, hour, minute, timezone })
})

// ── GET /api/monday/waves-monthly-report ──────────────────────────────────
router.get('/waves-monthly-report', authenticate, async (req: AuthRequest, res: Response) => {
  const { monthStart: monthStartParam } = req.query

  // If a specific month is requested, check for a saved snapshot first
  if (monthStartParam && typeof monthStartParam === 'string') {
    const { data: snap } = await supabase
      .from('wave_report_monthly_snapshots')
      .select('data, month_start, month_end')
      .eq('month_start', monthStartParam)
      .maybeSingle()

    if (snap) {
      return res.json({ ...normalizeTeamQueue(snap.data as any), isSnapshot: true })
    }
  }

  // Fall back to live computation
  const data = await computeWavesReport('month')
  return res.json({ ...data, isSnapshot: false })
})

// ── GET /api/monday/wave-report-monthly-snapshots ─────────────────────────
// List all available snapshot months (newest first)
router.get('/wave-report-monthly-snapshots', authenticate, async (_req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('wave_report_monthly_snapshots')
    .select('month_start, month_end, created_at')
    .order('month_start', { ascending: false })
  if (error) return res.status(500).json({ error: error.message })
  return res.json(data ?? [])
})

// ── POST /api/monday/wave-report-monthly-snapshot ─────────────────────────
// Manually trigger a snapshot for the current month (admin only)
router.post('/wave-report-monthly-snapshot', authenticate, requireAdmin, async (_req: AuthRequest, res: Response) => {
  try {
    await runWaveReportMonthlySnapshot()
    return res.json({ ok: true })
  } catch (err: any) {
    return res.status(500).json({ error: err.message })
  }
})

// ── DELETE /api/monday/wave-report-monthly-snapshot/:monthStart ────────────
router.delete('/wave-report-monthly-snapshot/:monthStart', authenticate, requireAdmin, async (req: AuthRequest, res: Response) => {
  const { monthStart } = req.params
  const { error } = await supabase
    .from('wave_report_monthly_snapshots')
    .delete()
    .eq('month_start', monthStart)
  if (error) return res.status(500).json({ error: error.message })
  return res.json({ ok: true })
})

// ── GET /api/monday/wave-report-monthly-snapshot/:monthStart/pdf ──────────
router.get('/wave-report-monthly-snapshot/:monthStart/pdf', authenticate, async (req: AuthRequest, res: Response) => {
  const { monthStart } = req.params

  let reportData: any
  let isSnapshot = false

  // Try snapshot first
  const { data: snap } = await supabase
    .from('wave_report_monthly_snapshots')
    .select('data')
    .eq('month_start', monthStart)
    .maybeSingle()

  if (snap) {
    reportData  = normalizeTeamQueue(snap.data as any)
    isSnapshot  = true
  } else {
    // Fall back to live data
    reportData = await computeWavesReport('month')
  }

  try {
    const pdfBuffer = await generateWaveReportPdf(reportData, isSnapshot, 'month')
    const filename  = `waves-report-${monthStart}.pdf`
    res.set({
      'Content-Type':        'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length':      String(pdfBuffer.length),
    })
    return res.send(pdfBuffer)
  } catch (err: any) {
    return res.status(500).json({ error: err.message })
  }
})

// ── GET /api/monday/wave-report-monthly-cron ──────────────────────────────
router.get('/wave-report-monthly-cron', authenticate, async (_req: AuthRequest, res: Response) => {
  const schedule = await getMonthlyCronSchedule()
  return res.json(schedule)
})

// ── PUT /api/monday/wave-report-monthly-cron ──────────────────────────────
router.put('/wave-report-monthly-cron', authenticate, requireAdmin, async (req: AuthRequest, res: Response) => {
  const { dayOfMonth, hour, minute, timezone } = req.body
  if (
    typeof dayOfMonth !== 'number'  || dayOfMonth < 1 || dayOfMonth > 28  ||
    typeof hour !== 'number'        || hour < 0       || hour > 23       ||
    typeof minute !== 'number'      || minute < 0     || minute > 59     ||
    typeof timezone !== 'string'    || !timezone.trim()
  ) {
    return res.status(400).json({ error: 'Invalid schedule fields' })
  }

  const value = JSON.stringify({ dayOfMonth, hour, minute, timezone: timezone.trim() })
  const { error } = await supabase
    .from('proof_notification_settings')
    .upsert({ key: 'wave_report_monthly_cron', value }, { onConflict: 'key' })

  if (error) return res.status(500).json({ error: error.message })
  return res.json({ ok: true, dayOfMonth, hour, minute, timezone })
})

export default router
