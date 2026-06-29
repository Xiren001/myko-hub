"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const supabase_1 = require("../supabase");
const auth_1 = require("../middleware/auth");
const proofNotifier_1 = require("../jobs/proofNotifier");
const notificationScheduler_1 = require("../jobs/notificationScheduler");
const router = (0, express_1.Router)();
// GET /api/proof-notifications/config
// Returns all languages in proof_products, their assigned emails, delay, and pending counts
router.get('/config', auth_1.authenticate, auth_1.requireAdmin, async (_req, res) => {
    const [emailsRes, settingsRes, pendingRes, allLangsRes] = await Promise.all([
        supabase_1.supabase.from('proof_notification_emails').select('language, emails'),
        supabase_1.supabase.from('proof_notification_settings').select('key, value'),
        supabase_1.supabase.from('proof_products').select('language').eq('done', false).is('notified_at', null).not('language', 'is', null),
        supabase_1.supabase.from('proof_products').select('language').not('language', 'is', null),
    ]);
    const emailMap = {};
    for (const row of emailsRes.data ?? []) {
        emailMap[row.language] = row.emails;
    }
    const settingsMap = {};
    for (const row of settingsRes.data ?? []) {
        settingsMap[row.key] = row.value;
    }
    const pendingCount = {};
    for (const row of pendingRes.data ?? []) {
        if (row.language)
            pendingCount[row.language] = (pendingCount[row.language] ?? 0) + 1;
    }
    const languages = [...new Set((allLangsRes.data ?? []).map(r => r.language).filter(Boolean))].sort();
    return res.json({
        languages,
        emailMap,
        delayMinutes: parseInt(settingsMap['delay_minutes'] ?? '1', 10),
        pendingCount,
    });
});
// PUT /api/proof-notifications/emails
// Update email list for a language
router.put('/emails', auth_1.authenticate, auth_1.requireAdmin, async (req, res) => {
    const { language, emails } = req.body;
    if (!language || !Array.isArray(emails)) {
        return res.status(400).json({ error: 'language and emails[] required' });
    }
    const { error } = await supabase_1.supabase
        .from('proof_notification_emails')
        .upsert({ language, emails, updated_at: new Date().toISOString() }, { onConflict: 'language' });
    if (error)
        return res.status(500).json({ error: error.message });
    return res.json({ ok: true });
});
// PUT /api/proof-notifications/delay
// Update the debounce delay setting
router.put('/delay', auth_1.authenticate, auth_1.requireAdmin, async (req, res) => {
    const { delayMinutes } = req.body;
    if (typeof delayMinutes !== 'number' || delayMinutes < 0) {
        return res.status(400).json({ error: 'delayMinutes must be a non-negative number' });
    }
    const { error } = await supabase_1.supabase
        .from('proof_notification_settings')
        .upsert({ key: 'delay_minutes', value: String(delayMinutes) }, { onConflict: 'key' });
    if (error)
        return res.status(500).json({ error: error.message });
    return res.json({ ok: true });
});
// PATCH /api/proof-notifications/products/:id/language
// Set language on a proof_product and auto-enqueue notification
router.patch('/products/:id/language', auth_1.authenticate, auth_1.requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { language } = req.body;
    if (!language || typeof language !== 'string') {
        return res.status(400).json({ error: 'language required' });
    }
    const { error } = await supabase_1.supabase
        .from('proof_products')
        .update({ language: language.toUpperCase() })
        .eq('id', id);
    if (error)
        return res.status(500).json({ error: error.message });
    (0, notificationScheduler_1.enqueueNotification)(language.toUpperCase()).catch(err => console.error('[proof-notify] enqueue error:', err));
    return res.json({ ok: true });
});
// POST /api/proof-notifications/send
// Manual send — body: { language: string }
router.post('/send', auth_1.authenticate, auth_1.requireAdmin, async (req, res) => {
    const { language } = req.body;
    if (!language)
        return res.status(400).json({ error: 'language required' });
    const result = await (0, proofNotifier_1.sendProofNotificationsForLanguage)(language);
    return res.json(result);
});
exports.default = router;
