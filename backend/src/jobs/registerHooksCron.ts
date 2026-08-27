import cron from 'node-cron'
import { registerMondayHooks } from '../routes/monday'

// Monday.com webhook subscriptions can silently expire or get dropped, which stops
// ad_status/website_status updates from reaching the DB until someone notices stale
// data and re-registers manually. This re-registers them automatically twice a day
// so that gap closes itself instead of requiring a manual "Register Hooks" click.
export function startRegisterHooksCron(): void {
  cron.schedule('0 6,18 * * *', async () => {
    console.log('[register-hooks-cron] re-registering Monday webhooks…')
    try {
      const results = await registerMondayHooks()
      const boards = Object.keys(results)
      const ok = boards.filter(b => (results[b] as any)?.id).length
      console.log(`[register-hooks-cron] done: ${ok}/${boards.length} boards`)
    } catch (err) {
      console.error('[register-hooks-cron] error:', err)
    }
  }, { timezone: 'Asia/Manila' })
  console.log('[register-hooks-cron] scheduler started')
}
