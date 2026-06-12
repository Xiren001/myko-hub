import { Router, Response } from 'express'
import { supabase } from '../supabase'
import { authenticate, requireManagement, AuthRequest } from '../middleware/auth'
import { enrichBuild, daysBetween, avg, monthStart, monthEnd, RawBuild } from '../utils/calculations'

const router = Router()

interface ProofProduct {
  product_name: string | null
  language: string | null
  week_number: number | null
  month_year: string | null
  done: boolean | null
  paid: boolean | null
  ready_for_revision_at: string | null
  website_done_at: string | null
  ads_done_at: string | null
  created_at: string | null
}

function buildProofMap(proofProducts: ProofProduct[]): Map<string, ProofProduct> {
  const map = new Map<string, ProofProduct>()
  for (const pp of proofProducts) {
    if (pp.product_name) {
      map.set(pp.product_name.toLowerCase().trim(), pp)
    }
  }
  return map
}

function getProof(proofMap: Map<string, ProofProduct>, productName: string | null | undefined): ProofProduct | undefined {
  if (!productName) return undefined
  return proofMap.get(productName.toLowerCase().trim())
}

function calcProofStats(
  builds: ReturnType<typeof enrichBuild>[],
  proofMap: Map<string, ProofProduct>
) {
  const proofreadTurnarounds: (number | null)[] = []
  const webRevisionDays: (number | null)[] = []
  const adsRevisionDays: (number | null)[] = []

  for (const b of builds) {
    const pp = getProof(proofMap, b.product_name as string | null)
    if (pp) {
      proofreadTurnarounds.push(daysBetween(pp.created_at, pp.ready_for_revision_at))
      webRevisionDays.push(daysBetween(pp.ready_for_revision_at, pp.website_done_at))
      adsRevisionDays.push(daysBetween(pp.ready_for_revision_at, pp.ads_done_at))
    }
  }

  return {
    avgProofreadTurnaround: avg(proofreadTurnarounds),
    avgWebRevisionDays: avg(webRevisionDays),
    avgAdsRevisionDays: avg(adsRevisionDays),
  }
}

function computeTranslation(jewelryBuilds: ReturnType<typeof enrichBuild>[]) {
  // EN avg: daysBetween(phase1_start, phase1_end) for language=EN
  const enBuilds = jewelryBuilds.filter(b => {
    const lang = (b.language as string | null)?.toUpperCase()
    return lang === 'EN' && b.phase1_start && b.phase1_end
  })
  const enAvgDays = avg(enBuilds.map(b => daysBetween(b.phase1_start as string, b.phase1_end as string)))

  // Group by product_name
  const byProduct = new Map<string, ReturnType<typeof enrichBuild>[]>()
  for (const b of jewelryBuilds) {
    const name = (b.product_name as string | null)?.toLowerCase().trim()
    if (!name) continue
    if (!byProduct.has(name)) byProduct.set(name, [])
    byProduct.get(name)!.push(b)
  }

  const esDeDelays: (number | null)[] = []
  const totalDurations: (number | null)[] = []

  for (const [, group] of byProduct) {
    const enBuild = group.find(b => (b.language as string | null)?.toUpperCase() === 'EN' && b.phase1_end)
    const esBuild = group.find(b => (b.language as string | null)?.toUpperCase() === 'ES' && b.phase1_end)
    const deBuild = group.find(b => (b.language as string | null)?.toUpperCase() === 'DE' && b.phase1_end)

    if (enBuild && esBuild && deBuild) {
      const enEnd = enBuild.phase1_end as string
      const esEnd = esBuild.phase1_end as string
      const deEnd = deBuild.phase1_end as string
      const maxEsDe = esEnd > deEnd ? esEnd : deEnd

      esDeDelays.push(daysBetween(enEnd, maxEsDe))

      const enStart = enBuild.phase1_start as string | null
      if (enStart) {
        totalDurations.push(daysBetween(enStart, maxEsDe))
      }
    }
  }

  return {
    en: { avgDays: enAvgDays },
    esDe: { avgDays: avg(esDeDelays) },
    total: { avgDays: avg(totalDurations) },
  }
}

