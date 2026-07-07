import cron from 'node-cron'
import { supabase } from '../supabase'
import { computeWavesReport } from '../utils/computeWavesReport'
import { getDateTimeInTimezone } from '../utils/timezone'

export interface MonthlyCronSchedule {
  dayOfMonth: number // 1–28
  hour:       number // 0–23
  minute:     number // 0–59
  timezone:   string // IANA, e.g. "Asia/Manila"
}

export async function getMonthlyCronSchedule(): Promise<MonthlyCronSchedule> {
  const { data } = await supabase
    .from('proof_notification_settings')
    .select('value')
    .eq('key', 'wave_report_monthly_cron')
    .single()
  try {
    const p = JSON.parse(data?.value ?? '{}')
    return {
      dayOfMonth: typeof p.dayOfMonth === 'number' ? p.dayOfMonth : 28,
      hour:       typeof p.hour       === 'number' ? p.hour       : 22,
      minute:     typeof p.minute     === 'number' ? p.minute     : 0,
      timezone:   typeof p.timezone   === 'string' ? p.timezone   : 'Asia/Manila',
    }
  } catch {
    return { dayOfMonth: 28, hour: 22, minute: 0, timezone: 'Asia/Manila' }
  }
}

function monthBoundsInTimezone(tz: string): { monthStart: string; monthEnd: string } {
  const now = getDateTimeInTimezone(tz)

  const first = new Date(now.year, now.month, 1)
  const last  = new Date(now.year, now.month + 1, 0)

  const pad = (n: number) => String(n).padStart(2, '0')
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

  return { monthStart: fmt(first), monthEnd: fmt(last) }
}

export async function runWaveReportMonthlySnapshot(): Promise<void> {
  console.log('[wave-report-monthly-cron] running snapshot…')
  try {
    const schedule = await getMonthlyCronSchedule()
    const { monthStart, monthEnd } = monthBoundsInTimezone(schedule.timezone)
    const reportData = await computeWavesReport('month')

    const { error } = await supabase
      .from('wave_report_monthly_snapshots')
      .upsert(
        { month_start: monthStart, month_end: monthEnd, data: reportData },
        { onConflict: 'month_start' }
      )

    if (error) {
      console.error('[wave-report-monthly-cron] upsert error:', error.message)
    } else {
      console.log(`[wave-report-monthly-cron] snapshot saved for month ${monthStart}`)
    }

    await resetMonthlyLaunchCounterBaseline()
  } catch (err) {
    console.error('[wave-report-monthly-cron] error:', err)
  }
}

// Captures current ad/website status as the new monthly baseline so "New languages launched
// this month" starts counting from 0 again until the next status change.
async function resetMonthlyLaunchCounterBaseline(): Promise<void> {
  const { data: subs, error: fetchError } = await supabase
    .from('monday_subitems')
    .select('id, item_id, name, ad_status, website_status')

  if (fetchError) {
    console.error('[wave-report-monthly-cron] baseline fetch error:', fetchError.message)
    return
  }
  if (!subs || subs.length === 0) return

  // item_id/name are NOT NULL columns with no default — Postgres builds a full row to check
  // for conflicts, so an upsert missing them fails outright even though every row already exists.
  const updates = subs.map((s: any) => ({
    id: s.id,
    item_id: s.item_id,
    name: s.name,
    last_monthly_snapshot_ad_status: s.ad_status,
    last_monthly_snapshot_website_status: s.website_status,
  }))

  const { error: resetError } = await supabase
    .from('monday_subitems')
    .upsert(updates, { onConflict: 'id' })

  if (resetError) {
    console.error('[wave-report-monthly-cron] baseline reset error:', resetError.message)
  } else {
    console.log(`[wave-report-monthly-cron] baseline reset for ${updates.length} subitems`)
  }
}

export function startWaveReportMonthlyCron(): void {
  // Check every minute if it's time to snapshot
  cron.schedule('* * * * *', async () => {
    try {
      const schedule = await getMonthlyCronSchedule()
      const now = getDateTimeInTimezone(schedule.timezone)
      if (now.dayOfMonth === schedule.dayOfMonth && now.hour === schedule.hour && now.minute === schedule.minute) {
        await runWaveReportMonthlySnapshot()
      }
    } catch (err) {
      console.error('[wave-report-monthly-cron] scheduler tick error:', err)
    }
  })
  console.log('[wave-report-monthly-cron] scheduler started')
}
