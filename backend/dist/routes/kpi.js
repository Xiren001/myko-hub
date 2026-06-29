"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const supabase_1 = require("../supabase");
const auth_1 = require("../middleware/auth");
const calculations_1 = require("../utils/calculations");
const router = (0, express_1.Router)();
router.get('/', auth_1.authenticate, async (req, res) => {
    const { month } = req.query;
    const ms = month && typeof month === 'string' ? (0, calculations_1.monthStart)(month) : undefined;
    const me = month && typeof month === 'string' ? (0, calculations_1.monthEnd)(month) : undefined;
    let buildsQuery = supabase_1.supabase.from('builds').select('*');
    if (ms && me)
        buildsQuery = buildsQuery.gte('month_year', ms).lte('month_year', me);
    const { data: builds, error: bErr } = await buildsQuery;
    if (bErr)
        return res.status(500).json({ error: bErr.message });
    let mistakesQuery = supabase_1.supabase.from('mistakes').select('category');
    if (ms && me)
        mistakesQuery = mistakesQuery.gte('month_year', ms).lte('month_year', me);
    const { data: mistakes } = await mistakesQuery;
    const { data: settings } = await supabase_1.supabase.from('settings').select('*').eq('id', 1).single();
    const enriched = (builds ?? []).map(calculations_1.enrichBuild);
    const decided = enriched.filter(b => b.outcome_decided);
    const proofreadQueue = enriched.filter(b => b.into_proofread && !b.into_testing && b.outcome !== 'stopped');
    res.json({
        buildCycleAvg: (0, calculations_1.avg)(enriched.map(b => b.build_days)),
        proofCycleAvg: (0, calculations_1.avg)(enriched.map(b => b.proof_days)),
        testCycleAvg: (0, calculations_1.avg)(decided.map(b => b.test_days)),
        totalCycleAvg: (0, calculations_1.avg)(decided.map(b => b.total_days)),
        proofreadQueueDepth: proofreadQueue.length,
        proofreadFlagged: proofreadQueue.filter(b => {
            const days = b.proof_days ?? (b.into_proofread
                ? Math.round((Date.now() - new Date(b.into_proofread).getTime()) / 86400000)
                : 0);
            return days > (settings?.proof_target_days ?? 3);
        }).length,
        mistakesCount: (mistakes ?? []).length,
        translationFlags: (mistakes ?? []).filter(m => m.category === 'Translation / proofreading').length,
        funnelRedirectIssues: (mistakes ?? []).filter(m => m.category === 'Funnelish → Shopify checkout redirect (wrong/empty cart · lost variant)').length,
        targets: settings ?? {},
        phaseBreakdown: {
            building: enriched.filter(b => b.phase === 'building').length,
            proofread: enriched.filter(b => b.phase === 'proofread').length,
            testing: enriched.filter(b => b.phase === 'testing').length,
            decided: enriched.filter(b => b.phase === 'decided').length,
        },
    });
});
exports.default = router;
