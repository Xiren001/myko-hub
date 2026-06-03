import { Router, Response } from 'express'
import { supabase } from '../supabase'
import { authenticate, requireAdmin, AuthRequest } from '../middleware/auth'

const router = Router()

router.get('/', authenticate, async (_req: AuthRequest, res: Response) => {
  const { data, error } = await supabase.from('settings').select('*').eq('id', 1).single()
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

router.put('/', authenticate, requireAdmin, async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('settings')
    .update({ ...req.body, updated_at: new Date().toISOString() })
    .eq('id', 1)
    .select()
    .single()
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

export default router
