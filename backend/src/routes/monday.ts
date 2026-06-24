import { Router, Request, Response } from 'express'
import { supabase } from '../supabase'
import { authenticate, requireAdmin, AuthRequest } from '../middleware/auth'

const router = Router()

const MONDAY_TOKEN = process.env.MONDAY_API_TOKEN ?? ''
const WEBHOOK_URL = 'https://backend-production-1ba8.up.railway.app/api/monday/webhook'

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

// When a subitem enters "Proofread" status, auto-create a proof_products entry
// so it appears in the Proofreading page. No-op if one already exists.
async function upsertProofProductFromSubitem(mondaySubitemId: string): Promise<void> {
  const { data: sub } = await supabase
    .from('monday_subitems')
    .select('product_name, name, page_link, drive_link')
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
    .ilike('product_name', productName)
    .maybeSingle()
  if (existing) return

  await supabase.from('proof_products').insert({
    product_name: productName,
    pdp_url:      (sub.page_link ?? null) as string | null,
    drive_folder: (sub.drive_link ?? null) as string | null,
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

      // Stamp phase timestamp when website_status advances on a subitem
      if (field === 'website_status' && typeof value === 'string' && value) {
        const tsField = lpPhaseField(value)
        if (tsField) subPayload[tsField] = new Date().toISOString()
      }

      await supabase.from('monday_subitems')
        .update(subPayload)
        .eq('monday_subitem_id', pulseId)

      if (field === 'website_status' && typeof value === 'string' && value.toLowerCase() === 'waiting for proofread') {
        await upsertProofProductFromSubitem(pulseId)
      }

    } else if (event.type === 'update_column_value') {
      const colMap = isSub ? SUB_COL : ITEM_COL
      const field  = colMap[event.columnId]
      if (!field) return res.json({ ok: true })

      const value = parseWebhookValue(event.value, field)
      const table = isSub ? 'monday_subitems' : 'monday_items'
      const idCol = isSub ? 'monday_subitem_id' : 'monday_item_id'

      const updatePayload: Record<string, unknown> = { [field]: value, updated_at: new Date().toISOString() }

      // Stamp phase timestamp for landing_page_status (items) or website_status (subitems)
      if (typeof value === 'string' && value) {
        const isTracked = (!isSub && field === 'landing_page_status') || (isSub && field === 'website_status')
        if (isTracked) {
          const tsField = lpPhaseField(value)
          if (tsField) updatePayload[tsField] = new Date().toISOString()
        }
      }

      await supabase.from(table)
        .update(updatePayload)
        .eq(idCol, pulseId)

      if (isSub && field === 'website_status' && typeof value === 'string' && value.toLowerCase() === 'waiting for proofread') {
        await upsertProofProductFromSubitem(pulseId)
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
      const data = await mondayGql(`{ items(ids: [${pulseId}]) { id name column_values { id text } parent_item { id } } }`)
      const sub = data?.data?.items?.[0]
      if (sub?.parent_item?.id) {
        const { data: parentItem } = await supabase.from('monday_items')
          .select('id').eq('monday_item_id', String(sub.parent_item.id)).single()
        if (parentItem) {
          const subCols: Record<string, unknown> = {}
          for (const cv of sub.column_values ?? []) {
            const f = SUB_COL[cv.id]
            if (f) subCols[f] = BOOL_FIELDS.has(f) ? (cv.text === 'v' || cv.text === 'true') : (cv.text || null)
          }
          await supabase.from('monday_subitems').upsert({
            item_id: parentItem.id, monday_subitem_id: sub.id, name: sub.name, ...subCols,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'monday_subitem_id' })
        }
      }

    } else if ((event.type === 'create_pulse' || event.type === 'create_item') && isSub && event.parentItemId) {
      // New subitem — fires on the subitems board; parentItemId is in the payload
      const parentItemId = String(event.parentItemId)
      const { data: parentItem } = await supabase.from('monday_items')
        .select('id').eq('monday_item_id', parentItemId).single()
      if (parentItem) {
        const data = await mondayGql(`{ items(ids: [${pulseId}]) { id name column_values { id text } } }`)
        const sub = data?.data?.items?.[0]
        if (sub) {
          const subCols: Record<string, unknown> = {}
          for (const cv of sub.column_values ?? []) {
            const f = SUB_COL[cv.id]
            if (f) subCols[f] = BOOL_FIELDS.has(f) ? (cv.text === 'v' || cv.text === 'true') : (cv.text || null)
          }
          await supabase.from('monday_subitems').upsert({
            item_id: parentItem.id, monday_subitem_id: sub.id, name: sub.name, ...subCols,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'monday_subitem_id' })
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
      subitems { id name column_values { id text } }
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
    const subCols: Record<string, unknown> = {}
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
              subitems { id name column_values { id text } }
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
          const subCols: Record<string, unknown> = {}
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
                subitems { id name column_values { id text } }
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
            const subCols: Record<string, unknown> = {}
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

// ── POST /api/monday/register-hooks ──────────────────────────────────────
// Registers change_column_value webhooks on all boards. Admin only.
router.post('/register-hooks', authenticate, requireAdmin, async (_req: AuthRequest, res: Response) => {
  if (!MONDAY_TOKEN) return res.status(500).json({ error: 'MONDAY_API_TOKEN not set' })

  const allBoards = [
    ...Object.keys(PARENT_BOARD_MAP),
    ...Object.keys(SUBITEM_BOARD_MAP),
  ]

  const results: Record<string, unknown> = {}

  for (const boardId of allBoards) {
    const resp = await mondayGql(`
      mutation {
        create_webhook(board_id: ${boardId}, url: "${WEBHOOK_URL}", event: change_column_value) {
          id board_id
        }
      }
    `)
    results[boardId] = resp?.data?.create_webhook ?? resp?.errors
  }

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

// ── GET /api/monday/waves-weekly-report ──────────────────────────────────
router.get('/waves-weekly-report', authenticate, async (req: AuthRequest, res: Response) => {
  const { weekStart: weekStartParam } = req.query

  // Compute week start (Monday) and end (Sunday)
  let ws: Date
  if (weekStartParam && typeof weekStartParam === 'string') {
    ws = new Date(weekStartParam + 'T00:00:00')
  } else {
    ws = new Date()
    const day = ws.getDay()
    ws.setDate(ws.getDate() + (day === 0 ? -6 : 1 - day))
    ws.setHours(0, 0, 0, 0)
  }
  const we = new Date(ws)
  we.setDate(we.getDate() + 6)
  we.setHours(23, 59, 59, 999)
  const wsISO = ws.toISOString()
  const weISO = we.toISOString()

  function daysBetween(from: string | null | undefined, to: string | null | undefined): number | null {
    if (!from || !to) return null
    const d = (new Date(to).getTime() - new Date(from).getTime()) / 86_400_000
    return d < 0 ? null : d
  }

  function avgOf(values: (number | null)[]): number | null {
    const valid = values.filter((v): v is number => v !== null && isFinite(v))
    if (!valid.length) return null
    return Math.round(valid.reduce((a, b) => a + b, 0) / valid.length * 10) / 10
  }

  const { data: subitems, error } = await (supabase as any)
    .from('monday_subitems')
    .select(`
      id, name, website_status, concluded,
      lp_building_at, lp_ready_at,
      lp_proofread_at, lp_ready_to_launch_at, lp_launched_at,
      monday_items!inner(
        id, name, created_at, landing_page_status,
        monday_waves!inner(wave_number, name)
      )
    `)

  if (error) return res.status(500).json({ error: error.message })

  const allSubs: any[] = subitems ?? []

  // Group subitems by item
  const itemMap = new Map<string, { item: any; subitems: any[] }>()
  for (const sub of allSubs) {
    const mi = sub.monday_items
    if (!mi) continue
    const itemId = mi.id
    if (!itemMap.has(itemId)) itemMap.set(itemId, { item: mi, subitems: [] })
    itemMap.get(itemId)!.subitems.push(sub)
  }
  const items = Array.from(itemMap.values())

  const getLang = (subs: any[], lang: string) =>
    subs.find((s: any) => s.name?.trim().toLowerCase() === lang.toLowerCase())

  // 1. Products tested: items whose landing_page_status is "launched"
  const productsTestedFullSet = items.filter(({ item }) =>
    item.landing_page_status?.toLowerCase() === 'launched'
  ).length

  // 2. Avg Phase 1 days for EN/English subitems in Wave 1
  //    denominator = all EN subs in Wave 1; numerator = those with both phase dates
  const getEnSub = (subs: any[]) =>
    subs.find((s: any) => { const n = s.name?.trim().toLowerCase(); return n === 'en' || n === 'english' })
  const wave1EnSubs = items
    .filter(({ item }) => item.monday_waves?.wave_number === 1)
    .map(({ subitems: subs }) => getEnSub(subs))
    .filter(Boolean)
  const wave1EnPhase1Days = wave1EnSubs
    .map((s: any) => daysBetween(s.lp_building_at, s.lp_ready_at))
    .filter((d): d is number => d !== null)
  const avgSpotToEnLaunch = wave1EnPhase1Days.length > 0
    ? Math.round(wave1EnPhase1Days.reduce((a, b) => a + b, 0) / wave1EnPhase1Days.length * 10) / 10
    : null

  // 3. Avg proofread phase days: waves 1-7, non-EN/English subitems only
  const proofreadDays = allSubs
    .filter((s: any) => {
      const waveNum = s.monday_items?.monday_waves?.wave_number
      if (waveNum === undefined || waveNum === 0) return false
      const n = s.name?.trim().toLowerCase()
      return n !== 'en' && n !== 'english'
    })
    .map((s: any) => daysBetween(s.lp_proofread_at, s.lp_ready_to_launch_at))
    .filter((d): d is number => d !== null)
  const avgDaysProofread = proofreadDays.length > 0
    ? Math.round(proofreadDays.reduce((a, b) => a + b, 0) / proofreadDays.length * 10) / 10
    : null

  // 4. Avg Phase 1 days for non-EN subitems in Wave 1
  const enToOthersDays = items
    .filter(({ item }) => item.monday_waves?.wave_number === 1)
    .flatMap(({ subitems: subs }) => subs
      .filter((s: any) => { const n = s.name?.trim().toLowerCase(); return n !== 'en' && n !== 'english' })
      .map((s: any) => daysBetween(s.lp_building_at, s.lp_ready_at))
      .filter((d): d is number => d !== null)
    )
  const avgEnToOthersLaunch = enToOthersDays.length > 0
    ? Math.round(enToOthersDays.reduce((a, b) => a + b, 0) / enToOthersDays.length * 10) / 10
    : null

  // 5. Items waiting in Proofread queue
  const itemsWithSubIds = new Set(allSubs.map((s: any) => s.monday_items?.id).filter(Boolean))

  // direct items (no subitems) in Wave 1 with landing_page_status = waiting for proofread
  const { data: wave1Waves } = await supabase
    .from('monday_waves').select('id').eq('wave_number', 1)
  const wave1Ids = (wave1Waves ?? []).map((w: any) => w.id)
  const { data: directItems } = wave1Ids.length
    ? await supabase
        .from('monday_items')
        .select('id, landing_page_status')
        .in('wave_id', wave1Ids)
        .ilike('landing_page_status', 'waiting for proofread')
    : { data: [] }
  const directWave1ProofreadCount = (directItems ?? [])
    .filter((item: any) => !itemsWithSubIds.has(item.id))
    .length

  const wave1ProofreadQueue = allSubs.filter((s: any) =>
    s.monday_items?.monday_waves?.wave_number === 1 &&
    s.website_status?.toLowerCase() === 'waiting for proofread'
  ).length + directWave1ProofreadCount
  const wave2to7ProofreadQueue = allSubs.filter((s: any) => {
    const wn = s.monday_items?.monday_waves?.wave_number
    return wn >= 2 && wn <= 7 && s.website_status?.toLowerCase() === 'waiting for proofread'
  }).length

  // 6. Tested products that made it to Wave 2+ (%)
  const testedInWave1 = items.filter(({ item, subitems: subs }) =>
    item.monday_waves?.wave_number === 1 && subs.some((s: any) => s.lp_launched_at)
  ).length
  const testedInWave2Plus = items.filter(({ item, subitems: subs }) =>
    (item.monday_waves?.wave_number ?? 0) >= 2 && subs.some((s: any) => s.lp_launched_at)
  ).length
  const totalTestedWaves = testedInWave1 + testedInWave2Plus
  const pctTestedToWave2 = totalTestedWaves > 0
    ? Math.round(testedInWave2Plus / totalTestedWaves * 100)
    : null

  // 7. Avg days: wave arrival → all 3 campaigns done
  const avgDaysWaveToAllDone = avgOf(items.map(({ item, subitems: subs }) => {
    const en = getLang(subs, 'en')
    const es = getLang(subs, 'es')
    const de = getLang(subs, 'de')
    if (!en?.lp_launched_at || !es?.lp_launched_at || !de?.lp_launched_at) return null
    const lastLaunch = Math.max(
      new Date(en.lp_launched_at).getTime(),
      new Date(es.lp_launched_at).getTime(),
      new Date(de.lp_launched_at).getTime(),
    )
    return daysBetween(item.created_at, new Date(lastLaunch).toISOString())
  }))

  // 8. New languages launched this week
  const newLangsThisWeek = allSubs.filter((s: any) =>
    s.lp_launched_at && s.lp_launched_at >= wsISO && s.lp_launched_at <= weISO
  ).length

  // 9. Avg languages per active product
  const activeLangsPerItem = items
    .map(({ subitems: subs }) => subs.filter((s: any) => s.lp_launched_at && !s.concluded).length)
    .filter(c => c > 0)
  const avgLangsPerActive = avgOf(activeLangsPerItem)

  // 10. Deepest winner (most active languages)
  let deepestWinner: { name: string; count: number } | null = null
  for (const { item, subitems: subs } of items) {
    const count = subs.filter((s: any) => s.lp_launched_at && !s.concluded).length
    if (count > 0 && (!deepestWinner || count > deepestWinner.count)) {
      deepestWinner = { name: item.name, count }
    }
  }

  // 12–14. Winners by size (active = launched + not concluded)
  const activeCountPerItem = items.map(({ subitems: subs }) =>
    subs.filter((s: any) => s.lp_launched_at && !s.concluded).length
  )
  const smallWinners  = activeCountPerItem.filter(c => c >= 1).length
  const mediumWinners = activeCountPerItem.filter(c => c >= 8).length
  const bigWinners    = activeCountPerItem.filter(c => c >= 16).length

  return res.json({
    weekStart: wsISO,
    weekEnd: weISO,
    productsTestedFullSet,
    avgSpotToEnLaunch,
    avgDaysProofread,
    avgEnToOthersLaunch,
    wave1ProofreadQueue,
    wave2to7ProofreadQueue,
    pctTestedToWave2,
    avgDaysWaveToAllDone,
    newLangsThisWeek,
    avgLangsPerActive,
    deepestWinner,
    smallWinners,
    mediumWinners,
    bigWinners,
  })
})

export default router
