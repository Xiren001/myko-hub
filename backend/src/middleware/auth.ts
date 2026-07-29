import { Request, Response, NextFunction } from 'express'
import { createClient } from '@supabase/supabase-js'
import { supabase } from '../supabase'
import { isBioedgeSharingEnabled } from '../utils/bioedgeSharing'

export interface AuthRequest extends Request {
  userId?: string
  userRole?: string
  userLangs?: string[]   // set for proofreader_XX roles; primary lang (uppercase, e.g. "ES") + any extra_languages
  system?: 'waves' | 'bioedge'   // which proofreading system this login belongs to (bioedge_* role prefix)
}

export async function authenticate(req: AuthRequest, res: Response, next: NextFunction) {
  const t0 = Date.now()
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'No token' })

  const { data: { user }, error } = await supabase.auth.getUser(token)
  console.log(`[auth timing] getUser: ${Date.now() - t0}ms`)
  if (error || !user) return res.status(401).json({ error: 'Invalid token' })

  // Pass the user's JWT so the profile query works whether SUPABASE_SERVICE_ROLE_KEY
  // is the service role key (bypasses RLS) or the anon key (auth.uid() satisfies RLS)
  const t1 = Date.now()
  const client = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    }
  )
  console.log(`[auth timing] createClient: ${Date.now() - t1}ms`)

  const t2 = Date.now()
  const { data: profile } = await client
    .from('profiles')
    .select('role, extra_languages')
    .eq('id', user.id)
    .single()
  console.log(`[auth timing] profile select: ${Date.now() - t2}ms`)

  req.userId = user.id
  const rawRoleFull: string = profile?.role ?? 'website'
  // bioedge_* roles are the BioEdge-system equivalent of the same base role (bioedge_ads, bioedge_proofreader_es, ...).
  // Strip the prefix before the usual parsing so req.userRole keeps the exact same values either system uses.
  const isBioedge = rawRoleFull.startsWith('bioedge_')
  const rawRole = isBioedge ? rawRoleFull.slice('bioedge_'.length) : rawRoleFull
  req.system = isBioedge ? 'bioedge' : 'waves'
  // proofreader_es → role='proofreader', langs=['ES', ...extra_languages]
  const langMatch = rawRole.match(/^proofreader_([a-z-]+)$/i)
  if (langMatch) {
    req.userRole = 'proofreader'
    const extra = ((profile?.extra_languages as string[] | null) ?? []).map(l => l.toUpperCase())
    req.userLangs = [...new Set([langMatch[1].toUpperCase(), ...extra])]
  } else {
    req.userRole = rawRole
  }
  next()
}

// Admin only
export function requireAdmin(req: AuthRequest, res: Response, next: NextFunction) {
  if (req.userRole !== 'admin') return res.status(403).json({ error: 'Admin only' })
  next()
}

// Admin + management (general write access)
export function requireManagement(req: AuthRequest, res: Response, next: NextFunction) {
  if (!['admin', 'management'].includes(req.userRole ?? '')) {
    return res.status(403).json({ error: 'Insufficient permissions' })
  }
  next()
}

// Admin + management + proofreader (incl. lang proofreaders) + website (correction writes; not ads)
export function requireCorrectionWrite(req: AuthRequest, res: Response, next: NextFunction) {
  if (!['admin', 'management', 'proofreader'].includes(req.userRole ?? '')) {
    return res.status(403).json({ error: 'Insufficient permissions' })
  }
  next()
}

// Returns true if the request role is admin (no language filter ever applies)
export function isAdmin(req: AuthRequest): boolean {
  return req.userRole === 'admin'
}

// Blocks bioedge_* logins from touching Waves data (admin bypasses — shared superuser role;
// also bypassed entirely when the "share BioEdge with Waves" setting is on)
export async function requireWavesSystem(req: AuthRequest, res: Response, next: NextFunction) {
  if (req.userRole === 'admin' || req.system !== 'bioedge') return next()
  if (await isBioedgeSharingEnabled()) return next()
  return res.status(403).json({ error: 'Wrong system' })
}

// Blocks Waves logins from touching BioEdge data (admin bypasses — shared superuser role;
// also bypassed entirely when the "share BioEdge with Waves" setting is on)
export async function requireBioedgeSystem(req: AuthRequest, res: Response, next: NextFunction) {
  if (req.userRole === 'admin' || req.system === 'bioedge') return next()
  if (await isBioedgeSharingEnabled()) return next()
  return res.status(403).json({ error: 'Wrong system' })
}
