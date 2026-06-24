import { Router, Response } from 'express'
import { supabase } from '../supabase'
import { authenticate, requireAdmin, requireManagement, AuthRequest } from '../middleware/auth'
import { enrichBuild, monthStart, monthEnd } from '../utils/calculations'

async function assertFunnelWriteOrAdmin(req: AuthRequest, res: Response, buildId?: string): Promise<boolean> {
  const role = req.userRole ?? ''
  if (role === 'admin') return true
  if (role !== 'website') { res.status(403).json({ error: 'Insufficient permissions' }); return false }
  if (!buildId) { res.status(403).json({ error: 'Insufficient permissions' }); return false }
  const { data } = await supabase.from('builds').select('type').eq('id', buildId).single()
  if (!data || data.type !== 'funnel') { res.status(403).json({ error: 'Insufficient permissions' }); return false }
  return true
}

// Sync a proof_products row to match a build's current state.
// Called whenever a jewelry non-EN build that has into_proofread changes.
async function syncProofProduct(
  newName: string,
  newLang: string,
  proofreader: string | null,
  oldName: string,
  oldLang: string,
  oldProofEnd: string | null,
  newProofEnd: string | null,
): Promise<void> {
  const nameOrLangChanged = oldName !== newName || oldLang !== newLang

  if (nameOrLangChanged) {
    // Update the existing row in place (rename + lang change)
    await supabase.from('proof_products')
      .update({ product_name: newName, language: newLang, proofreader })
      .eq('product_name', oldName)
      .eq('language', oldLang)
  } else {
    // Upsert: update proofreader if exists, create if missing
    const { data: pp } = await supabase
      .from('proof_products')
      .select('id')
      .eq('product_name', newName)
      .eq('language', newLang)
      .maybeSingle()

    if (pp) {
      await supabase.from('proof_products')
        .update({ proofreader })
        .eq('id', pp.id)
    } else {
      await supabase.from('proof_products').insert({
        product_name: newName,
        language:     newLang,
        proofreader,
        done:         false,
      })
    }
  }

  // Sync done state when proof_end changes
  if (oldProofEnd !== newProofEnd) {
    await supabase.from('proof_products')
      .update({ done: newProofEnd !== null })
      .eq('product_name', newName)
      .eq('language', newLang)
  }
}

const router = Router()

router.get('/proofread-queue', authenticate, async (req: AuthRequest, res: Response) => {
  const { month } = req.query
  const ms = month && typeof month === 'string' ? monthStart(month) : undefined
  const me = month && typeof month === 'string' ? monthEnd(month) : undefined

  // ── 1. Waves subitems in proofread ────────────────────────────────────
  // Active (website_status contains 'proofread') always included.
  // Done items (lp_proofread_at set, status moved on) included when lp_proofread_at is in the selected month.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let wq = (supabase as any)
    .from('monday_subitems')
    .select(`
      id, name, product_name, website_status, created_at,
      lp_proofread_at, lp_ready_to_launch_at,
      monday_items!inner(
        name,
        monday_waves!inner(wave_number)
      )
    `)
    .not('lp_proofread_at', 'is', null)

  if (ms && me) {
    wq = wq.or(`website_status.ilike.%proofread%,and(lp_proofread_at.gte.${ms},lp_proofread_at.lte.${me})`)
  } else {
    wq = wq.ilike('website_status', '%proofread%')
  }

  const { data: waveData, error: waveError } = await wq
  if (waveError) return res.status(500).json({ error: waveError.message })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const waveItems = (waveData ?? []).map((sub: any) => {
    const isDone = !sub.website_status?.toLowerCase().includes('proofread')
    return {
      id:             sub.id as string,
      build_id:       null as string | null,
      product_name:   (sub.product_name ?? sub.name) as string,
      monday_url:     null as string | null,
      language:       null as string | null,
      proofreader:    null as string | null,
      type:           'wave' as string,
      week_number:    null as number | null,
      month_year:     null as string | null,
      into_proofread: sub.lp_proofread_at as string | null,
      proof_end:      (isDone ? (sub.lp_ready_to_launch_at ?? null) : null) as string | null,
      proof_days:     null as number | null,
      outcome:        null as string | null,
      done:           isDone as boolean,
      created_at:     sub.created_at as string | null,
      source:         'wave' as const,
    }
  })

  // ── 2. Proof products added directly ──────────────────────────────────
  let ppq = supabase
    .from('proof_products')
    .select('*')
    .or('language.is.null,language.neq.EN')

  if (req.userLang) ppq = ppq.eq('language', req.userLang)

  if (ms && me) {
    const monthStr = typeof month === 'string' ? month : ''
    ppq = ppq.or(`done.eq.false,month_year.eq.${monthStr}`)
  } else {
    ppq = ppq.eq('done', false)
  }

  const { data: ppData } = await ppq

  const directItems = (ppData ?? []).map(pp => ({
    id:             `pp-${pp.id}`,
    build_id:       null as string | null,
    product_name:   pp.product_name as string,
    monday_url:     (pp.monday_url ?? null) as string | null,
    language:       pp.language as string | null,
    proofreader:    pp.proofreader as string | null,
    type:           (pp.type ?? 'jewelry') as string,
    week_number:    (pp.week_number ?? null) as number | null,
    month_year:     (pp.month_year ?? null) as string | null,
    into_proofread: (pp.into_proofread ?? null) as string | null,
    proof_end:      null as string | null,
    proof_days:     null as number | null,
    outcome:        null as string | null,
    done:           pp.done as boolean,
    created_at:     (pp.created_at ?? null) as string | null,
    source:         'proof_product' as const,
  }))

  const waveNames = new Set(waveItems.map((i: { product_name: string }) => i.product_name?.toLowerCase()).filter(Boolean))
  const dedupedDirectItems = directItems.filter((i: { product_name: string }) => !waveNames.has(i.product_name?.toLowerCase()))

  res.json([...waveItems, ...dedupedDirectItems])
})

