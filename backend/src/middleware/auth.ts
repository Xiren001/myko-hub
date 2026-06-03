import { Request, Response, NextFunction } from 'express'
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

  const { data: profile } = await supabase
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
