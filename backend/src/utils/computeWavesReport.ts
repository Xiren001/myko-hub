import { supabase } from '../supabase'

export interface WaveReportData {
  weekStart: string
  weekEnd: string
  wave1Total: number
  wave1ToWave2Count: number
  pctWave1ToWave2: number | null
  productsTested: number
  avgDaysSpotToEnTest: number | null
  avgDaysProofread: number | null
  avgDaysEnToOthers: number | null
  proofreadQueue: number
  proofreadQueueWaves27: number
  newWaveCampaignAvgDays: { wave: number; avg: number | null }[]
  avgLangsPerProduct: number | null
  mostLangsProduct: { name: string; count: number } | null
  activeWinners: { small: number; medium: number; big: number }
  profitableLaunchPct: number | null
  profitableLaunches: number
  totalLaunches: number
  salesDataUpdatedAt: string | null
  avgRevenuePerWinner: number | null
  activeWinnerCount: number
  productSalesUpdatedAt: string | null
  teamQueue: {
    wave1:   { ad: Record<string, number>; web: Record<string, number> }
    waves27: { ad: Record<string, number>; web: Record<string, number> }
  }
  newLanguagesLaunchedThisWeek: number
}

const TEAM_DONE = new Set(['launched', 'stopped', 'banned', 'do not start', 'running', 'ready to launch'])
const LAUNCHED_STATES = new Set(['launched', 'running'])
const isLaunchedStatus = (s: string | null | undefined) => LAUNCHED_STATES.has((s ?? '').trim().toLowerCase())

function computeTeamQueue(subs: any[]): { ad: Record<string, number>; web: Record<string, number> } {
  const ad: Record<string, number> = {}
  const web: Record<string, number> = {}
  for (const s of subs) {
    const adS  = (s.ad_status  ?? '').trim()
    const webS = (s.website_status ?? '').trim()
    if (!TEAM_DONE.has(adS.toLowerCase()))  { const k = adS  || 'Not set'; ad[k]  = (ad[k]  ?? 0) + 1 }
    if (!TEAM_DONE.has(webS.toLowerCase())) { const k = webS || 'Not set'; web[k] = (web[k] ?? 0) + 1 }
  }
  return { ad, web }
}

const isEnSub = (name: string) => /\b(en|english)\b/i.test(name ?? '')

const avgDaysArr = (arr: number[]) =>
  arr.length > 0 ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : null

const hasLangTerm = (name: string, terms: string[]): boolean => {
  const n = name.toLowerCase()
  return terms.some(term => new RegExp(`\\b${term.replace(/[-/]/g, '[\\-/]')}\\b`, 'i').test(n))
}

const NEW_WAVE_LANGS: Record<number, string[]> = {
  2: ['france', 'fr', 'french', 'netherlands', 'nl', 'dutch', 'italy', 'it', 'italian'],
  3: ['finland', 'fi', 'finnish', 'sweden', 'se', 'swedish', 'norway', 'no', 'norwegian'],
  4: ['israel', 'il', 'hebrew', 'brazil', 'br', 'portuguese', 'pt', 'pt-br', 'japan', 'jp', 'japanese', 'ja'],
  5: ['denmark', 'dk', 'danish', 'da', 'czech republic', 'czech', 'cz', 'cs', 'poland', 'pl', 'polish'],
  6: ['turkey', 'türkiye', 'tr', 'turkish', 'lithuania', 'lt', 'lithuanian', 'estonia', 'ee', 'estonian', 'et'],
  7: ['slovakia', 'sk', 'slovak', 'slovenia', 'si', 'slovenian', 'sl', 'romania', 'ro', 'romanian'],
}