// Payment overview — same data source as proofread-queue, with payment fields added
router.get('/payment-overview', authenticate, requireManagement, async (req: AuthRequest, res: Response) => {
  const { month } = req.query
  const ms = month && typeof month === 'string' ? monthStart(month) : undefined
  const me = month && typeof month === 'string' ? monthEnd(month) : undefined

  // ── 1. Builds (same query as proofread-queue) ─────────────────────────
  let bq = supabase
    .from('builds')
    .select('*')
    .not('into_proofread', 'is', null)
    .neq('language', 'EN')

  if (req.userLang) bq = bq.eq('language', req.userLang)

  if (ms && me) {
    bq = bq.or(`proof_end.is.null,and(proof_end.gte.${ms},proof_end.lte.${me})`)
  } else {
    bq = bq.is('proof_end', null).or('outcome.is.null,outcome.neq.stopped')
  }

  const { data: buildsData, error } = await bq
  if (error) return res.status(500).json({ error: error.message })
  const enrichedBuilds = (buildsData ?? []).map(enrichBuild)

  // ── 2. All proof_products for payment lookup (no month filter) ─────────
  let allPpq = supabase
    .from('proof_products')
    .select('*')
    .or('language.is.null,language.neq.EN')
  if (req.userLang) allPpq = allPpq.eq('language', req.userLang)
  const { data: allPpData } = await allPpq

  // Build payment map keyed by product_name|language
  const ppMap = new Map<string, {
    id: string; paid: boolean; paid_at: string | null; done: boolean
    ready_for_revision: boolean; pdp_url: string | null; drive_folder: string | null
  }>()
  for (const pp of allPpData ?? []) {
    ppMap.set(`${(pp.product_name as string).toLowerCase()}|${pp.language ?? ''}`, {
      id:                 pp.id as string,
      paid:               (pp.paid as boolean) ?? false,
      paid_at:            (pp.paid_at as string | null) ?? null,
      done:               pp.done as boolean,
      ready_for_revision: (pp.ready_for_revision as boolean) ?? false,
      pdp_url:            (pp.pdp_url as string | null) ?? null,
      drive_folder:       (pp.drive_folder as string | null) ?? null,
    })
  }

  // ── 3. Month-filtered proof_products for orphan display ────────────────
  const ppMonthFiltered = (allPpData ?? []).filter(pp => {
    if (!pp.done) return true
    if (ms && me) return pp.month_year === (typeof month === 'string' ? month : '')
    return false
  })

  // ── 4. Deduplicate: orphans are proof_products not covered by a build ──
  const buildKeys = new Set(
    enrichedBuilds.map(b => `${String(b.product_name).toLowerCase()}|${b.language ?? ''}`)
  )

  type Status = 'done' | 'in_proofread' | 'ready' | 'needs_links' | 'active'

  function ppStatus(pp: Record<string, unknown>): Status {
    if (pp.done) return 'done'
    if (pp.ready_for_revision) return 'ready'
    if (!pp.pdp_url || !pp.drive_folder) return 'needs_links'
    return 'active'
  }

  const orphans = ppMonthFiltered
    .filter(pp => !buildKeys.has(`${(pp.product_name as string).toLowerCase()}|${pp.language ?? ''}`))
    .map(pp => ({
      id:               `pp-${pp.id}`,
      proof_product_id: pp.id as string,
      build_id:         null as string | null,
      product_name:     pp.product_name as string,
      language:         pp.language as string | null,
      proofreader:      pp.proofreader as string | null,
      type:             (pp.type ?? 'jewelry') as string,
      week_number:      (pp.week_number ?? null) as number | null,
      month_year:       (pp.month_year ?? null) as string | null,
      into_proofread:   null as string | null,
      proof_end:        null as string | null,
      proof_days:       null as number | null,
      outcome:          null as string | null,
      done:             pp.done as boolean,
      source:           'proof_product' as const,
      paid:             (pp.paid as boolean) ?? false,
      paid_at:          (pp.paid_at as string | null) ?? null,
      status:           ppStatus(pp as Record<string, unknown>),
    }))

  // ── 5. Build items with payment info ───────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buildItems = enrichedBuilds.map((b: any) => {
    const key = `${String(b.product_name).toLowerCase()}|${b.language ?? ''}`
    const pp  = ppMap.get(key)
    const isDone = !!(b.proof_end) || pp?.done
    let status: Status
    if (isDone)                   status = 'done'
    else if (pp?.ready_for_revision) status = 'ready'
    else                          status = 'in_proofread'
    return {
      id:               b.id as string,
      proof_product_id: pp?.id ?? null,
      build_id:         b.id as string,
      product_name:     b.product_name as string,
      language:         b.language as string | null,
      proofreader:      b.proofreader as string | null,
      type:             b.type as string | null,
      week_number:      b.week_number as number | null,
      month_year:       b.month_year as string | null,
      into_proofread:   b.into_proofread as string | null,
      proof_end:        b.proof_end as string | null,
      proof_days:       b.proof_days as number | null,
      outcome:          b.outcome as string | null,
      done:             isDone as boolean,
      source:           'build' as const,
      paid:             pp?.paid ?? false,
      paid_at:          pp?.paid_at ?? null,
      status,
    }
  })

  res.json([...buildItems, ...orphans])
})

