"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDelayMinutes = getDelayMinutes;
exports.enqueueNotification = enqueueNotification;
exports.startNotificationScheduler = startNotificationScheduler;
const node_cron_1 = __importDefault(require("node-cron"));
const supabase_1 = require("../supabase");
const proofNotifier_1 = require("./proofNotifier");
async function getDelayMinutes() {
    const { data } = await supabase_1.supabase
        .from('proof_notification_settings')
        .select('value')
        .eq('key', 'delay_minutes')
        .single();
    const parsed = parseInt(data?.value ?? '1', 10);
    return isNaN(parsed) || parsed < 0 ? 1 : parsed;
}
async function enqueueNotification(language) {
    const delayMinutes = await getDelayMinutes();
    const scheduledFor = new Date(Date.now() + delayMinutes * 60 * 1000).toISOString();
    await supabase_1.supabase.from('proof_notification_queue').upsert({ language, scheduled_for: scheduledFor, status: 'pending', updated_at: new Date().toISOString() }, { onConflict: 'language' });
}
function startNotificationScheduler() {
    node_cron_1.default.schedule('* * * * *', async () => {
        try {
            const now = new Date().toISOString();
            const { data: due } = await supabase_1.supabase
                .from('proof_notification_queue')
                .select('language, scheduled_for')
                .eq('status', 'pending')
                .lte('scheduled_for', now);
            if (!due?.length)
                return;
            for (const entry of due) {
                // Mark sent before processing to prevent double-send on overlap
                await supabase_1.supabase
                    .from('proof_notification_queue')
                    .update({ status: 'sent', updated_at: new Date().toISOString() })
                    .eq('language', entry.language)
                    .eq('status', 'pending'); // guard: only update if still pending
                const result = await (0, proofNotifier_1.sendProofNotificationsForLanguage)(entry.language);
                console.log(`[proof-notify] ${entry.language}: sent=${result.sent} count=${result.count}${result.reason ? ` (${result.reason})` : ''}`);
            }
        }
        catch (err) {
            console.error('[proof-notify] scheduler error:', err);
        }
    });
    console.log('[proof-notify] scheduler started');
}
