"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const supabase_1 = require("../supabase");
const auth_1 = require("../middleware/auth");
const notificationScheduler_1 = require("../jobs/notificationScheduler");
const router = (0, express_1.Router)();
// GET /products
router.get('/products', auth_1.authenticate, async (req, res) => {
    let q = supabase_1.supabase.from('proof_products').select('*').order('language').order('product_name');
    if (req.userLang)
        q = q.eq('language', req.userLang);
    const { data, error } = await q;
    if (error)
        return res.status(500).json({ error: error.message });
    const { data: counts } = await supabase_1.supabase.from('proof_corrections').select('product_id');
    const countMap = {};
    for (const c of counts ?? []) {
        countMap[c.product_id] = (countMap[c.product_id] ?? 0) + 1;
    }
    const products = (data ?? []).map(p => ({ ...p, correction_count: countMap[p.id] ?? 0 }));
    res.json(products);
});
// GET /products/:id/corrections
router.get('/products/:id/corrections', auth_1.authenticate, async (req, res) => {
    const { data, error } = await supabase_1.supabase
        .from('proof_corrections')
        .select('*')
        .eq('product_id', req.params.id)
        .order('created_at');
    if (error)
        return res.status(500).json({ error: error.message });
    res.json(data ?? []);
});
// POST /products — admin only
router.post('/products', auth_1.authenticate, auth_1.requireAdmin, async (req, res) => {
    const { data, error } = await supabase_1.supabase
        .from('proof_products')
        .insert(req.body)
        .select()
        .single();
    if (error)
        return res.status(500).json({ error: error.message });
    res.status(201).json(data);
});
// PUT /products/:id
// admin + management: full update
// proofreader: ready_for_revision only
// ads: ads_done only
// website: pdp_url, drive_folder, website_done
// done is auto-computed as website_done AND ads_done for ads/website roles
router.put('/products/:id', auth_1.authenticate, async (req, res) => {
    const role = req.userRole ?? '';
    let updateData;
    if (role === 'admin') {
        const { correction_count, ...rest } = req.body;
        updateData = rest;
    }
    else if (role === 'management' || role === 'proofreader') {
        const { ready_for_revision } = req.body;
        updateData = { ready_for_revision };
    }
    else if (role === 'ads') {
        const { ads_done } = req.body;
        updateData = { ads_done };
    }
    else if (role === 'website') {
        const { pdp_url, drive_folder, website_done } = req.body;
        updateData = Object.fromEntries(Object.entries({ pdp_url, drive_folder, website_done }).filter(([, v]) => v !== undefined));
    }
    else {
        return res.status(403).json({ error: 'Insufficient permissions' });
    }
    // Stamp timestamps when boolean flags turn true
    const _now = new Date().toISOString();
    if (updateData.ready_for_revision === true)
        updateData.ready_for_revision_at = _now;
    if (updateData.website_done === true)
        updateData.website_done_at = _now;
    if (updateData.ads_done === true)
        updateData.ads_done_at = _now;
    // Lang proofreaders can only write to their own language
    if (req.userLang) {
        const { data: existing } = await supabase_1.supabase.from('proof_products').select('language').eq('id', req.params.id).single();
        if (existing?.language !== req.userLang)
            return res.status(403).json({ error: 'Language access denied' });
    }
    // Auto-compute done = website_done AND ads_done when a split flag is updated
    let prevDone;
    if ('website_done' in updateData || 'ads_done' in updateData) {
        const { data: cur } = await supabase_1.supabase
            .from('proof_products')
            .select('website_done, ads_done, done')
            .eq('id', req.params.id)
            .single();
        if (cur) {
            prevDone = cur.done;
            const webDone = 'website_done' in updateData ? updateData.website_done : cur.website_done;
            const adsDone = 'ads_done' in updateData ? updateData.ads_done : cur.ads_done;
            updateData.done = webDone && adsDone;
        }
    }
    const { data, error } = await supabase_1.supabase
        .from('proof_products')
        .update({ ...updateData, updated_at: new Date().toISOString() })
        .eq('id', req.params.id)
        .select()
        .single();
    if (error)
        return res.status(500).json({ error: error.message });
    // Auto-notify when language is first assigned
    if (updateData.language && typeof updateData.language === 'string' && data.notified_at === null) {
        (0, notificationScheduler_1.enqueueNotification)(updateData.language).catch(err => console.error('[proof-notify] enqueue error:', err));
    }
    // Sync to linked jewelry build when done actually changes
    const doneChanged = 'done' in updateData && (role === 'admin' || data.done !== prevDone);
    if (doneChanged && data.language && data.language !== 'EN') {
        const isDone = data.done;
        const today = new Date().toISOString().split('T')[0];
        if (isDone) {
            await supabase_1.supabase.from('builds')
                .update({ proof_end: today, updated_at: new Date().toISOString() })
                .eq('product_name', data.product_name)
                .eq('language', data.language)
                .eq('type', 'jewelry')
                .not('into_proofread', 'is', null)
                .is('proof_end', null);
        }
        else {
            await supabase_1.supabase.from('builds')
                .update({ proof_end: null, updated_at: new Date().toISOString() })
                .eq('product_name', data.product_name)
                .eq('language', data.language)
                .eq('type', 'jewelry')
                .not('into_proofread', 'is', null);
        }
    }
    // Sync monday_url back to the matching jewelry build
    if ('monday_url' in updateData && data.language && data.language !== 'EN') {
        await supabase_1.supabase.from('builds')
            .update({ monday_url: (data.monday_url ?? null), updated_at: new Date().toISOString() })
            .eq('product_name', data.product_name)
            .eq('language', data.language)
            .eq('type', 'jewelry')
            .not('into_proofread', 'is', null);
    }
    res.json(data);
});
// DELETE /products/:id — admin only
router.delete('/products/:id', auth_1.authenticate, auth_1.requireAdmin, async (req, res) => {
    const { error } = await supabase_1.supabase.from('proof_products').delete().eq('id', req.params.id);
    if (error)
        return res.status(500).json({ error: error.message });
    res.status(204).end();
});
// POST /corrections — admin + management + proofreader + website
router.post('/corrections', auth_1.authenticate, auth_1.requireCorrectionWrite, async (req, res) => {
    const { data, error } = await supabase_1.supabase
        .from('proof_corrections')
        .insert(req.body)
        .select()
        .single();
    if (error)
        return res.status(500).json({ error: error.message });
    res.status(201).json(data);
});
// PUT /corrections/:id — admin + management + proofreader (full); ads + website (done only, product must be ready)
router.put('/corrections/:id', auth_1.authenticate, async (req, res) => {
    const role = req.userRole ?? '';
    const fullRoles = ['admin', 'management', 'proofreader'];
    const doneOnlyRoles = ['ads', 'website'];
    if (!fullRoles.includes(role) && !doneOnlyRoles.includes(role)) {
        return res.status(403).json({ error: 'Insufficient permissions' });
    }
    let updateData = req.body;
    if (doneOnlyRoles.includes(role)) {
        // ads + website may only toggle done, and only when the product is ready_for_revision
        const correction = await supabase_1.supabase
            .from('proof_corrections').select('product_id').eq('id', req.params.id).single();
        if (correction.error)
            return res.status(500).json({ error: correction.error.message });
        const product = await supabase_1.supabase
            .from('proof_products').select('ready_for_revision').eq('id', correction.data.product_id).single();
        if (product.error)
            return res.status(500).json({ error: product.error.message });
        if (!product.data.ready_for_revision)
            return res.status(403).json({ error: 'Product is not ready for revision' });
        const { done } = req.body;
        updateData = { done };
    }
    const { data, error } = await supabase_1.supabase
        .from('proof_corrections')
        .update(updateData)
        .eq('id', req.params.id)
        .select()
        .single();
    if (error)
        return res.status(500).json({ error: error.message });
    res.json(data);
});
// DELETE /corrections/:id — admin + management + proofreader + website
router.delete('/corrections/:id', auth_1.authenticate, auth_1.requireCorrectionWrite, async (req, res) => {
    const { error } = await supabase_1.supabase.from('proof_corrections').delete().eq('id', req.params.id);
    if (error)
        return res.status(500).json({ error: error.message });
    res.status(204).end();
});
exports.default = router;