function computeProofQueue(allProofProducts: ProofProduct[]) {
  return {
    inProgress: allProofProducts.filter(pp => pp.done === false),
    done: allProofProducts.filter(pp => pp.done === true),
  }
}

function computePaymentStatus(allProofProducts: ProofProduct[]) {
  return {
    paid: allProofProducts.filter(pp => pp.paid === true),
    unpaid: allProofProducts.filter(pp => pp.paid === false || pp.paid === null),
  }
}

function extractSettings(settings: Record<string, unknown> | null) {
  if (!settings) return null
  return {
    build_target_days: settings.build_target_days ?? null,
    proof_target_days: settings.proof_target_days ?? null,
    test_target_days: settings.test_target_days ?? null,
    total_target_days: settings.total_target_days ?? null,
    proofread_turnaround_target_days: settings.proofread_turnaround_target_days ?? null,
    web_revision_target_days: settings.web_revision_target_days ?? null,
    ads_revision_target_days: settings.ads_revision_target_days ?? null,
    en_completion_target_days: settings.en_completion_target_days ?? null,
    es_de_translation_target_days: settings.es_de_translation_target_days ?? null,
    total_translation_target_days: settings.total_translation_target_days ?? null,
  }
}

function computeWeekData(
  weekNum: number,
  jewelryBuilds: ReturnType<typeof enrichBuild>[],
  proofMap: Map<string, ProofProduct>
) {
  const wb = jewelryBuilds.filter(b => b.week_number === weekNum)

  // Section 1: New Products Built — phase1_start IS NOT NULL
  const newBuilds = wb.filter(b => b.phase1_start != null)
  const newProofStats = calcProofStats(newBuilds, proofMap)
  const section1 = {
    count: newBuilds.length,
    avgPhase1Days: avg(newBuilds.map(b => b.build_days)),
    avgProofDays: avg(newBuilds.map(b => b.proof_days)),
    avgTestDays: avg(newBuilds.map(b => b.test_days)),
    avgToTestingDays: avg(newBuilds.map(b => daysBetween(b.phase1_start as string | null, b.into_testing as string | null))),
    avgProofreadTurnaround: newProofStats.avgProofreadTurnaround,
    avgWebRevisionDays: newProofStats.avgWebRevisionDays,
    avgAdsRevisionDays: newProofStats.avgAdsRevisionDays,
    products: newBuilds.map(b => ({ product_name: b.product_name as string, language: b.language as string | null })),
  }

  // Section 2: Expanding Products — phase1_start IS NULL AND into_proofread IS NOT NULL
  const expandingProducts = wb.filter(b => b.phase1_start == null && b.into_proofread != null)
  const expandingProofStats = calcProofStats(expandingProducts, proofMap)
  const section2 = {
    count: expandingProducts.length,
    avgProofDays: avg(expandingProducts.map(b => b.proof_days)),
    avgProofreadTurnaround: expandingProofStats.avgProofreadTurnaround,
    avgWebRevisionDays: expandingProofStats.avgWebRevisionDays,
    avgAdsRevisionDays: expandingProofStats.avgAdsRevisionDays,
    products: expandingProducts.map(b => ({ product_name: b.product_name as string, language: b.language as string | null })),
  }

  // Section 3: In Testing — outcome='testing'
  const inTesting = wb.filter(b => b.outcome === 'testing')
  const section3 = {
    count: inTesting.length,
    products: inTesting.map(b => ({ product_name: b.product_name as string, language: b.language as string | null })),
  }

  // Section 4: In Expanding — outcome='expanding'
  const inExpanding = wb.filter(b => b.outcome === 'expanding')
  const wave1 = inExpanding.filter(b => b.phase1_start == null)
  const wave2plus = inExpanding.filter(b => b.phase1_start != null && b.into_testing != null)
  const section4 = {
    wave1Count: wave1.length,
    wave2plusCount: wave2plus.length,
    wave1Products: wave1.map(b => ({ product_name: b.product_name as string, language: b.language as string | null })),
    wave2plusProducts: wave2plus.map(b => ({ product_name: b.product_name as string, language: b.language as string | null })),
  }

  // Section 5: Winning — into_testing IS NOT NULL AND outcome='expanding'
  const winning = wb.filter(b => b.into_testing != null && b.outcome === 'expanding')
  const totalTested = wb.filter(b => b.into_testing != null)
  const section5 = {
    count: winning.length,
    totalTested: totalTested.length,
    pct: totalTested.length > 0 ? `${Math.round(winning.length / totalTested.length * 100)}%` : '—',
  }

  return {
    week: weekNum,
    newBuilds: section1,
    expandingProducts: section2,
    inTesting: section3,
    inExpanding: section4,
    winning: section5,
  }
}

