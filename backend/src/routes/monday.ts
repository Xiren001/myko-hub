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
      await supabase.from('monday_subitems')
        .update({ [field]: value, updated_at: new Date().toISOString() })
        .eq('monday_subitem_id', pulseId)

    } else if (event.type === 'update_column_value') {
      const colMap = isSub ? SUB_COL : ITEM_COL
      const field  = colMap[event.columnId]
      if (!field) return res.json({ ok: true })

      const value = parseWebhookValue(event.value, field)
      const table = isSub ? 'monday_subitems' : 'monday_items'
      const idCol = isSub ? 'monday_subitem_id' : 'monday_item_id'

      await supabase.from(table)
        .update({ [field]: value, updated_at: new Date().toISOString() })
        .eq(idCol, pulseId)

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
    '5029159813', '5029160081', '5029160187', '5029160246', '5029160273', '5029160365', '5029161574',
    '5029159814', '5029160083', '5029160188', '5029160247', '5029160274', '5029160368', '5029161575',
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

export default router
