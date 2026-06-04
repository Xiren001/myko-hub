import { Router, Response } from 'express'
import { supabase } from '../supabase'
import { authenticate, requireAdminOrApprover, AuthRequest } from '../middleware/auth'
import { monthEnd } from '../utils/calculations'

const router = Router()

router.get('/', authenticate, async (req: AuthRequest, res: Response) => {
  const { month } = req.query
  let query = supabase.from('planner_notes').select('*').order('date')
  if (month && typeof month === 'string') {
    query = query.gte('date', `${month}-01`).lte('date', monthEnd(month))
  }
  const { data, error } = await query
  if (error) return res.status(500).json({ error: error.message })
  res.json(data ?? [])
})

router.put('/:date', authenticate, requireAdminOrApprover, async (req: AuthRequest, res: Response) => {
  const { notes } = req.body
  const { data, error } = await supabase
    .from('planner_notes')
    .upsert({ date: req.params.date, notes, updated_at: new Date().toISOString() }, { onConflict: 'date' })
    .select()
    .single()
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

export default router
