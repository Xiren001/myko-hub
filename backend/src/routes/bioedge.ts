import { Router, Request, Response } from 'express'
import { supabase } from '../supabase'
import { authenticate, requireAdmin, AuthRequest } from '../middleware/auth'

const router = Router()

const MONDAY_TOKEN = process.env.MONDAY_API_TOKEN ?? ''
const WEBHOOK_URL = 'https://backend-production-1ba8.up.railway.app/api/bioedge/webhook'

const BIOEDGE_BOARD = '5025150936'
const BIOEDGE_SUBITEM_BOARD = '5025150942'

// Parent item column ID → DB field
const ITEM_COL: Record<string, string> = {
  'status':            'ad_status',
  'color_mkw5hyq9':    'funnel_status',
  'color_mm22m3vh':    'batch',
}

// Subitem column ID → DB field
const SUB_COL: Record<string, string> = {
  'color_mkz2d2cd':    'ad_status',
  'color_mkz2cfpb':    'funnel_status',
  'text_mkz2cqgw':     'ads_drive_link',
  'text_mkz1679p':     'completed_funnel_url',
  'boolean_mm23bfq0':  'we_tracked',
  'text_mkz4w652':     'url_path',
  'text_mkz2s9hf':     'language',
  'text_mkz2wz1d':     'targeted_country',
  'text_mkzea7n8':     'bundle_names',
  'text_mkz1pz5w':     'currency',
  'text_mkzentk1':     'selling_prices',
  'text_mkz279qv':     'catalog',
  'text_mkzpddjw':     'buy_now_permalink',
  'text_mm22px9k':     'fb_page',
  'dropdown_mm4ftkp6': 'ad_account',
}

const BOOL_FIELDS = new Set(['we_tracked'])

// Monday's free-text Language column → short code used across proof_products/bioedge_proof_products
const LANG_MAP: Record<string, string> = {
  'english':                  'EN',
  'german':                   'DE',
  'spanish':                  'ES',
  'french':                   'FR',
  'portugese (brazilian)':    'BR',
}