router.get('/weekly', authenticate, async (req: AuthRequest, res: Response) => {
  const { month } = req.query
  const monthStr = month && typeof month === 'string' ? month : new Date().toISOString().slice(0, 7)
  const ms = monthStart(monthStr)
  const me = monthEnd(monthStr)

  const [buildsResult, proofFilteredResult, proofAllResult, settingsResult] = await Promise.all([
    supabase.from('builds').select('*').gte('month_year', ms).lte('month_year', me),
    supabase.from('proof_products').select('*').gte('month_year', ms).lte('month_year', me),
    supabase.from('proof_products').select('*'),
    supabase.from('settings').select('*').eq('id', 1).single(),
  ])

  if (buildsResult.error) return res.status(500).json({ error: buildsResult.error.message })

  const enriched = ((buildsResult.data ?? []) as RawBuild[]).map(enrichBuild)
  const jewelryBuilds = enriched.filter(b => b.type === 'jewelry')

  const filteredProofProducts = (proofFilteredResult.data ?? []) as ProofProduct[]
  const allProofProducts = (proofAllResult.data ?? []) as ProofProduct[]
  const proofMap = buildProofMap(filteredProofProducts)

  const weeks = [1, 2, 3, 4].map(w => computeWeekData(w, jewelryBuilds, proofMap))

  const proofQueue = computeProofQueue(allProofProducts)
  const paymentStatus = computePaymentStatus(allProofProducts)
  const translation = computeTranslation(jewelryBuilds)
  const settings = extractSettings(settingsResult.data as Record<string, unknown> | null)

  res.json({
    weeks,
    proofQueue,
    paymentStatus,
    translation,
    settings,
  })
})

