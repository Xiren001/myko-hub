import { Router, Response } from 'express'
import { supabase } from '../supabase'
import { authenticate, requireManagement, AuthRequest } from '../middleware/auth'

const router = Router()

// ── Members ──────────────────────────────────────────────────────────────────

router.get('/members', authenticate, async (_req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('team_members')
    .select('*')
    .order('created_at')
  if (error) return res.status(500).json({ error: error.message })
  res.json(data ?? [])
})

router.post('/members', authenticate, requireManagement, async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('team_members')
    .insert({ name: req.body.name })
    .select()
    .single()
  if (error) return res.status(500).json({ error: error.message })
  res.status(201).json(data)
})

router.delete('/members/:id', authenticate, requireManagement, async (req: AuthRequest, res: Response) => {
  const { error } = await supabase
    .from('team_members')
    .delete()
    .eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })
  res.status(204).end()
})

// ── Tasks ─────────────────────────────────────────────────────────────────────

router.get('/tasks', authenticate, async (req: AuthRequest, res: Response) => {
  const { member_id } = req.query
  let query = supabase.from('team_tasks').select('*')
  if (member_id) query = query.eq('member_id', String(member_id))
  const { data, error } = await query.order('created_at')
  if (error) return res.status(500).json({ error: error.message })
  res.json(data ?? [])
})

router.post('/tasks', authenticate, async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('team_tasks')
    .insert({ member_id: req.body.member_id, text: req.body.text })
    .select()
    .single()
  if (error) return res.status(500).json({ error: error.message })
  res.status(201).json(data)
})

router.put('/tasks/:id', authenticate, async (req: AuthRequest, res: Response) => {
  const update: Record<string, unknown> = { ...req.body }
  if (req.body.done === true)  update.done_at = new Date().toISOString()
  if (req.body.done === false) update.done_at = null
  const { data, error } = await supabase
    .from('team_tasks')
    .update(update)
    .eq('id', req.params.id)
    .select()
    .single()
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

router.delete('/tasks/:id', authenticate, async (req: AuthRequest, res: Response) => {
  const { error } = await supabase
    .from('team_tasks')
    .delete()
    .eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })
  res.status(204).end()
})

export default router
