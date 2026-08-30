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
    wave1:   { ad: Record<string, TeamQueueBucket>; web: Record<string, TeamQueueBucket> }
    waves27: { ad: Record<string, TeamQueueBucket>; web: Record<string, TeamQueueBucket> }
  }
  newLanguagesLaunchedThisWeek: number
  newLanguagesLaunchedList: { product: string; language: string }[]
}

export interface TeamQueueEntry {
  id: string
  label: string
  link: string | null
  count: number
  addedAt: string | null
}

export interface TeamQueueBucket {
  count: number
  entries: TeamQueueEntry[]
}

const TEAM_DONE = new Set(['launched', 'stopped', 'banned', 'do not start', 'running', 'ready to launch'])
const LAUNCHED_STATES = new Set(['launched', 'running'])
const isLaunchedStatus = (s: string | null | undefined) => LAUNCHED_STATES.has((s ?? '').trim().toLowerCase())

function pushTeamQueueEntry(map: Record<string, TeamQueueBucket>, statusKey: string, s: any, addedAt: string | null) {
  const bucket = map[statusKey] ?? (map[statusKey] = { count: 0, entries: [] })
  bucket.count++

  const productName = (s.product_name ?? '').trim()
  const market = (s.name ?? '').trim()
  if (productName) {
    bucket.entries.push({
      id: s.id,
      label: market ? `${productName} · ${market}` : productName,
      link: s.page_link || null,
      count: 1,
      addedAt,
    })
    return
  }

  // No product name on the sub-item itself — group under the parent item instead
  const item = s.monday_items
  const groupId = `item-${item?.id ?? 'unknown'}`
  const existing = bucket.entries.find(e => e.id === groupId)
  if (existing) { existing.count++; return }
  bucket.entries.push({ id: groupId, label: item?.name ?? 'Unknown item', link: null, count: 1, addedAt })
}

function computeTeamQueue(subs: any[]): { ad: Record<string, TeamQueueBucket>; web: Record<string, TeamQueueBucket> } {
  const ad: Record<string, TeamQueueBucket> = {}
  const web: Record<string, TeamQueueBucket> = {}
  for (const s of subs) {
    const adS  = (s.ad_status  ?? '').trim()
    const webS = (s.website_status ?? '').trim()
    if (!TEAM_DONE.has(adS.toLowerCase()))  pushTeamQueueEntry(ad,  adS  || 'Not set', s, s.ad_status_changed_at ?? null)
    if (!TEAM_DONE.has(webS.toLowerCase())) pushTeamQueueEntry(web, webS || 'Not set', s, s.website_status_changed_at ?? null)
  }
  for (const bucket of [...Object.values(ad), ...Object.values(web)]) {
    bucket.entries.sort((a, b) => a.label.localeCompare(b.label))
  }
  return { ad, web }
}

// Snapshots saved before per-item entries existed only have `{ [status]: number }` —
// coerce those into the current bucket shape so old weeks still render. Snapshots saved
// before `addedAt` existed are missing it on each entry — default to null.
function normalizeQueueMap(map: Record<string, any> | undefined): Record<string, TeamQueueBucket> {
  const out: Record<string, TeamQueueBucket> = {}
  for (const [status, val] of Object.entries(map ?? {})) {
    const bucket: TeamQueueBucket = typeof val === 'number' ? { count: val, entries: [] } : val
    out[status] = { ...bucket, entries: bucket.entries.map(e => ({ ...e, addedAt: e.addedAt ?? null })) }
  }
  return out
}

