import cron from 'node-cron'
import { supabase } from '../supabase'
import { computeWavesReport } from '../utils/computeWavesReport'
import { getDateTimeInTimezone } from '../utils/timezone'

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

function weekBoundsInTimezone(tz: string): { weekStart: string; weekEnd: string } {
  const now = getDateTimeInTimezone(tz)

  const mondayOffset = now.weekday === 0 ? -6 : 1 - now.weekday
  const mon = new Date(now.year, now.month, now.dayOfMonth + mondayOffset)
  const sun = new Date(now.year, now.month, now.dayOfMonth + mondayOffset + 6)

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
    .select('id, item_id, name, ad_status, website_status')

  if (fetchError) {
    console.error('[wave-report-cron] baseline fetch error:', fetchError.message)
    return
  }
  if (!subs || subs.length === 0) return

  // item_id/name are NOT NULL columns with no default — Postgres builds a full row to check
  // for conflicts, so an upsert missing them fails outright even though every row already exists.
  const updates = subs.map((s: any) => ({
    id: s.id,
    item_id: s.item_id,
    name: s.name,
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
      const now = getDateTimeInTimezone(schedule.timezone)
      if (now.weekday === schedule.day && now.hour === schedule.hour && now.minute === schedule.minute) {
        await runWaveReportSnapshot()
      }
    } catch (err) {
      console.error('[wave-report-cron] scheduler tick error:', err)
    }
  })
  console.log('[wave-report-cron] scheduler started')
}
