import { Router, Response } from 'express'
import { supabase } from '../supabase'
import { authenticate, requireManagement, AuthRequest } from '../middleware/auth'

const router = Router()

router.get('/', authenticate, async (_req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('decision_rights')
    .select('*')
    .order('section')
    .order('sort_order')
    .order('created_at')
  if (error) return res.status(500).json({ error: error.message })
  res.json(data ?? [])
})

router.post('/', authenticate, requireManagement, async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase.from('decision_rights').insert(req.body).select().single()
  if (error) return res.status(500).json({ error: error.message })
  res.status(201).json(data)
})

router.put('/:id', authenticate, requireManagement, async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('decision_rights')
    .update({ ...req.body, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select()
    .single()
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

router.delete('/:id', authenticate, requireManagement, async (req: AuthRequest, res: Response) => {
  const { error } = await supabase.from('decision_rights').delete().eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })
  res.status(204).end()
})

export default router
