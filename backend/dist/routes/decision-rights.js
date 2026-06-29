"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const supabase_1 = require("../supabase");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
router.get('/', auth_1.authenticate, async (_req, res) => {
    const { data, error } = await supabase_1.supabase
        .from('decision_rights')
        .select('*')
        .order('section')
        .order('sort_order')
        .order('created_at');
    if (error)
        return res.status(500).json({ error: error.message });
    res.json(data ?? []);
});
router.post('/', auth_1.authenticate, auth_1.requireManagement, async (req, res) => {
    const { data, error } = await supabase_1.supabase.from('decision_rights').insert(req.body).select().single();
    if (error)
        return res.status(500).json({ error: error.message });
    res.status(201).json(data);
});
router.put('/:id', auth_1.authenticate, auth_1.requireManagement, async (req, res) => {
    const { data, error } = await supabase_1.supabase
        .from('decision_rights')
        .update({ ...req.body, updated_at: new Date().toISOString() })
        .eq('id', req.params.id)
        .select()
        .single();
    if (error)
        return res.status(500).json({ error: error.message });
    res.json(data);
});
router.delete('/:id', auth_1.authenticate, auth_1.requireManagement, async (req, res) => {
    const { error } = await supabase_1.supabase.from('decision_rights').delete().eq('id', req.params.id);
    if (error)
        return res.status(500).json({ error: error.message });
    res.status(204).end();
});
exports.default = router;
