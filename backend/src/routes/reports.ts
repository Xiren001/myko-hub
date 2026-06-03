import { Router, Response } from 'express'
import { supabase } from '../supabase'
import { authenticate, requireAdminOrApprover, AuthRequest } from '../middleware/auth'
import { enrichBuild, avg, monthStart, monthEnd } from '../utils/calculations'

const router = Router()

router.get('/weekly', authenticate, async (req: AuthRequest, res: Response) => {
  const { month } = req.query
  const ms = month && typeof month === 'string' ? monthStart(month) : undefined
  const me = month && typeof month === 'string' ? monthEnd(month) : undefined

  let q = supabase.from('builds').select('*')
  if (ms && me) q = q.gte('month_year', ms).lte('month_year', me)
  const { data: builds, error } = await q
  if (error) return res.status(500).json({ error: error.message })

  const enriched = (builds ?? []).map(enrichBuild)
  const weeks = [1, 2, 3, 4]

  const weekStats = weeks.map(w => {
    const wb = enriched.filter(b => b.week_number === w)
    return {
      week: w,
      logged: wb.length,
      completed: wb.filter(b => b.live_all_geos).length,
      winners: wb.filter(b => b.outcome === 'winner').length,
      killed: wb.filter(b => b.outcome === 'killed').length,
      avgBuildDays: avg(wb.map(b => b.build_days)),
      avgTotalDays: avg(wb.filter(b => b.total_days).map(b => b.total_days)),
    }
  })

  // fetch narratives
  const monthStr = month ?? new Date().toISOString().slice(0, 7)
  const { data: narratives } = await supabase
    .from('report_narratives')
    .select('*')
    .eq('type', 'weekly')
    .eq('month_year', `${monthStr}-01`)

  res.json({ weekStats, narratives: narratives ?? [] })
})

router.get('/monthly', authenticate, async (req: AuthRequest, res: Response) => {
  const { month } = req.query
  const ms = month && typeof month === 'string' ? monthStart(month) : undefined
  const me = month && typeof month === 'string' ? monthEnd(month) : undefined

  let q = supabase.from('builds').select('*')
  if (ms && me) q = q.gte('month_year', ms).lte('month_year', me)
  const { data: builds, error } = await q
  if (error) return res.status(500).json({ error: error.message })

  const enriched = (builds ?? []).map(enrichBuild)
  const live = enriched.filter(b => b.live_all_geos)

  const monthStr = month ?? new Date().toISOString().slice(0, 7)
  const { data: narrative } = await supabase
    .from('report_narratives')
    .select('*')
    .eq('type', 'monthly')
    .eq('month_year', `${monthStr}-01`)
    .single()

  res.json({
    totalCompleted: live.length,
    jewelryCompleted: live.filter(b => b.type === 'jewelry').length,
    funnelCompleted: live.filter(b => b.type === 'funnel').length,
    byWeek: [1, 2, 3, 4].map(w => live.filter(b => b.week_number === w).length),
    winners: enriched.filter(b => b.outcome === 'winner').length,
    killed: enriched.filter(b => b.outcome === 'killed').length,
    winRate: enriched.filter(b => b.outcome).length > 0
      ? Math.round(enriched.filter(b => b.outcome === 'winner').length / enriched.filter(b => b.outcome).length * 100) + '%'
      : '—',
    avgBuildDays: avg(enriched.map(b => b.build_days)),
    avgTotalDays: avg(live.map(b => b.total_days)),
    narrative: narrative ?? null,
  })
})

router.put('/narrative', authenticate, requireAdminOrApprover, async (req: AuthRequest, res: Response) => {
  const { type, week_number, month_year, narrative_text } = req.body
  const { data, error } = await supabase
    .from('report_narratives')
    .upsert({ type, week_number, month_year, narrative_text, updated_at: new Date().toISOString() },
      { onConflict: 'type,week_number,month_year' })
    .select()
    .single()
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

export default router
