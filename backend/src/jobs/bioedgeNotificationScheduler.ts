import cron from 'node-cron'
import { supabase } from '../supabase'
import { sendBioedgeNotificationsForLanguage } from './bioedgeNotifier'

export async function getBioedgeDelayMinutes(): Promise<number> {
  const { data } = await supabase
    .from('bioedge_notification_settings')
    .select('value')
    .eq('key', 'delay_minutes')
    .single()
  const parsed = parseInt(data?.value ?? '1', 10)
  return isNaN(parsed) || parsed < 0 ? 1 : parsed
}

export async function enqueueBioedgeNotification(language: string): Promise<void> {
  const delayMinutes = await getBioedgeDelayMinutes()
  const scheduledFor = new Date(Date.now() + delayMinutes * 60 * 1000).toISOString()

  await supabase.from('bioedge_notification_queue').upsert(
    { language, scheduled_for: scheduledFor, status: 'pending', updated_at: new Date().toISOString() },
    { onConflict: 'language' }
  )
}

export function startBioedgeNotificationScheduler(): void {
  cron.schedule('* * * * *', async () => {
    try {
      const now = new Date().toISOString()

      const { data: due } = await supabase
        .from('bioedge_notification_queue')
        .select('language, scheduled_for')
        .eq('status', 'pending')
        .lte('scheduled_for', now)

      if (!due?.length) return

      for (const entry of due) {
        // Mark sent before processing to prevent double-send on overlap
        await supabase
          .from('bioedge_notification_queue')
          .update({ status: 'sent', updated_at: new Date().toISOString() })
          .eq('language', entry.language)
          .eq('status', 'pending') // guard: only update if still pending

        const result = await sendBioedgeNotificationsForLanguage(entry.language)
        console.log(`[bioedge-notify] ${entry.language}: sent=${result.sent} count=${result.count}${result.reason ? ` (${result.reason})` : ''}`)
      }
    } catch (err) {
      console.error('[bioedge-notify] scheduler error:', err)
    }
  })

  console.log('[bioedge-notify] scheduler started')
}
