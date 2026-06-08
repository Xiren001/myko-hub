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

const router = Router()

router.get('/proofread-queue', authenticate, async (req: AuthRequest, res: Response) => {
  const { month } = req.query
  const ms = month && typeof month === 'string' ? monthStart(month) : undefined
  const me = month && typeof month === 'string' ? monthEnd(month) : undefined

  // ── 1. Builds in proofread ──────────────────────────────────────────────
  let bq = supabase
    .from('builds')
    .select('*')
    .not('into_proofread', 'is', null)
    .neq('language', 'EN')

  if (ms && me) {
    bq = bq.or(`proof_end.is.null,and(into_proofread.gte.${ms},into_proofread.lte.${me})`)
  } else {
    bq = bq.is('proof_end', null).or('outcome.is.null,outcome.neq.stopped')
  }

  const { data: buildsData, error } = await bq
  if (error) return res.status(500).json({ error: error.message })
  const enrichedBuilds = (buildsData ?? []).map(enrichBuild)

  // ── 2. Proof products added directly (not linked to a build) ───────────
  const { data: ppData } = await supabase
    .from('proof_products')
    .select('*')
    .eq('done', false)
    .or('language.is.null,language.neq.EN')

  // Deduplicate: skip proof_products already covered by a build (matched by product_name + language)
  const buildKeys = new Set(
    enrichedBuilds.map(b => `${String(b.product_name).toLowerCase()}|${b.language ?? ''}`)
  )

  const orphans = (ppData ?? [])
    .filter(pp => !buildKeys.has(`${pp.product_name.toLowerCase()}|${pp.language ?? ''}`))
    .map(pp => ({
      id: `pp-${pp.id}`,
      build_id: null as string | null,
      product_name: pp.product_name as string,
      language: pp.language as string | null,
      proofreader: pp.proofreader as string | null,
      type: null as string | null,
      week_number: null as number | null,
      month_year: null as string | null,
      into_proofread: null as string | null,
      proof_end: null as string | null,
      proof_days: null as number | null,
      outcome: null as string | null,
      source: 'proof_product' as const,
    }))

  // ── 3. Normalise build rows to the same shape ──────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buildItems = enrichedBuilds.map((b: any) => ({
    id: b.id as string,
    build_id: b.id as string,
    product_name: b.product_name as string,
    language: b.language as string | null,
    proofreader: b.proofreader as string | null,
    type: b.type as string | null,
    week_number: b.week_number as number | null,
    month_year: b.month_year as string | null,
    into_proofread: b.into_proofread as string | null,
    proof_end: b.proof_end as string | null,
    proof_days: b.proof_days as number | null,
    outcome: b.outcome as string | null,
    source: 'build' as const,
  }))

  res.json([...buildItems, ...orphans])
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

  if (data.into_proofread && data.language && data.language !== 'EN' && data.type === 'jewelry') {
    const { count } = await supabase
      .from('proof_products')
      .select('id', { count: 'exact', head: true })
      .eq('product_name', data.product_name)
      .eq('language', data.language)
    if ((count ?? 0) === 0) {
      await supabase.from('proof_products').insert({
        product_name: data.product_name,
        language:     data.language,
        proofreader:  data.proofreader ?? null,
        done:         false,
      })
    }
  }

  res.status(201).json(enrichBuild(data))
})

router.put('/:id', authenticate, async (req: AuthRequest, res: Response) => {
  if (!await assertFunnelWriteOrAdmin(req, res, req.params.id)) return

  // Capture old language before update so we can detect language changes
  const { data: before } = await supabase
    .from('builds')
    .select('language')
    .eq('id', req.params.id)
    .single()

  // Strip computed fields that don't exist as DB columns
  const { phase, build_days, proof_days, test_days, total_days, created_at, ...updateData } = req.body
  const { data, error } = await supabase
    .from('builds')
    .update({ ...updateData, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select()
    .single()
  if (error) return res.status(500).json({ error: error.message })

  // Auto-create/sync a proof_products entry when a build is in proofread.
  // If the language changed, update the existing entry instead of creating a duplicate.
  if (data.into_proofread && data.language && data.language !== 'EN' && data.type === 'jewelry') {
    const newLang = data.language as string
    const oldLang = before?.language as string | undefined

    if (oldLang && oldLang !== newLang) {
      // Language changed on an existing proofread build — update the proof_products row
      await supabase.from('proof_products')
        .update({ language: newLang })
        .eq('product_name', data.product_name)
        .eq('language', oldLang)
    } else {
      // Same language (or no prior record) — create only if missing
      const { count } = await supabase
        .from('proof_products')
        .select('id', { count: 'exact', head: true })
        .eq('product_name', data.product_name)
        .eq('language', newLang)

      if ((count ?? 0) === 0) {
        await supabase.from('proof_products').insert({
          product_name: data.product_name,
          language:     newLang,
          proofreader:  data.proofreader ?? null,
          done:         false,
        })
      }
    }
  }

  res.json(enrichBuild(data))
})

router.delete('/:id', authenticate, async (req: AuthRequest, res: Response) => {
  if (!await assertFunnelWriteOrAdmin(req, res, req.params.id)) return
  const { error } = await supabase.from('builds').delete().eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })
  res.status(204).end()
})

export default router
