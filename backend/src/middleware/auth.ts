import { Request, Response, NextFunction } from 'express'
import { createClient } from '@supabase/supabase-js'
import { supabase } from '../supabase'

export interface AuthRequest extends Request {
  userId?: string
  userRole?: string
}

export async function authenticate(req: AuthRequest, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'No token' })

  const { data: { user }, error } = await supabase.auth.getUser(token)
  if (error || !user) return res.status(401).json({ error: 'Invalid token' })

  // Pass the user's JWT so the profile query works whether SUPABASE_SERVICE_ROLE_KEY
  // is the service role key (bypasses RLS) or the anon key (auth.uid() satisfies RLS)
  const client = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    }
  )

  const { data: profile } = await client
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single()

  req.userId = user.id
  req.userRole = profile?.role ?? 'viewer'
  next()
}

export function requireAdmin(req: AuthRequest, res: Response, next: NextFunction) {
  if (req.userRole !== 'admin') return res.status(403).json({ error: 'Admin only' })
  next()
}

export function requireAdminOrApprover(req: AuthRequest, res: Response, next: NextFunction) {
  if (req.userRole !== 'admin' && req.userRole !== 'approver') {
    return res.status(403).json({ error: 'Insufficient permissions' })
  }
  next()
}
