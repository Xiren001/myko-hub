"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.authenticate = authenticate;
exports.requireAdmin = requireAdmin;
exports.requireManagement = requireManagement;
exports.requireCorrectionWrite = requireCorrectionWrite;
exports.isAdmin = isAdmin;
const supabase_js_1 = require("@supabase/supabase-js");
const supabase_1 = require("../supabase");
async function authenticate(req, res, next) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token)
        return res.status(401).json({ error: 'No token' });
    const { data: { user }, error } = await supabase_1.supabase.auth.getUser(token);
    if (error || !user)
        return res.status(401).json({ error: 'Invalid token' });
    // Pass the user's JWT so the profile query works whether SUPABASE_SERVICE_ROLE_KEY
    // is the service role key (bypasses RLS) or the anon key (auth.uid() satisfies RLS)
    const client = (0, supabase_js_1.createClient)(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
        global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: profile } = await client
        .from('profiles')
        .select('role')
        .eq('id', user.id)
        .single();
    req.userId = user.id;
    const rawRole = profile?.role ?? 'website';
    // proofreader_es → role='proofreader', lang='ES'
    const langMatch = rawRole.match(/^proofreader_([a-z]+)$/i);
    if (langMatch) {
        req.userRole = 'proofreader';
        req.userLang = langMatch[1].toUpperCase();
    }
    else {
        req.userRole = rawRole;
    }
    next();
}
// Admin only
function requireAdmin(req, res, next) {
    if (req.userRole !== 'admin')
        return res.status(403).json({ error: 'Admin only' });
    next();
}
// Admin + management (general write access)
function requireManagement(req, res, next) {
    if (!['admin', 'management'].includes(req.userRole ?? '')) {
        return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
}
// Admin + management + proofreader (incl. lang proofreaders) + website (correction writes; not ads)
function requireCorrectionWrite(req, res, next) {
    if (!['admin', 'management', 'proofreader'].includes(req.userRole ?? '')) {
        return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
}
// Returns true if the request role is admin (no language filter ever applies)
function isAdmin(req) {
    return req.userRole === 'admin';
}
