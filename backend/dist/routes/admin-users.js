"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const supabase_1 = require("../supabase");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
// GET /languages — distinct non-EN languages from proof_products
router.get('/languages', auth_1.authenticate, auth_1.requireAdmin, async (_req, res) => {
    const { data, error } = await supabase_1.supabase
        .from('proof_products')
        .select('language')
        .not('language', 'is', null)
        .neq('language', 'EN');
    if (error)
        return res.status(500).json({ error: error.message });
    const langs = Array.from(new Set((data ?? []).map(r => r.language))).sort();
    res.json(langs);
});
// GET /users — list all auth users with their profile role
router.get('/users', auth_1.authenticate, auth_1.requireAdmin, async (_req, res) => {
    const { data, error } = await supabase_1.supabase.auth.admin.listUsers();
    if (error)
        return res.status(500).json({ error: error.message });
    const ids = data.users.map(u => u.id);
    const { data: profiles } = await supabase_1.supabase.from('profiles').select('id, role').in('id', ids);
    const roleMap = {};
    for (const p of profiles ?? [])
        roleMap[p.id] = p.role;
    res.json(data.users.map(u => ({
        id: u.id,
        email: u.email,
        role: roleMap[u.id] ?? 'viewer',
        created_at: u.created_at,
    })));
});
// POST /users — create a new auth user and set their profile role
router.post('/users', auth_1.authenticate, auth_1.requireAdmin, async (req, res) => {
    const { email, password, role } = req.body;
    if (!email || !password || !role) {
        return res.status(400).json({ error: 'email, password, and role are required' });
    }
    const { data: created, error } = await supabase_1.supabase.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
    });
    if (error)
        return res.status(500).json({ error: error.message });
    await supabase_1.supabase.from('profiles').update({ role }).eq('id', created.user.id);
    res.status(201).json({ id: created.user.id, email: created.user.email, role });
});
// DELETE /users/:id — delete an auth user
router.delete('/users/:id', auth_1.authenticate, auth_1.requireAdmin, async (req, res) => {
    const { error } = await supabase_1.supabase.auth.admin.deleteUser(req.params.id);
    if (error)
        return res.status(500).json({ error: error.message });
    res.status(204).end();
});
exports.default = router;
