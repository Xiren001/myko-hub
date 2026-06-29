"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const supabase_1 = require("../supabase");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
router.get('/', auth_1.authenticate, async (_req, res) => {
    const { data, error } = await supabase_1.supabase.from('settings').select('*').eq('id', 1).single();
    if (error)
        return res.status(500).json({ error: error.message });
    res.json(data);
});
router.put('/', auth_1.authenticate, auth_1.requireAdmin, async (req, res) => {
    const { data, error } = await supabase_1.supabase
        .from('settings')
        .update({ ...req.body, updated_at: new Date().toISOString() })
        .eq('id', 1)
        .select()
        .single();
    if (error)
        return res.status(500).json({ error: error.message });
    res.json(data);
});
exports.default = router;