router.get('/monthly', authenticate, async (req: AuthRequest, res: Response) => {
  const { month } = req.query
  const monthStr = month && typeof month === 'string' ? month : new Date().toISOString().slice(0, 7)
  const ms = monthStart(monthStr)
  const me = monthEnd(monthStr)

  const [buildsResult, proofFilteredResult, proofAllResult, settingsResult] = await Promise.all([
    supabase.from('builds').select('*').gte('month_year', ms).lte('month_year', me),
    supabase.from('proof_products').select('*').gte('month_year', ms).lte('month_year', me),
    supabase.from('proof_products').select('*'),
    supabase.from('settings').select('*').eq('id', 1).single(),
  ])

  if (buildsResult.error) return res.status(500).json({ error: buildsResult.error.message })

  const enriched = ((buildsResult.data ?? []) as RawBuild[]).map(enrichBuild)
  const jewelryBuilds = enriched.filter(b => b.type === 'jewelry')

  const filteredProofProducts = (proofFilteredResult.data ?? []) as ProofProduct[]
  const allProofProducts = (proofAllResult.data ?? []) as ProofProduct[]
  const proofMap = buildProofMap(filteredProofProducts)

  // Monthly aggregations for jewelry only

  // Section 1: New Products Built (monthly agg)
  const newBuildsAll = jewelryBuilds.filter(b => b.phase1_start != null)
  const newProofStats = calcProofStats(newBuildsAll, proofMap)
  const newBuildsAgg = {
    count: newBuildsAll.length,
    avgPhase1Days: avg(newBuildsAll.map(b => b.build_days)),
    avgProofDays: avg(newBuildsAll.map(b => b.proof_days)),
    avgTestDays: avg(newBuildsAll.map(b => b.test_days)),
    avgToTestingDays: avg(newBuildsAll.map(b => daysBetween(b.phase1_start as string | null, b.into_testing as string | null))),
    avgProofreadTurnaround: newProofStats.avgProofreadTurnaround,
    avgWebRevisionDays: newProofStats.avgWebRevisionDays,
    avgAdsRevisionDays: newProofStats.avgAdsRevisionDays,
    products: newBuildsAll.map(b => ({ product_name: b.product_name as string, language: b.language as string | null })),
  }

  // Section 2: Expanding Products (monthly agg)
  const expandingProductsAll = jewelryBuilds.filter(b => b.phase1_start == null && b.into_proofread != null)
  const expandingProofStats = calcProofStats(expandingProductsAll, proofMap)
  const expandingProductsAgg = {
    count: expandingProductsAll.length,
    avgProofDays: avg(expandingProductsAll.map(b => b.proof_days)),
    avgProofreadTurnaround: expandingProofStats.avgProofreadTurnaround,
    avgWebRevisionDays: expandingProofStats.avgWebRevisionDays,
    avgAdsRevisionDays: expandingProofStats.avgAdsRevisionDays,
    products: expandingProductsAll.map(b => ({ product_name: b.product_name as string, language: b.language as string | null })),
  }

  // Section 3: In Testing (monthly)
  const inTestingAll = jewelryBuilds.filter(b => b.outcome === 'testing')
  const inTesting = {
    count: inTestingAll.length,
    products: inTestingAll.map(b => ({ product_name: b.product_name as string, language: b.language as string | null })),
  }

  // Section 4: In Expanding (monthly)
  const inExpandingAll = jewelryBuilds.filter(b => b.outcome === 'expanding')
  const wave1All = inExpandingAll.filter(b => b.phase1_start == null)
  const wave2plusAll = inExpandingAll.filter(b => b.phase1_start != null && b.into_testing != null)
  const inExpanding = {
    wave1Count: wave1All.length,
    wave2plusCount: wave2plusAll.length,
    wave1Products: wave1All.map(b => ({ product_name: b.product_name as string, language: b.language as string | null })),
    wave2plusProducts: wave2plusAll.map(b => ({ product_name: b.product_name as string, language: b.language as string | null })),
  }

  // Section 5: Winning (monthly)
  const winningAll = jewelryBuilds.filter(b => b.into_testing != null && b.outcome === 'expanding')
  const totalTestedAll = jewelryBuilds.filter(b => b.into_testing != null)
  const winning = {
    count: winningAll.length,
    totalTested: totalTestedAll.length,
    pct: totalTestedAll.length > 0 ? `${Math.round(winningAll.length / totalTestedAll.length * 100)}%` : '—',
  }

  // Sections 6+7: All proof_products unfiltered
  const proofQueue = computeProofQueue(allProofProducts)
  const paymentStatus = computePaymentStatus(allProofProducts)

  // Section 8: Translation
  const translation = computeTranslation(jewelryBuilds)

  // By-week breakdown
  const byWeek = [1, 2, 3, 4].map(w => computeWeekData(w, jewelryBuilds, proofMap))

  const settings = extractSettings(settingsResult.data as Record<string, unknown> | null)

  res.json({
    newBuilds: newBuildsAgg,
    expandingProducts: expandingProductsAgg,
    inTesting,
    inExpanding,
    winning,
    proofQueue,
    paymentStatus,
    translation,
    byWeek,
    settings,
  })
})

router.put('/narrative', authenticate, requireManagement, async (req: AuthRequest, res: Response) => {
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
