"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const supabase_1 = require("../supabase");
const auth_1 = require("../middleware/auth");
const calculations_1 = require("../utils/calculations");
const router = (0, express_1.Router)();
router.get('/', auth_1.authenticate, async (req, res) => {
    const { month } = req.query;
    let query = supabase_1.supabase.from('mistakes').select('*').order('created_at', { ascending: false });
    if (month && typeof month === 'string') {
        query = query.gte('month_year', (0, calculations_1.monthStart)(month)).lte('month_year', (0, calculations_1.monthEnd)(month));
    }
    const { data, error } = await query;
    if (error)
        return res.status(500).json({ error: error.message });
    // Pattern watch: count by category
    const counts = {};
    for (const m of data ?? []) {
        counts[m.category] = (counts[m.category] ?? 0) + 1;
    }
    res.json({ mistakes: data ?? [], categoryCounts: counts });
});
router.post('/bulk', auth_1.authenticate, auth_1.requireManagement, async (req, res) => {
    const rows = req.body.map(r => ({
        ...r,
        month_year: r.date ? String(r.date).slice(0, 8) + '01' : null,
    }));
    const { data, error } = await supabase_1.supabase.from('mistakes').insert(rows).select();
    if (error)
        return res.status(500).json({ error: error.message });
    res.status(201).json(data);
});
router.post('/', auth_1.authenticate, auth_1.requireManagement, async (req, res) => {
    const body = { ...req.body, month_year: req.body.date ? req.body.date.slice(0, 8) + '01' : null };
    const { data, error } = await supabase_1.supabase.from('mistakes').insert(body).select().single();
    if (error)
        return res.status(500).json({ error: error.message });
    res.status(201).json(data);
});
router.put('/:id', auth_1.authenticate, auth_1.requireManagement, async (req, res) => {
    const { data, error } = await supabase_1.supabase
        .from('mistakes')
        .update(req.body)
        .eq('id', req.params.id)
        .select()
        .single();
    if (error)
        return res.status(500).json({ error: error.message });
    res.json(data);
});
router.delete('/:id', auth_1.authenticate, auth_1.requireManagement, async (req, res) => {
    const { error } = await supabase_1.supabase.from('mistakes').delete().eq('id', req.params.id);
    if (error)
        return res.status(500).json({ error: error.message });
    res.status(204).end();
});
exports.default = router;
