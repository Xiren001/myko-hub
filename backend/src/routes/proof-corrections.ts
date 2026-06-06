import { Router, Response } from 'express'
import { supabase } from '../supabase'
import { authenticate, requireManagement, requireCorrectionWrite, AuthRequest } from '../middleware/auth'

const router = Router()

// GET /products
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

// GET /products/:id/corrections
router.get('/products/:id/corrections', authenticate, async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('proof_corrections')
    .select('*')
    .eq('product_id', req.params.id)
    .order('created_at')

  if (error) return res.status(500).json({ error: error.message })
  res.json(data ?? [])
})

// POST /products — admin + management only
router.post('/products', authenticate, requireManagement, async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('proof_products')
    .insert(req.body)
    .select()
    .single()

  if (error) return res.status(500).json({ error: error.message })
  res.status(201).json(data)
})

// PUT /products/:id — admin + management (full update); website (links only)
router.put('/products/:id', authenticate, async (req: AuthRequest, res: Response) => {
  const role = req.userRole ?? ''
  const fullRoles = ['admin', 'management']
  const linkRoles = ['website']

  if (!fullRoles.includes(role) && !linkRoles.includes(role)) {
    return res.status(403).json({ error: 'Insufficient permissions' })
  }

  let updateData = req.body
  if (linkRoles.includes(role)) {
    // Website may only update the product links
    const { pdp_url, drive_folder } = req.body as { pdp_url?: string; drive_folder?: string }
    updateData = { pdp_url, drive_folder }
  }

  const { data, error } = await supabase
    .from('proof_products')
    .update({ ...updateData, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select()
    .single()

  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// DELETE /products/:id — admin + management only
router.delete('/products/:id', authenticate, requireManagement, async (req: AuthRequest, res: Response) => {
  const { error } = await supabase.from('proof_products').delete().eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })
  res.status(204).end()
})

// POST /corrections — admin + management + proofreader + website
router.post('/corrections', authenticate, requireCorrectionWrite, async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('proof_corrections')
    .insert(req.body)
    .select()
    .single()

  if (error) return res.status(500).json({ error: error.message })
  res.status(201).json(data)
})

// PUT /corrections/:id — admin + management + proofreader + website
router.put('/corrections/:id', authenticate, requireCorrectionWrite, async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('proof_corrections')
    .update(req.body)
    .eq('id', req.params.id)
    .select()
    .single()

  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// DELETE /corrections/:id — admin + management + proofreader + website
router.delete('/corrections/:id', authenticate, requireCorrectionWrite, async (req: AuthRequest, res: Response) => {
  const { error } = await supabase.from('proof_corrections').delete().eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })
  res.status(204).end()
})

export default router
