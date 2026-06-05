import { Router, Response } from 'express'
import { supabase } from '../supabase'
import { authenticate, requireAdmin, AuthRequest } from '../middleware/auth'
import { enrichBuild, monthStart, monthEnd } from '../utils/calculations'

const router = Router()

router.get('/proofread-queue', authenticate, async (req: AuthRequest, res: Response) => {
  // Show builds where proofread has started (into_proofread set) but not yet ended (proof_end null)
  const { data, error } = await supabase
    .from('builds')
    .select('*')
    .not('into_proofread', 'is', null)
    .is('proof_end', null)
    .or('outcome.is.null,outcome.neq.stopped')
    .order('into_proofread', { ascending: true })

  if (error) return res.status(500).json({ error: error.message })
  res.json((data ?? []).map(enrichBuild))
})

router.get('/', authenticate, async (req: AuthRequest, res: Response) => {
  const { type, month } = req.query
  let query = supabase.from('builds').select('*').order('created_at', { ascending: true })
  if (type) query = query.eq('type', type)
  if (month && typeof month === 'string') {
    query = query.gte('month_year', monthStart(month)).lte('month_year', monthEnd(month))
  }
  const { data, error } = await query
  if (error) return res.status(500).json({ error: error.message })
  res.json((data ?? []).map(enrichBuild))
})

router.post('/', authenticate, requireAdmin, async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase.from('builds').insert(req.body).select().single()
  if (error) return res.status(500).json({ error: error.message })
  res.status(201).json(enrichBuild(data))
})

router.put('/:id', authenticate, requireAdmin, async (req: AuthRequest, res: Response) => {
  // Strip computed fields that don't exist as DB columns
  const { phase, build_days, proof_days, test_days, total_days, created_at, ...updateData } = req.body
  const { data, error } = await supabase
    .from('builds')
    .update({ ...updateData, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select()
    .single()
  if (error) return res.status(500).json({ error: error.message })

  // Auto-create a proof_products entry the moment a build enters proofread.
  // Keyed on build_id so it persists even after the build leaves the queue.
  if (data.into_proofread) {
    await supabase
      .from('proof_products')
      .upsert(
        {
          product_name: data.product_name,
          language: data.language ?? 'ES',
          build_id: data.id,
          done: false,
        },
        { onConflict: 'build_id', ignoreDuplicates: true }
      )
  }

  res.json(enrichBuild(data))
})

router.delete('/:id', authenticate, requireAdmin, async (req: AuthRequest, res: Response) => {
  const { error } = await supabase.from('builds').delete().eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })
  res.status(204).end()
})

export default router
