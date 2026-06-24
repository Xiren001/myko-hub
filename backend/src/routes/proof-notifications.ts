import { Router, Response } from 'express'
import { supabase } from '../supabase'
import { authenticate, requireAdmin, AuthRequest } from '../middleware/auth'
import { sendProofNotificationsForLanguage } from '../jobs/proofNotifier'

const router = Router()

// GET /api/proof-notifications/config
// Returns all languages in proof_products, their assigned emails, delay, and pending counts
router.get('/config', authenticate, requireAdmin, async (_req: AuthRequest, res: Response) => {
  const [emailsRes, settingsRes, pendingRes, allLangsRes] = await Promise.all([
    supabase.from('proof_notification_emails').select('language, emails'),
    supabase.from('proof_notification_settings').select('key, value'),
    supabase.from('proof_products').select('language').eq('done', false).is('notified_at', null).not('language', 'is', null),
    supabase.from('proof_products').select('language').not('language', 'is', null),
  ])

  const emailMap: Record<string, string[]> = {}
  for (const row of emailsRes.data ?? []) {
    emailMap[row.language] = row.emails
  }

  const settingsMap: Record<string, string> = {}
  for (const row of settingsRes.data ?? []) {
    settingsMap[row.key] = row.value
  }

  const pendingCount: Record<string, number> = {}
  for (const row of pendingRes.data ?? []) {
    if (row.language) pendingCount[row.language] = (pendingCount[row.language] ?? 0) + 1
  }

  const languages = [...new Set((allLangsRes.data ?? []).map(r => r.language).filter(Boolean))].sort() as string[]

  return res.json({
    languages,
    emailMap,
    delayMinutes: parseInt(settingsMap['delay_minutes'] ?? '1', 10),
    pendingCount,
  })
})

// PUT /api/proof-notifications/emails
// Update email list for a language
router.put('/emails', authenticate, requireAdmin, async (req: AuthRequest, res: Response) => {
  const { language, emails } = req.body
  if (!language || !Array.isArray(emails)) {
    return res.status(400).json({ error: 'language and emails[] required' })
  }

  const { error } = await supabase
    .from('proof_notification_emails')
    .upsert(
      { language, emails, updated_at: new Date().toISOString() },
      { onConflict: 'language' }
    )

  if (error) return res.status(500).json({ error: error.message })
  return res.json({ ok: true })
})

// PUT /api/proof-notifications/delay
// Update the debounce delay setting
router.put('/delay', authenticate, requireAdmin, async (req: AuthRequest, res: Response) => {
  const { delayMinutes } = req.body
  if (typeof delayMinutes !== 'number' || delayMinutes < 0) {
    return res.status(400).json({ error: 'delayMinutes must be a non-negative number' })
  }

  const { error } = await supabase
    .from('proof_notification_settings')
    .upsert({ key: 'delay_minutes', value: String(delayMinutes) }, { onConflict: 'key' })

  if (error) return res.status(500).json({ error: error.message })
  return res.json({ ok: true })
})

// POST /api/proof-notifications/send
// Manual send — body: { language: string }
router.post('/send', authenticate, requireAdmin, async (req: AuthRequest, res: Response) => {
  const { language } = req.body
  if (!language) return res.status(400).json({ error: 'language required' })

  const result = await sendProofNotificationsForLanguage(language)
  return res.json(result)
})

export default router
