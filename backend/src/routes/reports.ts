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
  website_done: boolean | null
  ads_done: boolean | null
  paid: boolean | null
  build_id: string | null
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
    if (pp && pp.done === true) {
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

function calcProofStatsFromProducts(proofProducts: ProofProduct[]) {
  const done = proofProducts.filter(pp => pp.done === true)
  return {
    avgProofDays: avg(done.map(pp => {
      const w = pp.website_done_at
      const a = pp.ads_done_at
      const maxEnd = w && a ? (w > a ? w : a) : (w ?? a ?? null)
      return daysBetween(pp.created_at, maxEnd)
    })),
    avgProofreadTurnaround: avg(done.map(pp => daysBetween(pp.created_at, pp.ready_for_revision_at))),
    avgWebRevisionDays: avg(done.map(pp => daysBetween(pp.ready_for_revision_at, pp.website_done_at))),
    avgAdsRevisionDays: avg(done.map(pp => daysBetween(pp.ready_for_revision_at, pp.ads_done_at))),
  }
}

function computeTranslation(jewelryBuilds: ReturnType<typeof enrichBuild>[]) {
  // EN: avg phase1 build days for EN builds (include any build with build_days set)
  const enBuilds = jewelryBuilds.filter(b => {
    const lang = (b.language as string | null)?.toUpperCase()
    return lang === 'EN' && b.build_days != null
  })
  const enAvg = avg(enBuilds.map(b => b.build_days as number))

  // ES+DE: avg phase1 build days across all ES and DE builds
  const esDeBuilds = jewelryBuilds.filter(b => {
    const lang = (b.language as string | null)?.toUpperCase()
    return (lang === 'ES' || lang === 'DE') && b.build_days != null
  })
  const esDeAvg = avg(esDeBuilds.map(b => b.build_days as number))

  // Total: arithmetic sum of whatever averages are available
  const totalAvg = (enAvg != null || esDeAvg != null)
    ? Math.round(((enAvg ?? 0) + (esDeAvg ?? 0)) * 10) / 10
    : null

  return {
    en: { avgDays: enAvg },
    esDe: { avgDays: esDeAvg },
    total: { avgDays: totalAvg },
  }
}

const TRACKER_LANGS = new Set(['ES', 'DE'])


function computePaymentStatus(allProofProducts: ProofProduct[]) {
  return {
    paid: allProofProducts.filter(pp => pp.paid === true).length,
    unpaid: allProofProducts.filter(pp => pp.paid === false || pp.paid === null).length,
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
  proofMap: Map<string, ProofProduct>,
  filteredProofProducts: ProofProduct[]
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
    avgTotalDays: avg(newBuilds.map(b => {
      if (b.test_days == null) return null  // skip builds that haven't completed testing
      return b.total_days as number | null   // outcome_decided − phase1_start (includes all gaps)
    })),
    avgProofreadTurnaround: newProofStats.avgProofreadTurnaround,
    avgWebRevisionDays: newProofStats.avgWebRevisionDays,
    avgAdsRevisionDays: newProofStats.avgAdsRevisionDays,
    products: newBuilds.map(b => ({ product_name: b.product_name as string, language: b.language as string | null })),
  }

  // Section 2: Expanding Products — sourced from proof_products directly (not builds)
  // Use created_at for week determination — week_number/month_year may be null on directly-added products
  const newBuildKeys = new Set(
    newBuilds.map(b => `${(b.product_name as string || '').toLowerCase().trim()}_${(b.language as string || '').toLowerCase().trim()}`)
  )
  const expandingPP = filteredProofProducts.filter(pp => {
    if (!pp.created_at) return false
    const day = new Date(pp.created_at).getDate()
    const week = Math.min(4, Math.ceil(day / 7))
    if (week !== weekNum) return false
    const key = `${(pp.product_name || '').toLowerCase().trim()}_${(pp.language || '').toLowerCase().trim()}`
    return !newBuildKeys.has(key)
  })
  const expandingPPStats = calcProofStatsFromProducts(expandingPP)
  const section2 = {
    count: expandingPP.length,
    avgProofDays: expandingPPStats.avgProofDays,
    avgProofreadTurnaround: expandingPPStats.avgProofreadTurnaround,
    avgWebRevisionDays: expandingPPStats.avgWebRevisionDays,
    avgAdsRevisionDays: expandingPPStats.avgAdsRevisionDays,
    products: expandingPP.map(pp => ({ product_name: pp.product_name as string, language: pp.language })),
  }

  // Section 3: In Testing — outcome='testing'
  const inTesting = wb.filter(b => b.outcome === 'testing')
  const section3 = {
    count: inTesting.length,
    products: inTesting.map(b => ({ product_name: b.product_name as string, language: b.language as string | null })),
  }

  // Section 4: In Expanding
  // Wave 1: builds from tracker (phase1_start set) with outcome='expanding'
  const inExpandingBuilds = wb.filter(b => b.outcome === 'expanding')
  const wave1 = inExpandingBuilds.filter(b => b.phase1_start != null)
  // Wave 2+: directly-added proof products (not from tracker) that are still active this week
  const wave2plus = filteredProofProducts.filter(pp => {
    if (!pp.created_at) return false
    const day = new Date(pp.created_at).getDate()
    const week = Math.min(4, Math.ceil(day / 7))
    if (week !== weekNum) return false
    if (pp.done === true) return false
    const key = `${(pp.product_name || '').toLowerCase().trim()}_${(pp.language || '').toLowerCase().trim()}`
    return !newBuildKeys.has(key)
  })
  const section4 = {
    wave1Count: wave1.length,
    wave2plusCount: wave2plus.length,
    wave1Products: wave1.map(b => ({ product_name: b.product_name as string, language: b.language as string | null })),
    wave2plusProducts: wave2plus.map(pp => ({ product_name: pp.product_name as string, language: pp.language })),
  }

  // Section 5: Winning — into_testing IS NOT NULL AND outcome='expanding'
  const winning = wb.filter(b => b.into_testing != null && b.outcome === 'expanding')
  const totalTested = wb.filter(b => b.into_testing != null)
  const section5 = {
    count: winning.length,
    totalTested: totalTested.length,
    pct: totalTested.length > 0 ? `${Math.round(winning.length / totalTested.length * 100)}%` : '—',
  }

  // Stopped — use all builds in month, derive week from phase1_start or created_at
  const stopped = jewelryBuilds.filter(b => {
    if (b.outcome !== 'stopped') return false
    // Use week_number if set, otherwise derive from phase1_start date
    if (b.week_number != null) return b.week_number === weekNum
    const dateStr = b.phase1_start as string | null
    if (!dateStr) return false
    const day = new Date(dateStr).getDate()
    return Math.min(4, Math.ceil(day / 7)) === weekNum
  })

  // Section 8: Translation — per week
  const translation = computeTranslation(wb)

  return {
    week: weekNum,
    newBuilds: section1,
    expandingProducts: section2,
    inTesting: section3,
    inExpanding: section4,
    winning: section5,
    stoppedCount: stopped.length,
    translation,
  }
}

router.get('/weekly', authenticate, async (req: AuthRequest, res: Response) => {
  const { month } = req.query
  const monthStr = month && typeof month === 'string' ? month : new Date().toISOString().slice(0, 7)
  const ms = monthStart(monthStr)
  const me = monthEnd(monthStr)

  const [buildsResult, proofAllResult, settingsResult] = await Promise.all([
    supabase.from('builds').select('*').gte('month_year', ms).lte('month_year', me),
    supabase.from('proof_products').select('*'),
    supabase.from('settings').select('*').eq('id', 1).single(),
  ])

  if (buildsResult.error) return res.status(500).json({ error: buildsResult.error.message })

  const enriched = ((buildsResult.data ?? []) as RawBuild[]).map(enrichBuild)
  const jewelryBuilds = enriched.filter(b => b.type === 'jewelry')

  const allProofProducts = (proofAllResult.data ?? []) as ProofProduct[]
  // Filter by created_at — month_year/week_number may be null on directly-added products
  const filteredProofProducts = allProofProducts.filter(pp => pp.created_at?.startsWith(monthStr))
  const proofMap = buildProofMap(filteredProofProducts)

  const weeks = [1, 2, 3, 4].map(w => computeWeekData(w, jewelryBuilds, proofMap, filteredProofProducts))

  const paymentStatus = computePaymentStatus(allProofProducts)
  const settings = extractSettings(settingsResult.data as Record<string, unknown> | null)

  res.json({
    weeks,
    paymentStatus,
    settings,
  })
})

export default router