export function normalizeTeamQueue<T extends { teamQueue?: any }>(data: T): T {
  if (!data?.teamQueue) return data
  return {
    ...data,
    teamQueue: {
      wave1: {
        ad:  normalizeQueueMap(data.teamQueue.wave1?.ad),
        web: normalizeQueueMap(data.teamQueue.wave1?.web),
      },
      waves27: {
        ad:  normalizeQueueMap(data.teamQueue.waves27?.ad),
        web: normalizeQueueMap(data.teamQueue.waves27?.web),
      },
    },
  }
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

export async function computeWavesReport(period: 'week' | 'month' = 'week'): Promise<WaveReportData> {
  // Current period bounds — Mon–Sun for 'week', 1st–last day of month for 'month'
  let ws: Date
  let we: Date
  if (period === 'month') {
    const now = new Date()
    ws = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0)
    we = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999)
  } else {
    ws = new Date()
    const day = ws.getDay()
    ws.setDate(ws.getDate() + (day === 0 ? -6 : 1 - day))
    ws.setHours(0, 0, 0, 0)
    we = new Date(ws)
    we.setDate(we.getDate() + 6)
    we.setHours(23, 59, 59, 999)
  }

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
          .select('id, name, product_name, page_link, lp_building_at, lp_ready_at, lp_proofread_at, lp_ready_to_launch_at, website_status, ad_status, ad_status_changed_at, website_status_changed_at, monday_items!inner(id, name, wave_id)')
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

  const [waveSubsResults, waveItemCountResults, subsWithItemsResult, teamQueueSubs27Result, runningItemsResult] = await Promise.all([
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
          .select('id, name, ad_status, website_status, ad_status_changed_at, website_status_changed_at, product_name, page_link, monday_items!inner(id, name, wave_id)')
          .in('monday_items.wave_id', waveIds27)
      : Promise.resolve({ data: [] }),
    waveIds27.length > 0
      ? supabase.from('monday_subitems')
          .select('monday_items!inner(id, name, wave_id)')
          .in('monday_items.wave_id', waveIds27)
          .or('ad_status.ilike.running,ad_status.ilike.launched')
          .or('website_status.ilike.running,website_status.ilike.launched')
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
    supabase.from('product_sales').select('product_title, net_sales, updated_at'),
  ])
  const totalLaunches      = langSalesData?.length ?? 0
  const profitableLaunches = (langSalesData ?? []).filter((r: any) => r.net_sales > r.cogs).length
  const profitableLaunchPct = totalLaunches > 0
    ? Math.round((profitableLaunches / totalLaunches) * 100)
    : null
  const salesDataUpdatedAt    = langSalesData?.[0]?.updated_at ?? null

  // Only Waves 2–7 products with at least one language whose ad + website status are both running/launched count as "active winners"
  const runningProductNames = new Set(
    ((runningItemsResult as any).data ?? [])
      .map((s: any) => (s as any).monday_items?.name?.trim().toLowerCase())
      .filter(Boolean)
  )
  const productSalesRows      = (productSalesData ?? []).filter((r: any) =>
    runningProductNames.has(r.product_title?.trim().toLowerCase())
  )
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

  // "New languages launched this week/month" — across all products, all waves. Counts subitems whose
  // ad AND website status are both now launched/running but weren't both at the last cron snapshot.
  // Week and month views track independent baselines so a monthly cron doesn't get reset by the
  // weekly one (and vice versa).
  const [baselineAdCol, baselineWebCol] = period === 'month'
    ? ['last_monthly_snapshot_ad_status', 'last_monthly_snapshot_website_status']
    : ['last_snapshot_ad_status', 'last_snapshot_website_status']
  const { data: allSubsForLaunchCounter } = await supabase
    .from('monday_subitems')
    .select(`name, product_name, ad_status, website_status, ${baselineAdCol}, ${baselineWebCol}`)
  const newlyLaunchedSubs = (allSubsForLaunchCounter ?? []).filter((s: any) => {
    const nowLaunched = isLaunchedStatus(s.ad_status) && isLaunchedStatus(s.website_status)
    if (!nowLaunched) return false
    const wasLaunched = isLaunchedStatus(s[baselineAdCol]) && isLaunchedStatus(s[baselineWebCol])
    return !wasLaunched
  })
  const newLanguagesLaunchedThisWeek = newlyLaunchedSubs.length
  const newLanguagesLaunchedList = newlyLaunchedSubs.map((s: any) => ({
    product: s.product_name?.trim() || 'Unknown',
    language: s.name?.trim() || 'Unknown',
  }))

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
    newLanguagesLaunchedList,
  }
}