export async function computeWavesReport(): Promise<WaveReportData> {
  // Current week bounds (Mon–Sun)
  const ws = new Date()
  const day = ws.getDay()
  ws.setDate(ws.getDate() + (day === 0 ? -6 : 1 - day))
  ws.setHours(0, 0, 0, 0)
  const we = new Date(ws)
  we.setDate(we.getDate() + 6)
  we.setHours(23, 59, 59, 999)

  const { data: waves12 } = await supabase
    .from('monday_waves').select('id, wave_number').in('wave_number', [1, 2])
  const wave1Id = (waves12 ?? []).find((w: any) => w.wave_number === 1)?.id
  const wave2Id = (waves12 ?? []).find((w: any) => w.wave_number === 2)?.id

  const [w1Res, w2Res, testedRes, enSubsRes] = await Promise.all([
    wave1Id
      ? supabase.from('monday_items').select('id', { count: 'exact', head: true }).eq('wave_id', wave1Id)
      : Promise.resolve({ count: 0 }),
    wave2Id
      ? supabase.from('monday_items').select('id', { count: 'exact', head: true }).eq('wave_id', wave2Id)
      : Promise.resolve({ count: 0 }),
    wave1Id
      ? supabase.from('monday_items').select('id', { count: 'exact', head: true }).eq('wave_id', wave1Id).ilike('landing_page_status', 'launched')
      : Promise.resolve({ count: 0 }),
    wave1Id
      ? supabase.from('monday_subitems')
          .select('name, product_name, lp_building_at, lp_ready_at, lp_proofread_at, lp_ready_to_launch_at, website_status, ad_status, monday_items!inner(wave_id)')
          .eq('monday_items.wave_id', wave1Id)
      : Promise.resolve({ data: [] }),
  ])

  const wave1Count   = (w1Res  as any).count ?? 0
  const wave2Count   = (w2Res  as any).count ?? 0
  const totalCohort  = wave1Count + wave2Count
  const pctWave1ToWave2 = totalCohort > 0 ? Math.round(wave2Count / totalCohort * 100) : null
  const productsTested  = (testedRes as any).count ?? 0
  const allWave1Subs: any[] = (enSubsRes as any).data ?? []

  // Phase timing for Wave 1
  const enSubs    = allWave1Subs.filter((s: any) => isEnSub(s.name ?? ''))
  const nonEnSubs = allWave1Subs.filter((s: any) => !isEnSub(s.name ?? ''))

  const enPhase1Days = enSubs.map((s: any) => {
    if (!s.lp_building_at || !s.lp_ready_at) return null
    const d = (new Date(s.lp_ready_at).getTime() - new Date(s.lp_building_at).getTime()) / 86_400_000
    return d > 0 ? d : null
  }).filter((d): d is number => d !== null)

  const proofreadDays = nonEnSubs.map((s: any) => {
    if (!s.lp_proofread_at || !s.lp_ready_to_launch_at) return null
    const d = (new Date(s.lp_ready_to_launch_at).getTime() - new Date(s.lp_proofread_at).getTime()) / 86_400_000
    return d > 0 ? d : null
  }).filter((d): d is number => d !== null)

  const allPhase1Days = allWave1Subs.map((s: any) => {
    if (!s.lp_building_at || !s.lp_ready_at) return null
    const d = (new Date(s.lp_ready_at).getTime() - new Date(s.lp_building_at).getTime()) / 86_400_000
    return d > 0 ? d : null
  }).filter((d): d is number => d !== null)

  const avgDaysSpotToEnTest = avgDaysArr(enPhase1Days)
  const avgDaysProofread    = avgDaysArr(proofreadDays)
  const avgDaysEnToOthers   = avgDaysArr(allPhase1Days)

  // Waves 2–7
  const { data: waves27 } = await supabase
    .from('monday_waves').select('id, wave_number').in('wave_number', [2, 3, 4, 5, 6, 7])
  const waveIdMap: Record<number, string> = {}
  for (const w of (waves27 ?? [])) waveIdMap[(w as any).wave_number] = (w as any).id
  const waveIds27 = Object.values(waveIdMap)

  const [waveSubsResults, waveItemCountResults, subsWithItemsResult, teamQueueSubs27Result] = await Promise.all([
    Promise.all(
      [2, 3, 4, 5, 6, 7].map(wn =>
        waveIdMap[wn]
          ? supabase.from('monday_subitems')
              .select('name, lp_building_at, lp_ready_at, monday_items!inner(wave_id)')
              .eq('monday_items.wave_id', waveIdMap[wn])
          : Promise.resolve({ data: [] })
      )
    ),
    Promise.all(
      [2, 3, 4, 5, 6, 7].map(wn =>
        waveIdMap[wn]
          ? supabase.from('monday_items').select('id', { count: 'exact', head: true }).eq('wave_id', waveIdMap[wn])
          : Promise.resolve({ count: 0 })
      )
    ),
    waveIds27.length > 0
      ? supabase.from('monday_subitems')
          .select('monday_items!inner(id, name, wave_id)')
          .in('monday_items.wave_id', waveIds27)
          .or('website_status.ilike.%launched%,website_status.ilike.%running%,ad_status.ilike.%launched%,ad_status.ilike.%running%')
      : Promise.resolve({ data: [] }),
    waveIds27.length > 0
      ? supabase.from('monday_subitems')
          .select('ad_status, website_status, product_name, monday_items!inner(wave_id)')
          .in('monday_items.wave_id', waveIds27)
      : Promise.resolve({ data: [] }),
  ])

  const totalActiveProducts = waveItemCountResults.reduce((sum, r) => sum + (((r as any).count) ?? 0), 0)
  const totalLangVersions   = waveSubsResults.reduce((sum, r) => sum + (((r as any).data?.length) ?? 0), 0)
  const avgLangsPerProduct  = totalActiveProducts > 0
    ? Math.round((totalLangVersions / totalActiveProducts) * 10) / 10
    : null

  const itemLangCounts: Record<string, { name: string; count: number }> = {}
  for (const s of ((subsWithItemsResult as any).data ?? [])) {
    const item = (s as any).monday_items
    if (!item?.id) continue
    if (!itemLangCounts[item.id]) itemLangCounts[item.id] = { name: item.name ?? 'Unknown', count: 0 }
    itemLangCounts[item.id].count++
  }
  const langEntries   = Object.values(itemLangCounts)
  const mostLangsProduct = langEntries.length > 0
    ? langEntries.reduce((best, cur) => cur.count > best.count ? cur : best)
    : null
  const activeWinners = {
    small:  langEntries.filter(e => e.count >= 1  && e.count <= 7).length,
    medium: langEntries.filter(e => e.count >= 8  && e.count <= 15).length,
    big:    langEntries.filter(e => e.count >= 16).length,
  }

  const newWaveCampaignAvgDays = [2, 3, 4, 5, 6, 7].map((wn, idx) => {
    const subs: any[] = ((waveSubsResults[idx] as any).data ?? [])
    const terms = NEW_WAVE_LANGS[wn]
    const days = subs
      .filter((s: any) => hasLangTerm(s.name ?? '', terms))
      .map((s: any) => {
        if (!s.lp_building_at || !s.lp_ready_at) return null
        const d = (new Date(s.lp_ready_at).getTime() - new Date(s.lp_building_at).getTime()) / 86_400_000
        return d > 0 ? d : null
      })
      .filter((d): d is number => d !== null)
    return { wave: wn, avg: avgDaysArr(days) }
  })

  const teamQueue = {
    wave1:   computeTeamQueue(allWave1Subs),
    waves27: computeTeamQueue((teamQueueSubs27Result as any).data ?? []),
  }

  // Sales data
  const [{ data: langSalesData }, { data: productSalesData }] = await Promise.all([
    supabase.from('language_sales').select('lang_code, net_sales, cogs, updated_at'),
    supabase.from('product_sales').select('net_sales, updated_at'),
  ])
  const totalLaunches      = langSalesData?.length ?? 0
  const profitableLaunches = (langSalesData ?? []).filter((r: any) => r.net_sales > r.cogs).length
  const profitableLaunchPct = totalLaunches > 0
    ? Math.round((profitableLaunches / totalLaunches) * 100)
    : null
  const salesDataUpdatedAt    = langSalesData?.[0]?.updated_at ?? null
  const productSalesRows      = productSalesData ?? []
  const totalProductRevenue   = productSalesRows.reduce((sum, r: any) => sum + (r.net_sales ?? 0), 0)
  const activeWinnerCount     = productSalesRows.length
  const avgRevenuePerWinner   = activeWinnerCount > 0
    ? Math.round(totalProductRevenue / activeWinnerCount)
    : null
  const productSalesUpdatedAt = productSalesRows[0]?.updated_at ?? null

  // Proofread queue
  const { data: activeProofProducts } = await supabase
    .from('proof_products').select('product_name').eq('done', false)
  const proofProductNames = new Set(
    (activeProofProducts ?? []).map((p: any) => p.product_name?.trim().toLowerCase()).filter(Boolean)
  )
  const proofreadQueue = allWave1Subs.filter((s: any) => {
    if (isEnSub(s.name ?? '')) return false
    const web = s.website_status?.toLowerCase() ?? ''
    const ads = s.ad_status?.toLowerCase() ?? ''
    if (!web.includes('proofread') && !ads.includes('proofread')) return false
    return proofProductNames.has(s.product_name?.trim().toLowerCase())
  }).length
  const proofreadQueueWaves27 = ((teamQueueSubs27Result as any).data ?? []).filter((s: any) => {
    const web = s.website_status?.toLowerCase() ?? ''
    const ads = s.ad_status?.toLowerCase() ?? ''
    if (!web.includes('proofread') && !ads.includes('proofread')) return false
    return proofProductNames.has(s.product_name?.trim().toLowerCase())
  }).length

  // "New languages launched this week" — across all products, all waves. Counts subitems whose
  // ad AND website status are both now launched/running but weren't both at the last cron snapshot.
  const { data: allSubsForLaunchCounter } = await supabase
    .from('monday_subitems')
    .select('ad_status, website_status, last_snapshot_ad_status, last_snapshot_website_status')
  const newLanguagesLaunchedThisWeek = (allSubsForLaunchCounter ?? []).filter((s: any) => {
    const nowLaunched = isLaunchedStatus(s.ad_status) && isLaunchedStatus(s.website_status)
    if (!nowLaunched) return false
    const wasLaunched = isLaunchedStatus(s.last_snapshot_ad_status) && isLaunchedStatus(s.last_snapshot_website_status)
    return !wasLaunched
  }).length

  return {
    weekStart: ws.toISOString(),
    weekEnd:   we.toISOString(),
    wave1Total: wave1Count,
    wave1ToWave2Count: wave2Count,
    pctWave1ToWave2,
    productsTested,
    avgDaysSpotToEnTest,
    avgDaysProofread,
    avgDaysEnToOthers,
    proofreadQueue,
    proofreadQueueWaves27,
    newWaveCampaignAvgDays,
    avgLangsPerProduct,
    mostLangsProduct,
    activeWinners,
    profitableLaunchPct,
    profitableLaunches,
    totalLaunches,
    salesDataUpdatedAt,
    avgRevenuePerWinner,
    activeWinnerCount,
    productSalesUpdatedAt,
    teamQueue,
    newLanguagesLaunchedThisWeek,
  }
}
