"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const supabase_1 = require("../supabase");
const auth_1 = require("../middleware/auth");
const calculations_1 = require("../utils/calculations");
const router = (0, express_1.Router)();
router.get('/', auth_1.authenticate, async (req, res) => {
    const { month } = req.query;
    let query = supabase_1.supabase.from('planner_notes').select('*').order('date');
    if (month && typeof month === 'string') {
        query = query.gte('date', `${month}-01`).lte('date', (0, calculations_1.monthEnd)(month));
    }
    const { data, error } = await query;
    if (error)
        return res.status(500).json({ error: error.message });
    res.json(data ?? []);
});
router.put('/:date', auth_1.authenticate, auth_1.requireManagement, async (req, res) => {
    const { notes } = req.body;
    const { data, error } = await supabase_1.supabase
        .from('planner_notes')
        .upsert({ date: req.params.date, notes, updated_at: new Date().toISOString() }, { onConflict: 'date' })
        .select()
        .single();
    if (error)
        return res.status(500).json({ error: error.message });
    res.json(data);
});
exports.default = router;
