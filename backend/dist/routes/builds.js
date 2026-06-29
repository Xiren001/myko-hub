"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const supabase_1 = require("../supabase");
const auth_1 = require("../middleware/auth");
const calculations_1 = require("../utils/calculations");
async function assertFunnelWriteOrAdmin(req, res, buildId) {
    const role = req.userRole ?? '';
    if (role === 'admin')
        return true;
    if (role !== 'website') {
        res.status(403).json({ error: 'Insufficient permissions' });
        return false;
    }
    if (!buildId) {
        res.status(403).json({ error: 'Insufficient permissions' });
        return false;
    }
    const { data } = await supabase_1.supabase.from('builds').select('type').eq('id', buildId).single();
    if (!data || data.type !== 'funnel') {
        res.status(403).json({ error: 'Insufficient permissions' });
        return false;
    }
    return true;
}
// Sync a proof_products row to match a build's current state.
// Called whenever a jewelry non-EN build that has into_proofread changes.
async function syncProofProduct(newName, newLang, proofreader, oldName, oldLang, oldProofEnd, newProofEnd) {
    const nameOrLangChanged = oldName !== newName || oldLang !== newLang;
    if (nameOrLangChanged) {
        // Update the existing row in place (rename + lang change)
        await supabase_1.supabase.from('proof_products')
            .update({ product_name: newName, language: newLang, proofreader })
            .eq('product_name', oldName)
            .eq('language', oldLang);
    }
    else {
        // Upsert: update proofreader if exists, create if missing
        const { data: pp } = await supabase_1.supabase
            .from('proof_products')
            .select('id')
            .eq('product_name', newName)
            .eq('language', newLang)
            .maybeSingle();
        if (pp) {
            await supabase_1.supabase.from('proof_products')
                .update({ proofreader })
                .eq('id', pp.id);
        }
        else {
            await supabase_1.supabase.from('proof_products').insert({
                product_name: newName,
                language: newLang,
                proofreader,
                done: false,
            });
        }
    }
    // Sync done state when proof_end changes
    if (oldProofEnd !== newProofEnd) {
        await supabase_1.supabase.from('proof_products')
            .update({ done: newProofEnd !== null })
            .eq('product_name', newName)
            .eq('language', newLang);
    }
}
const router = (0, express_1.Router)();
router.get('/proofread-queue', auth_1.authenticate, async (req, res) => {
    const { month } = req.query;
    const ms = month && typeof month === 'string' ? (0, calculations_1.monthStart)(month) : undefined;
    const me = month && typeof month === 'string' ? (0, calculations_1.monthEnd)(month) : undefined;
    // ── 1. Waves subitems in proofread ────────────────────────────────────
    // Active (website_status contains 'proofread') always included.
    // Done items (lp_proofread_at set, status moved on) included when lp_proofread_at is in the selected month.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let wq = supabase_1.supabase
        .from('monday_subitems')
        .select(`
      id, name, product_name, website_status, created_at,
      lp_proofread_at, lp_ready_to_launch_at,
      monday_items!inner(
        name,
        monday_waves!inner(wave_number)
      )
    `)
        .not('lp_proofread_at', 'is', null);
    if (ms && me) {
        wq = wq.or(`website_status.ilike.%proofread%,and(lp_proofread_at.gte.${ms},lp_proofread_at.lte.${me})`);
    }
    else {
        wq = wq.ilike('website_status', '%proofread%');
    }
    const { data: waveData, error: waveError } = await wq;
    if (waveError)
        return res.status(500).json({ error: waveError.message });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const waveItems = (waveData ?? []).map((sub) => {
        const isDone = !sub.website_status?.toLowerCase().includes('proofread');
        return {
            id: sub.id,
            build_id: null,
            product_name: (sub.product_name ?? sub.name),
            monday_url: null,
            language: null,
            proofreader: null,
            type: 'wave',
            week_number: null,
            month_year: null,
            into_proofread: sub.lp_proofread_at,
            proof_end: (isDone ? (sub.lp_ready_to_launch_at ?? null) : null),
            proof_days: null,
            outcome: null,
            done: isDone,
            created_at: sub.created_at,
            source: 'wave',
        };
    });
    // ── 2. Proof products added directly ──────────────────────────────────
    let ppq = supabase_1.supabase
        .from('proof_products')
        .select('*')
        .or('language.is.null,language.neq.EN');
    if (req.userLang)
        ppq = ppq.eq('language', req.userLang);
    if (ms && me) {
        const monthStr = typeof month === 'string' ? month : '';
        ppq = ppq.or(`done.eq.false,month_year.eq.${monthStr}`);
    }
    else {
        ppq = ppq.eq('done', false);
    }
    const { data: ppData } = await ppq;
    const directItems = (ppData ?? []).map(pp => ({
        id: `pp-${pp.id}`,
        build_id: null,
        product_name: pp.product_name,
        monday_url: (pp.monday_url ?? null),
        language: pp.language,
        proofreader: pp.proofreader,
        type: (pp.type ?? 'jewelry'),
        week_number: (pp.week_number ?? null),
        month_year: (pp.month_year ?? null),
        into_proofread: (pp.into_proofread ?? null),
        proof_end: null,
        proof_days: null,
        outcome: null,
        done: pp.done,
        created_at: (pp.created_at ?? null),
        source: 'proof_product',
    }));
    const waveNames = new Set(waveItems.map((i) => i.product_name?.toLowerCase()).filter(Boolean));
    const dedupedDirectItems = directItems.filter((i) => !waveNames.has(i.product_name?.toLowerCase()));
    res.json([...waveItems, ...dedupedDirectItems]);
});
// Payment overview — same data source as proofread-queue, with payment fields added
router.get('/payment-overview', auth_1.authenticate, auth_1.requireManagement, async (req, res) => {
    const { month } = req.query;
    const ms = month && typeof month === 'string' ? (0, calculations_1.monthStart)(month) : undefined;
    const me = month && typeof month === 'string' ? (0, calculations_1.monthEnd)(month) : undefined;
    // ── 1. Builds (same query as proofread-queue) ─────────────────────────
    let bq = supabase_1.supabase
        .from('builds')
        .select('*')
        .not('into_proofread', 'is', null)
        .neq('language', 'EN');
    if (req.userLang)
        bq = bq.eq('language', req.userLang);
    if (ms && me) {
        bq = bq.or(`proof_end.is.null,and(proof_end.gte.${ms},proof_end.lte.${me})`);
    }
    else {
        bq = bq.is('proof_end', null).or('outcome.is.null,outcome.neq.stopped');
    }
    const { data: buildsData, error } = await bq;
    if (error)
        return res.status(500).json({ error: error.message });
    const enrichedBuilds = (buildsData ?? []).map(calculations_1.enrichBuild);
    // ── 2. All proof_products for payment lookup (no month filter) ─────────
    let allPpq = supabase_1.supabase
        .from('proof_products')
        .select('*')
        .or('language.is.null,language.neq.EN');
    if (req.userLang)
        allPpq = allPpq.eq('language', req.userLang);
    const { data: allPpData } = await allPpq;
    // Build payment map keyed by product_name|language
    const ppMap = new Map();
    for (const pp of allPpData ?? []) {
        ppMap.set(`${pp.product_name.toLowerCase()}|${pp.language ?? ''}`, {
            id: pp.id,
            paid: pp.paid ?? false,
            paid_at: pp.paid_at ?? null,
            done: pp.done,
            ready_for_revision: pp.ready_for_revision ?? false,
            pdp_url: pp.pdp_url ?? null,
            drive_folder: pp.drive_folder ?? null,
        });
    }
    // ── 3. Month-filtered proof_products for orphan display ────────────────
    const ppMonthFiltered = (allPpData ?? []).filter(pp => {
        if (!pp.done)
            return true;
        if (ms && me)
            return pp.month_year === (typeof month === 'string' ? month : '');
        return false;
    });
    // ── 4. Deduplicate: orphans are proof_products not covered by a build ──
    const buildKeys = new Set(enrichedBuilds.map(b => `${String(b.product_name).toLowerCase()}|${b.language ?? ''}`));
    function ppStatus(pp) {
        if (pp.done)
            return 'done';
        if (pp.ready_for_revision)
            return 'ready';
        if (!pp.pdp_url || !pp.drive_folder)
            return 'needs_links';
        return 'active';
    }
    const orphans = ppMonthFiltered
        .filter(pp => !buildKeys.has(`${pp.product_name.toLowerCase()}|${pp.language ?? ''}`))
        .map(pp => ({
        id: `pp-${pp.id}`,
        proof_product_id: pp.id,
        build_id: null,
        product_name: pp.product_name,
        language: pp.language,
        proofreader: pp.proofreader,
        type: (pp.type ?? 'jewelry'),
        week_number: (pp.week_number ?? null),
        month_year: (pp.month_year ?? null),
        into_proofread: null,
        proof_end: null,
        proof_days: null,
        outcome: null,
        done: pp.done,
        source: 'proof_product',
        paid: pp.paid ?? false,
        paid_at: pp.paid_at ?? null,
        status: ppStatus(pp),
    }));
    // ── 5. Build items with payment info ───────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buildItems = enrichedBuilds.map((b) => {
        const key = `${String(b.product_name).toLowerCase()}|${b.language ?? ''}`;
        const pp = ppMap.get(key);
        const isDone = !!(b.proof_end) || pp?.done;
        let status;
        if (isDone)
            status = 'done';
        else if (pp?.ready_for_revision)
            status = 'ready';
        else
            status = 'in_proofread';
        return {
            id: b.id,
            proof_product_id: pp?.id ?? null,
            build_id: b.id,
            product_name: b.product_name,
            language: b.language,
            proofreader: b.proofreader,
            type: b.type,
            week_number: b.week_number,
            month_year: b.month_year,
            into_proofread: b.into_proofread,
            proof_end: b.proof_end,
            proof_days: b.proof_days,
            outcome: b.outcome,
            done: isDone,
            source: 'build',
            paid: pp?.paid ?? false,
            paid_at: pp?.paid_at ?? null,
            status,
        };
    });
    res.json([...buildItems, ...orphans]);
});
// Mark a product as paid; creates a proof_products row if none exists yet (build-sourced orphan)
router.post('/mark-paid', auth_1.authenticate, auth_1.requireManagement, async (req, res) => {
    const { id, product_name, language, proofreader, paid, paid_at } = req.body;
    if (id) {
        const { error } = await supabase_1.supabase
            .from('proof_products')
            .update({ paid, paid_at, updated_at: new Date().toISOString() })
            .eq('id', id);
        if (error)
            return res.status(500).json({ error: error.message });
    }
    else {
        // Build-sourced product with no proof_products row yet — upsert by name+lang
        const { data: existing } = await supabase_1.supabase
            .from('proof_products')
            .select('id')
            .eq('product_name', product_name)
            .eq('language', language ?? '')
            .maybeSingle();
        if (existing) {
            await supabase_1.supabase.from('proof_products')
                .update({ paid, paid_at, updated_at: new Date().toISOString() })
                .eq('id', existing.id);
        }
        else {
            await supabase_1.supabase.from('proof_products').insert({
                product_name, language, proofreader, done: true, paid, paid_at,
            });
        }
    }
    res.json({ ok: true });
});
router.get('/', auth_1.authenticate, async (req, res) => {
    const { type, month } = req.query;
    let query = supabase_1.supabase.from('builds').select('*').order('created_at', { ascending: true });
    if (type)
        query = query.eq('type', type);
    if (month && typeof month === 'string') {
        query = query.gte('month_year', (0, calculations_1.monthStart)(month)).lte('month_year', (0, calculations_1.monthEnd)(month));
    }
    const { data, error } = await query;
    if (error)
        return res.status(500).json({ error: error.message });
    res.json((data ?? []).map(calculations_1.enrichBuild));
});
router.post('/', auth_1.authenticate, async (req, res) => {
    const role = req.userRole ?? '';
    const isManagement = role === 'admin' || role === 'management';
    const isWebsiteFunnel = role === 'website' && req.body.type === 'funnel';
    if (!isManagement && !isWebsiteFunnel)
        return res.status(403).json({ error: 'Insufficient permissions' });
    const { data, error } = await supabase_1.supabase.from('builds').insert(req.body).select().single();
    if (error)
        return res.status(500).json({ error: error.message });
    res.status(201).json((0, calculations_1.enrichBuild)(data));
});
router.put('/:id', auth_1.authenticate, async (req, res) => {
    if (!await assertFunnelWriteOrAdmin(req, res, req.params.id))
        return;
    // Capture state before update so we can detect what changed
    const { data: before } = await supabase_1.supabase
        .from('builds')
        .select('language, product_name, proof_end')
        .eq('id', req.params.id)
        .single();
    const { phase, build_days, proof_days, test_days, total_days, created_at, ...updateData } = req.body;
    const { data, error } = await supabase_1.supabase
        .from('builds')
        .update({ ...updateData, updated_at: new Date().toISOString() })
        .eq('id', req.params.id)
        .select()
        .single();
    if (error)
        return res.status(500).json({ error: error.message });
    res.json((0, calculations_1.enrichBuild)(data));
});
router.delete('/:id', auth_1.authenticate, async (req, res) => {
    if (!await assertFunnelWriteOrAdmin(req, res, req.params.id))
        return;
    // Fetch build before deleting so we can cascade to proof_products
    const { data: build } = await supabase_1.supabase
        .from('builds')
        .select('product_name, language, type')
        .eq('id', req.params.id)
        .single();
    const { error } = await supabase_1.supabase.from('builds').delete().eq('id', req.params.id);
    if (error)
        return res.status(500).json({ error: error.message });
    res.status(204).end();
});
exports.default = router;
