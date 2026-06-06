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

  let mq = supabase.from('mistakes').select('date')
  if (ms && me) mq = mq.gte('month_year', ms).lte('month_year', me)
  const { data: mistakes } = await mq

  const enriched = (builds ?? []).map(enrichBuild)
  const weeks = [1, 2, 3, 4]

  const weekStats = weeks.map(w => {
    const wb = enriched.filter(b => b.week_number === w)
    const decided = wb.filter(b => b.outcome_decided)
    const wMistakes = (mistakes ?? []).filter(m => {
      if (!m.date) return false
      const day = new Date(m.date).getUTCDate()
      return Math.min(Math.ceil(day / 7), 4) === w
    })
    const toSummary = (b: ReturnType<typeof enrichBuild>) => ({
      product_name: b.product_name as string,
      language: b.language as string | null,
      type: b.type as string,
    })
    const tested    = wb.filter(b => b.into_testing)
    const testedWon = tested.filter(b => b.outcome === 'expanding')
    return {
      week: w,
      logged: wb.length,
      completed: decided.length,
      winners: wb.filter(b => b.outcome === 'expanding').length,
      killed: wb.filter(b => b.outcome === 'stopped').length,
      mistakes: wMistakes.length,
      avgBuildDays: avg(wb.map(b => b.build_days)),
      avgTotalDays: avg(decided.map(b => b.total_days)),
      testedCount: tested.length,
      testedWon: testedWon.length,
      testWinRate: tested.length > 0 ? `${Math.round(testedWon.length / tested.length * 100)}%` : '—',
      expandingBuilds: wb.filter(b => b.outcome === 'expanding').map(toSummary),
      testingBuilds:   wb.filter(b => b.outcome === 'testing').map(toSummary),
    }
  })

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
  const decided = enriched.filter(b => b.outcome_decided)

  const monthStr = month ?? new Date().toISOString().slice(0, 7)
  const { data: narrative } = await supabase
    .from('report_narratives')
    .select('*')
    .eq('type', 'monthly')
    .eq('month_year', `${monthStr}-01`)
    .single()

  let mq = supabase.from('mistakes').select('*')
  if (ms && me) mq = mq.gte('month_year', ms).lte('month_year', me)
  const { data: mistakes } = await mq
  const mistakeList = mistakes ?? []

  const categoryCounts: Record<string, number> = {}
  for (const m of mistakeList) {
    if (m.category) categoryCounts[m.category] = (categoryCounts[m.category] ?? 0) + 1
  }

  const withOutcome = enriched.filter(b => b.outcome)
  const expanding = enriched.filter(b => b.outcome === 'expanding').length

  const allTested    = enriched.filter(b => b.into_testing)
  const allTestedWon = allTested.filter(b => b.outcome === 'expanding')
  const testWinRate  = allTested.length > 0
    ? `${Math.round(allTestedWon.length / allTested.length * 100)}%`
    : '—'

  const toBuildSummary = (b: ReturnType<typeof enrichBuild>) => ({
    product_name: b.product_name as string,
    language: b.language as string | null,
    type: b.type as string,
    week_number: b.week_number as number,
  })

  res.json({
    totalCompleted: decided.length,
    jewelryCompleted: decided.filter(b => b.type === 'jewelry').length,
    funnelCompleted: decided.filter(b => b.type === 'funnel').length,
    byWeek: [1, 2, 3, 4].map(w => decided.filter(b => b.week_number === w).length),
    winners: expanding,
    killed: enriched.filter(b => b.outcome === 'stopped').length,
    winRate: withOutcome.length > 0
      ? Math.round(expanding / withOutcome.length * 100) + '%'
      : '—',
    avgBuildDays: avg(enriched.map(b => b.build_days)),
    avgTotalDays: avg(decided.map(b => b.total_days)),
    mistakesTotal: mistakeList.length,
    mistakesRepeating: Object.values(categoryCounts).filter(c => c > 1).reduce((s, c) => s + c, 0),
    mistakesByCategory: categoryCounts,
    sopUpdated: mistakeList.filter(m => m.sop_updated).length,
    testWinRate,
    expandingList: enriched.filter(b => b.outcome === 'expanding').map(toBuildSummary),
    testingList:   enriched.filter(b => b.outcome === 'testing').map(toBuildSummary),
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
