import { Router, Response } from 'express'
import { supabase } from '../supabase'
import { authenticate, requireAdmin, AuthRequest } from '../middleware/auth'

const router = Router()

// GET /products — list all proof_products with correction_count
router.get('/products', authenticate, async (_req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('proof_products')
    .select('*')
    .order('language')
    .order('product_name')

  if (error) return res.status(500).json({ error: error.message })

  const { data: counts } = await supabase
    .from('proof_corrections')
    .select('product_id')

  const countMap: Record<string, number> = {}
  for (const c of counts ?? []) {
    countMap[c.product_id] = (countMap[c.product_id] ?? 0) + 1
  }

  const products = (data ?? []).map(p => ({ ...p, correction_count: countMap[p.id] ?? 0 }))
  res.json(products)
})

// GET /products/:id/corrections — list corrections for a product
router.get('/products/:id/corrections', authenticate, async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('proof_corrections')
    .select('*')
    .eq('product_id', req.params.id)
    .order('created_at')

  if (error) return res.status(500).json({ error: error.message })
  res.json(data ?? [])
})

// POST /products — create product (admin only)
router.post('/products', authenticate, requireAdmin, async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('proof_products')
    .insert(req.body)
    .select()
    .single()

  if (error) return res.status(500).json({ error: error.message })
  res.status(201).json(data)
})

// PUT /products/:id — update product (admin only)
router.put('/products/:id', authenticate, requireAdmin, async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('proof_products')
    .update({ ...req.body, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select()
    .single()

  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// DELETE /products/:id — delete product (admin only)
router.delete('/products/:id', authenticate, requireAdmin, async (req: AuthRequest, res: Response) => {
  const { error } = await supabase.from('proof_products').delete().eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })
  res.status(204).end()
})

// POST /corrections — create correction (admin only)
router.post('/corrections', authenticate, requireAdmin, async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('proof_corrections')
    .insert(req.body)
    .select()
    .single()

  if (error) return res.status(500).json({ error: error.message })
  res.status(201).json(data)
})

// PUT /corrections/:id — update correction (admin only)
router.put('/corrections/:id', authenticate, requireAdmin, async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('proof_corrections')
    .update(req.body)
    .eq('id', req.params.id)
    .select()
    .single()

  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// DELETE /corrections/:id — delete correction (admin only)
router.delete('/corrections/:id', authenticate, requireAdmin, async (req: AuthRequest, res: Response) => {
  const { error } = await supabase.from('proof_corrections').delete().eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })
  res.status(204).end()
})

export default router
