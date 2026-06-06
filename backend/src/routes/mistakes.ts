import { Router, Response } from 'express'
import { supabase } from '../supabase'
import { authenticate, requireManagement, AuthRequest } from '../middleware/auth'
import { monthStart, monthEnd } from '../utils/calculations'

const router = Router()

router.get('/', authenticate, async (req: AuthRequest, res: Response) => {
  const { month } = req.query
  let query = supabase.from('mistakes').select('*').order('created_at', { ascending: false })
  if (month && typeof month === 'string') {
    query = query.gte('month_year', monthStart(month)).lte('month_year', monthEnd(month))
  }
  const { data, error } = await query
  if (error) return res.status(500).json({ error: error.message })

  // Pattern watch: count by category
  const counts: Record<string, number> = {}
  for (const m of data ?? []) {
    counts[m.category] = (counts[m.category] ?? 0) + 1
  }
  res.json({ mistakes: data ?? [], categoryCounts: counts })
})

router.post('/bulk', authenticate, requireManagement, async (req: AuthRequest, res: Response) => {
  const rows = (req.body as Record<string, unknown>[]).map(r => ({
    ...r,
    month_year: r.date ? String(r.date).slice(0, 8) + '01' : null,
  }))
  const { data, error } = await supabase.from('mistakes').insert(rows).select()
  if (error) return res.status(500).json({ error: error.message })
  res.status(201).json(data)
})

router.post('/', authenticate, requireManagement, async (req: AuthRequest, res: Response) => {
  const body = { ...req.body, month_year: req.body.date ? req.body.date.slice(0, 8) + '01' : null }
  const { data, error } = await supabase.from('mistakes').insert(body).select().single()
  if (error) return res.status(500).json({ error: error.message })
  res.status(201).json(data)
})

router.put('/:id', authenticate, requireManagement, async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('mistakes')
    .update(req.body)
    .eq('id', req.params.id)
    .select()
    .single()
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

router.delete('/:id', authenticate, requireManagement, async (req: AuthRequest, res: Response) => {
  const { error } = await supabase.from('mistakes').delete().eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })
  res.status(204).end()
})

export default router
