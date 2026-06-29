"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getCronSchedule = getCronSchedule;
exports.runWaveReportSnapshot = runWaveReportSnapshot;
exports.startWaveReportCron = startWaveReportCron;
const node_cron_1 = __importDefault(require("node-cron"));
const supabase_1 = require("../supabase");
const computeWavesReport_1 = require("../utils/computeWavesReport");
async function getCronSchedule() {
    const { data } = await supabase_1.supabase
        .from('proof_notification_settings')
        .select('value')
        .eq('key', 'wave_report_cron')
        .single();
    try {
        const p = JSON.parse(data?.value ?? '{}');
        return {
            day: typeof p.day === 'number' ? p.day : 6,
            hour: typeof p.hour === 'number' ? p.hour : 22,
            minute: typeof p.minute === 'number' ? p.minute : 0,
            timezone: typeof p.timezone === 'string' ? p.timezone : 'Asia/Manila',
        };
    }
    catch {
        return { day: 6, hour: 22, minute: 0, timezone: 'Asia/Manila' };
    }
}
function getCurrentInTimezone(tz) {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).formatToParts(now);
    const get = (type) => parts.find(p => p.type === type)?.value ?? '';
    const DAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return {
        day: DAY[get('weekday')] ?? 0,
        hour: parseInt(get('hour')) || 0,
        minute: parseInt(get('minute')) || 0,
    };
}
function weekBoundsInTimezone(tz) {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
    }).formatToParts(now);
    const get = (type) => parts.find(p => p.type === type)?.value ?? '';
    const DAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const year = parseInt(get('year'));
    const month = parseInt(get('month')) - 1;
    const date = parseInt(get('day'));
    const dow = DAY[get('weekday')] ?? 0;
    const mondayOffset = dow === 0 ? -6 : 1 - dow;
    const mon = new Date(year, month, date + mondayOffset);
    const sun = new Date(year, month, date + mondayOffset + 6);
    const pad = (n) => String(n).padStart(2, '0');
    const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    return { weekStart: fmt(mon), weekEnd: fmt(sun) };
}
async function runWaveReportSnapshot() {
    console.log('[wave-report-cron] running snapshot…');
    try {
        const schedule = await getCronSchedule();
        const { weekStart, weekEnd } = weekBoundsInTimezone(schedule.timezone);
        const reportData = await (0, computeWavesReport_1.computeWavesReport)();
        const { error } = await supabase_1.supabase
            .from('wave_report_snapshots')
            .upsert({ week_start: weekStart, week_end: weekEnd, data: reportData }, { onConflict: 'week_start' });
        if (error) {
            console.error('[wave-report-cron] upsert error:', error.message);
        }
        else {
            console.log(`[wave-report-cron] snapshot saved for week ${weekStart}`);
        }
    }
    catch (err) {
        console.error('[wave-report-cron] error:', err);
    }
}
function startWaveReportCron() {
    // Check every minute if it's time to snapshot
    node_cron_1.default.schedule('* * * * *', async () => {
        try {
            const schedule = await getCronSchedule();
            const now = getCurrentInTimezone(schedule.timezone);
            if (now.day === schedule.day && now.hour === schedule.hour && now.minute === schedule.minute) {
                await runWaveReportSnapshot();
            }
        }
        catch (err) {
            console.error('[wave-report-cron] scheduler tick error:', err);
        }
    });
    console.log('[wave-report-cron] scheduler started');
}
