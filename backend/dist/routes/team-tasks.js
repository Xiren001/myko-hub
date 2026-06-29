"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const supabase_1 = require("../supabase");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
// ── Members ──────────────────────────────────────────────────────────────────
router.get('/members', auth_1.authenticate, async (_req, res) => {
    const { data, error } = await supabase_1.supabase
        .from('team_members')
        .select('*')
        .order('created_at');
    if (error)
        return res.status(500).json({ error: error.message });
    res.json(data ?? []);
});
router.post('/members', auth_1.authenticate, auth_1.requireManagement, async (req, res) => {
    const { data, error } = await supabase_1.supabase
        .from('team_members')
        .insert({ name: req.body.name })
        .select()
        .single();
    if (error)
        return res.status(500).json({ error: error.message });
    res.status(201).json(data);
});
router.delete('/members/:id', auth_1.authenticate, auth_1.requireManagement, async (req, res) => {
    const { error } = await supabase_1.supabase
        .from('team_members')
        .delete()
        .eq('id', req.params.id);
    if (error)
        return res.status(500).json({ error: error.message });
    res.status(204).end();
});
// ── Tasks ─────────────────────────────────────────────────────────────────────
router.get('/tasks', auth_1.authenticate, async (req, res) => {
    const { member_id } = req.query;
    let query = supabase_1.supabase.from('team_tasks').select('*');
    if (member_id)
        query = query.eq('member_id', String(member_id));
    const { data, error } = await query.order('created_at');
    if (error)
        return res.status(500).json({ error: error.message });
    res.json(data ?? []);
});
router.post('/tasks', auth_1.authenticate, async (req, res) => {
    const { data, error } = await supabase_1.supabase
        .from('team_tasks')
        .insert({ member_id: req.body.member_id, text: req.body.text })
        .select()
        .single();
    if (error)
        return res.status(500).json({ error: error.message });
    res.status(201).json(data);
});
router.put('/tasks/:id', auth_1.authenticate, async (req, res) => {
    const update = { ...req.body };
    if (req.body.done === true)
        update.done_at = new Date().toISOString();
    if (req.body.done === false)
        update.done_at = null;
    const { data, error } = await supabase_1.supabase
        .from('team_tasks')
        .update(update)
        .eq('id', req.params.id)
        .select()
        .single();
    if (error)
        return res.status(500).json({ error: error.message });
    res.json(data);
});
router.delete('/tasks/:id', auth_1.authenticate, async (req, res) => {
    const { error } = await supabase_1.supabase
        .from('team_tasks')
        .delete()
        .eq('id', req.params.id);
    if (error)
        return res.status(500).json({ error: error.message });
    res.status(204).end();
});
exports.default = router;
