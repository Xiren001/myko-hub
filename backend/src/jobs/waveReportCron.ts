import cron from 'node-cron'
import { supabase } from '../supabase'
import { computeWavesReport } from '../utils/computeWavesReport'

export interface CronSchedule {
  day:      number  // 0=Sun … 6=Sat
  hour:     number  // 0–23
  minute:   number  // 0–59
  timezone: string  // IANA, e.g. "Asia/Manila"
}

export async function getCronSchedule(): Promise<CronSchedule> {
  const { data } = await supabase
    .from('proof_notification_settings')
    .select('value')
    .eq('key', 'wave_report_cron')
    .single()
  try {
    const p = JSON.parse(data?.value ?? '{}')
    return {
      day:      typeof p.day      === 'number' ? p.day      : 6,
      hour:     typeof p.hour     === 'number' ? p.hour     : 22,
      minute:   typeof p.minute   === 'number' ? p.minute   : 0,
      timezone: typeof p.timezone === 'string' ? p.timezone : 'Asia/Manila',
    }
  } catch {
    return { day: 6, hour: 22, minute: 0, timezone: 'Asia/Manila' }
  }
}

function getCurrentInTimezone(tz: string): { day: number; hour: number; minute: number } {
  const now   = new Date()
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday:  'short',
    hour:     '2-digit',
    minute:   '2-digit',
    hour12:   false,
  }).formatToParts(now)

  const get = (type: string) => parts.find(p => p.type === type)?.value ?? ''
  const DAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

  return {
    day:    DAY[get('weekday')] ?? 0,
    hour:   parseInt(get('hour'))   || 0,
    minute: parseInt(get('minute')) || 0,
  }
}

function weekBoundsInTimezone(tz: string): { weekStart: string; weekEnd: string } {
  const now = new Date()
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(now)
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? ''
  const DAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

  const year  = parseInt(get('year'))
  const month = parseInt(get('month')) - 1
  const date  = parseInt(get('day'))
  const dow   = DAY[get('weekday')] ?? 0

  const mondayOffset = dow === 0 ? -6 : 1 - dow
  const mon = new Date(year, month, date + mondayOffset)
  const sun = new Date(year, month, date + mondayOffset + 6)

  const pad = (n: number) => String(n).padStart(2, '0')
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

  return { weekStart: fmt(mon), weekEnd: fmt(sun) }
}

export async function runWaveReportSnapshot(): Promise<void> {
  console.log('[wave-report-cron] running snapshot…')
  try {
    const schedule = await getCronSchedule()
    const { weekStart, weekEnd } = weekBoundsInTimezone(schedule.timezone)
    const reportData = await computeWavesReport()

    const { error } = await supabase
      .from('wave_report_snapshots')
      .upsert(
        { week_start: weekStart, week_end: weekEnd, data: reportData },
        { onConflict: 'week_start' }
      )

    if (error) {
      console.error('[wave-report-cron] upsert error:', error.message)
    } else {
      console.log(`[wave-report-cron] snapshot saved for week ${weekStart}`)
    }

    await resetLaunchCounterBaseline()
  } catch (err) {
    console.error('[wave-report-cron] error:', err)
  }
}

// Captures current ad/website status as the new baseline so "New languages launched
// this week" starts counting from 0 again until the next status change.
async function resetLaunchCounterBaseline(): Promise<void> {
  const { data: subs, error: fetchError } = await supabase
    .from('monday_subitems')
    .select('id, ad_status, website_status')

  if (fetchError) {
    console.error('[wave-report-cron] baseline fetch error:', fetchError.message)
    return
  }
  if (!subs || subs.length === 0) return

  const updates = subs.map((s: any) => ({
    id: s.id,
    last_snapshot_ad_status: s.ad_status,
    last_snapshot_website_status: s.website_status,
  }))

  const { error: resetError } = await supabase
    .from('monday_subitems')
    .upsert(updates, { onConflict: 'id' })

  if (resetError) {
    console.error('[wave-report-cron] baseline reset error:', resetError.message)
  } else {
    console.log(`[wave-report-cron] baseline reset for ${updates.length} subitems`)
  }
}

export function startWaveReportCron(): void {
  // Check every minute if it's time to snapshot
  cron.schedule('* * * * *', async () => {
    try {
      const schedule = await getCronSchedule()
      const now = getCurrentInTimezone(schedule.timezone)
      if (now.day === schedule.day && now.hour === schedule.hour && now.minute === schedule.minute) {
        await runWaveReportSnapshot()
      }
    } catch (err) {
      console.error('[wave-report-cron] scheduler tick error:', err)
    }
  })
  console.log('[wave-report-cron] scheduler started')
}