// Returns null both when no language is set and when it's set but unmapped —
// callers must check the raw value separately if they need to distinguish those.
function resolveLang(raw: string | null): string | null {
  if (!raw) return null
  const key = raw.trim().toLowerCase()
  if (LANG_MAP[key]) return LANG_MAP[key]
  console.warn(`[bioedge] unmapped language "${raw}" — leaving language blank for manual assignment, add it to LANG_MAP in bioedge.ts`)
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

// When a subitem's Ad Status or Funnel Status enters "Proofread", auto-create a
// bioedge_proof_products entry so it appears on the BioEdge proofreading page.
// No-op if this subitem already has one, or if the language is English. Keyed by
// subitem_id rather than product_name so distinct subitems sharing a product name
// each still get their own row.
async function upsertBioedgeProofProduct(mondaySubitemId: string): Promise<void> {
  const { data: sub } = await supabase
    .from('bioedge_subitems')
    .select('id, item_id, language, completed_funnel_url, ads_drive_link, monday_url')
    .eq('monday_subitem_id', mondaySubitemId)
    .maybeSingle()
  if (!sub) return

  const rawLang = sub.language as string | null
  if (!rawLang) return
  const lang = resolveLang(rawLang)
  if (lang === 'EN') return

  const { data: item } = await supabase
    .from('bioedge_items')
    .select('name')
    .eq('id', sub.item_id)
    .maybeSingle()
  const productName = (item?.name ?? null) as string | null
  if (!productName) return

  const { data: existing } = await supabase
    .from('bioedge_proof_products')
    .select('id')
    .eq('subitem_id', sub.id)
    .maybeSingle()
  if (existing) return

  await supabase.from('bioedge_proof_products').insert({
    subitem_id:   sub.id,
    product_name: productName,
    language:     lang,
    pdp_url:      (sub.completed_funnel_url ?? null) as string | null,
    drive_folder: (sub.ads_drive_link ?? null) as string | null,
    monday_url:   (sub.monday_url ?? null) as string | null,
    done:         false,
  })
}

async function fetchAndUpsertItem(itemId: string): Promise<void> {
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

  const itemCols: Record<string, string | null> = {}
  for (const cv of item.column_values ?? []) {
    const f = ITEM_COL[cv.id]; if (f) itemCols[f] = cv.text || null
  }

  const { data: ins } = await supabase.from('bioedge_items').upsert({
    monday_item_id: item.id, name: item.name,
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
    await supabase.from('bioedge_subitems').upsert({
      item_id: ins.id, monday_subitem_id: sub.id, name: sub.name, ...subCols,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'monday_subitem_id' })
  }
}

// ── Public webhook (no auth — Monday.com calls this) ──────────────────────
router.post('/webhook', async (req: Request, res: Response) => {
  const body = req.body as any

  if (body.challenge) return res.json({ challenge: body.challenge })

  const event = body.event
  if (!event) return res.json({ ok: true })

  console.log('[bioedge webhook]', JSON.stringify(event))

  const boardId = String(event.boardId)
  const pulseId = String(event.pulseId ?? event.itemId ?? '')
  const isSub   = boardId === BIOEDGE_SUBITEM_BOARD

  try {
    if (event.type === 'change_subitem_column_value') {
      const field = SUB_COL[event.columnId]
      if (!field) return res.json({ ok: true })
      const value = parseWebhookValue(event.value, field)

      await supabase.from('bioedge_subitems')
        .update({ [field]: value, updated_at: new Date().toISOString() })
        .eq('monday_subitem_id', pulseId)

      if ((field === 'ad_status' || field === 'funnel_status') && typeof value === 'string' && value.toLowerCase() === 'proofread') {
        await upsertBioedgeProofProduct(pulseId)
      }

    } else if (event.type === 'update_column_value') {
      const colMap = isSub ? SUB_COL : ITEM_COL
      const field  = colMap[event.columnId]
      if (!field) return res.json({ ok: true })

      const value = parseWebhookValue(event.value, field)
      const table = isSub ? 'bioedge_subitems' : 'bioedge_items'
      const idCol = isSub ? 'monday_subitem_id' : 'monday_item_id'

      await supabase.from(table)
        .update({ [field]: value, updated_at: new Date().toISOString() })
        .eq(idCol, pulseId)

      if (isSub && (field === 'ad_status' || field === 'funnel_status') && typeof value === 'string' && value.toLowerCase() === 'proofread') {
        await upsertBioedgeProofProduct(pulseId)
      }

    } else if (event.type === 'update_name' || event.type === 'change_name') {
      const name = typeof event.value === 'string' ? event.value : (event.value as any)?.name
      if (name) {
        const table = isSub ? 'bioedge_subitems' : 'bioedge_items'
        const idCol = isSub ? 'monday_subitem_id' : 'monday_item_id'
        await supabase.from(table)
          .update({ name, updated_at: new Date().toISOString() })
          .eq(idCol, pulseId)
      }

    } else if (event.type === 'change_subitem_name') {
      const name = typeof event.value === 'string' ? event.value : (event.value as any)?.name
      if (name) {
        await supabase.from('bioedge_subitems')
          .update({ name, updated_at: new Date().toISOString() })
          .eq('monday_subitem_id', pulseId)
      }

    } else if (event.type === 'create_subitem') {
      const data = await mondayGql(`{ items(ids: [${pulseId}]) { id name url column_values { id text } parent_item { id } } }`)
      const sub = data?.data?.items?.[0]
      if (sub?.parent_item?.id) {
        const { data: parentItem } = await supabase.from('bioedge_items')
          .select('id').eq('monday_item_id', String(sub.parent_item.id)).single()
        if (parentItem) {
          const subCols: Record<string, unknown> = { monday_url: sub.url ?? null }
          for (const cv of sub.column_values ?? []) {
            const f = SUB_COL[cv.id]
            if (f) subCols[f] = BOOL_FIELDS.has(f) ? (cv.text === 'v' || cv.text === 'true') : (cv.text || null)
          }
          await supabase.from('bioedge_subitems').upsert({
            item_id: parentItem.id, monday_subitem_id: sub.id, name: sub.name, ...subCols,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'monday_subitem_id' })
        }
      }

    } else if ((event.type === 'create_pulse' || event.type === 'create_item') && isSub && event.parentItemId) {
      const parentItemId = String(event.parentItemId)
      const { data: parentItem } = await supabase.from('bioedge_items')
        .select('id').eq('monday_item_id', parentItemId).single()
      if (parentItem) {
        const data = await mondayGql(`{ items(ids: [${pulseId}]) { id name url column_values { id text } } }`)
        const sub = data?.data?.items?.[0]
        if (sub) {
          const subCols: Record<string, unknown> = { monday_url: sub.url ?? null }
          for (const cv of sub.column_values ?? []) {
            const f = SUB_COL[cv.id]
            if (f) subCols[f] = BOOL_FIELDS.has(f) ? (cv.text === 'v' || cv.text === 'true') : (cv.text || null)
          }
          await supabase.from('bioedge_subitems').upsert({
            item_id: parentItem.id, monday_subitem_id: sub.id, name: sub.name, ...subCols,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'monday_subitem_id' })
        }
      }

    } else if ((event.type === 'create_pulse' || event.type === 'create_item') && !isSub && boardId === BIOEDGE_BOARD) {
      await fetchAndUpsertItem(pulseId)

    } else if (event.type === 'item_restored' && boardId === BIOEDGE_BOARD) {
      await fetchAndUpsertItem(pulseId)

    } else if (event.type === 'delete_pulse' || event.type === 'item_deleted' || event.type === 'item_archived' || event.type === 'subitem_deleted' || event.type === 'subitem_archived') {
      if (isSub) {
        await supabase.from('bioedge_subitems').delete().eq('monday_subitem_id', pulseId)
      } else {
        await supabase.from('bioedge_items').delete().eq('monday_item_id', pulseId)
      }
    }
  } catch (err) {
    console.error('BioEdge webhook error:', err)
  }

  return res.json({ ok: true })
})

// ── GET /api/bioedge/items ────────────────────────────────────────────────
router.get('/items', authenticate, async (_req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('bioedge_items')
    .select('*, bioedge_subitems(*)')
    .order('name')
    .order('name', { foreignTable: 'bioedge_subitems', ascending: true })

  if (error) return res.status(500).json({ error: error.message })
  return res.json(data ?? [])
})

// ── POST /api/bioedge/sync ────────────────────────────────────────────────
// Full resync of the BioEdge board + subitems. Authenticated (any role).
router.post('/sync', authenticate, async (_req: AuthRequest, res: Response) => {
  if (!MONDAY_TOKEN) return res.status(500).json({ error: 'MONDAY_API_TOKEN not set' })

  let cursor: string | null = null
  let count = 0
  const seenItemIds: string[] = []
  const seenSubitemIds: string[] = []

  try {
    do {
      const cursorArg = cursor ? `, cursor: "${cursor}"` : ''
      const resp = await mondayGql(`{
        boards(ids: [${BIOEDGE_BOARD}]) {
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

        const { data: ins } = await supabase.from('bioedge_items').upsert({
          monday_item_id: item.id, name: item.name,
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
          await supabase.from('bioedge_subitems').upsert({
            item_id: ins.id, monday_subitem_id: sub.id, name: sub.name, ...subCols,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'monday_subitem_id' })
        }
        count++
      }
    } while (cursor)

    // Delete items/subitems that no longer exist in Monday
    const { data: dbItems } = await supabase.from('bioedge_items').select('id, monday_item_id')
    const orphanItems = (dbItems ?? []).filter(r => !seenItemIds.includes(r.monday_item_id))
    for (const orphan of orphanItems) {
      await supabase.from('bioedge_subitems').delete().eq('item_id', orphan.id)
      await supabase.from('bioedge_items').delete().eq('id', orphan.id)
    }

    if (seenSubitemIds.length > 0) {
      const { data: dbSubs } = await supabase
        .from('bioedge_subitems').select('id, monday_subitem_id')
        .in('item_id', (dbItems ?? []).filter(r => seenItemIds.includes(r.monday_item_id)).map(r => r.id))
      const orphanSubs = (dbSubs ?? []).filter(r => !seenSubitemIds.includes(r.monday_subitem_id))
      for (const orphan of orphanSubs) {
        await supabase.from('bioedge_subitems').delete().eq('id', orphan.id)
      }
    }

    return res.json({ ok: true, count, deleted: orphanItems.length })
  } catch (err: any) {
    return res.status(500).json({ error: err.message })
  }
})

// ── POST /api/bioedge/register-hooks ──────────────────────────────────────
// Registers all relevant webhooks on the parent BioEdge board. Admin only.
// Monday.com does not allow creating webhooks directly on a subitems board —
// subitem-level events (including column changes, via change_subitem_column_value)
// are delivered to webhooks registered on the PARENT board instead.
// Idempotent: skips any event already registered so this is safe to re-run.
router.post('/register-hooks', authenticate, requireAdmin, async (_req: AuthRequest, res: Response) => {
  if (!MONDAY_TOKEN) return res.status(500).json({ error: 'MONDAY_API_TOKEN not set' })

  const events = [
    'change_column_value', 'change_subitem_column_value',
    'create_item', 'item_deleted', 'create_subitem',
    'change_name', 'change_subitem_name', 'subitem_deleted', 'item_restored',
  ]

  const existingResp = await mondayGql(`{ webhooks(board_id: ${BIOEDGE_BOARD}) { id event } }`)
  const existingEvents = new Set((existingResp?.data?.webhooks ?? []).map((w: any) => w.event))

  const results: Record<string, unknown> = {}
  for (const event of events) {
    if (existingEvents.has(event)) {
      results[event] = 'already registered'
      continue
    }
    const resp = await mondayGql(`
      mutation { create_webhook(board_id: ${BIOEDGE_BOARD}, url: "${WEBHOOK_URL}", event: ${event}) { id board_id } }
    `)
    results[event] = resp?.data?.create_webhook ?? resp?.errors
  }

  return res.json({ ok: true, board: BIOEDGE_BOARD, results })
})

export default router