// Mark a product as paid; creates a proof_products row if none exists yet (build-sourced orphan)
router.post('/mark-paid', authenticate, requireManagement, async (req: AuthRequest, res: Response) => {
  const { id, product_name, language, proofreader, paid, paid_at } = req.body as {
    id?: string
    product_name: string
    language: string | null
    proofreader: string | null
    paid: boolean
    paid_at: string | null
  }

  if (id) {
    const { error } = await supabase
      .from('proof_products')
      .update({ paid, paid_at, updated_at: new Date().toISOString() })
      .eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
  } else {
    // Build-sourced product with no proof_products row yet — upsert by name+lang
    const { data: existing } = await supabase
      .from('proof_products')
      .select('id')
      .eq('product_name', product_name)
      .eq('language', language ?? '')
      .maybeSingle()

    if (existing) {
      await supabase.from('proof_products')
        .update({ paid, paid_at, updated_at: new Date().toISOString() })
        .eq('id', existing.id)
    } else {
      await supabase.from('proof_products').insert({
        product_name, language, proofreader, done: true, paid, paid_at,
      })
    }
  }

  res.json({ ok: true })
})

router.get('/', authenticate, async (req: AuthRequest, res: Response) => {
  const { type, month } = req.query
  let query = supabase.from('builds').select('*').order('created_at', { ascending: true })
  if (type) query = query.eq('type', type)
  if (month && typeof month === 'string') {
    query = query.gte('month_year', monthStart(month)).lte('month_year', monthEnd(month))
  }
  const { data, error } = await query
  if (error) return res.status(500).json({ error: error.message })
  res.json((data ?? []).map(enrichBuild))
})

router.post('/', authenticate, async (req: AuthRequest, res: Response) => {
  const role = req.userRole ?? ''
  const isManagement = role === 'admin' || role === 'management'
  const isWebsiteFunnel = role === 'website' && req.body.type === 'funnel'
  if (!isManagement && !isWebsiteFunnel) return res.status(403).json({ error: 'Insufficient permissions' })
  const { data, error } = await supabase.from('builds').insert(req.body).select().single()
  if (error) return res.status(500).json({ error: error.message })

  res.status(201).json(enrichBuild(data))
})

router.put('/:id', authenticate, async (req: AuthRequest, res: Response) => {
  if (!await assertFunnelWriteOrAdmin(req, res, req.params.id)) return

  // Capture state before update so we can detect what changed
  const { data: before } = await supabase
    .from('builds')
    .select('language, product_name, proof_end')
    .eq('id', req.params.id)
    .single()

  const { phase, build_days, proof_days, test_days, total_days, created_at, ...updateData } = req.body
  const { data, error } = await supabase
    .from('builds')
    .update({ ...updateData, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select()
    .single()
  if (error) return res.status(500).json({ error: error.message })

  res.json(enrichBuild(data))
})

router.delete('/:id', authenticate, async (req: AuthRequest, res: Response) => {
  if (!await assertFunnelWriteOrAdmin(req, res, req.params.id)) return

  // Fetch build before deleting so we can cascade to proof_products
  const { data: build } = await supabase
    .from('builds')
    .select('product_name, language, type')
    .eq('id', req.params.id)
    .single()

  const { error } = await supabase.from('builds').delete().eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })

  res.status(204).end()
})

export default router
