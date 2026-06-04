import { Router, Response } from 'express'
import { supabase } from '../supabase'
import { authenticate, AuthRequest } from '../middleware/auth'
import { enrichBuild, avg, monthStart, monthEnd } from '../utils/calculations'

const router = Router()

router.get('/', authenticate, async (req: AuthRequest, res: Response) => {
  const { month } = req.query
  const ms = month && typeof month === 'string' ? monthStart(month) : undefined
  const me = month && typeof month === 'string' ? monthEnd(month) : undefined

  let buildsQuery = supabase.from('builds').select('*')
  if (ms && me) buildsQuery = buildsQuery.gte('month_year', ms).lte('month_year', me)
  const { data: builds, error: bErr } = await buildsQuery
  if (bErr) return res.status(500).json({ error: bErr.message })

  let mistakesQuery = supabase.from('mistakes').select('category')
  if (ms && me) mistakesQuery = mistakesQuery.gte('month_year', ms).lte('month_year', me)
  const { data: mistakes } = await mistakesQuery

  const { data: settings } = await supabase.from('settings').select('*').eq('id', 1).single()

  const enriched = (builds ?? []).map(enrichBuild)
  const decided = enriched.filter(b => b.outcome_decided)

  const proofreadQueue = enriched.filter(
    b => b.into_proofread && !b.into_testing && b.outcome !== 'stopped'
  )

  res.json({
    buildCycleAvg: avg(enriched.map(b => b.build_days)),
    proofCycleAvg: avg(enriched.map(b => b.proof_days)),
    testCycleAvg: avg(decided.map(b => b.test_days)),
    totalCycleAvg: avg(decided.map(b => b.total_days)),
    proofreadQueueDepth: proofreadQueue.length,
    proofreadFlagged: proofreadQueue.filter(b => {
      const days = b.proof_days ?? (b.into_proofread
        ? Math.round((Date.now() - new Date(b.into_proofread as string).getTime()) / 86_400_000)
        : 0)
      return days > (settings?.proof_target_days ?? 3)
    }).length,
    mistakesCount: (mistakes ?? []).length,
    translationFlags: (mistakes ?? []).filter(m => m.category === 'Translation / proofreading').length,
    funnelRedirectIssues: (mistakes ?? []).filter(
      m => m.category === 'Funnelish → Shopify checkout redirect (wrong/empty cart · lost variant)'
    ).length,
    targets: settings ?? {},
    phaseBreakdown: {
      building: enriched.filter(b => b.phase === 'building').length,
      proofread: enriched.filter(b => b.phase === 'proofread').length,
      testing: enriched.filter(b => b.phase === 'testing').length,
      decided: enriched.filter(b => b.phase === 'decided').length,
    },
  })
})

export default router
