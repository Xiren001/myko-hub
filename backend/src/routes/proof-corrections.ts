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

// PUT /products/:id
// admin + management: full update
// proofreader: ready_for_revision only
// ads: done only
// website: pdp_url, drive_folder, done
router.put('/products/:id', authenticate, async (req: AuthRequest, res: Response) => {
  const role = req.userRole ?? ''

  let updateData: Record<string, unknown>
  if (role === 'admin' || role === 'management') {
    updateData = req.body
  } else if (role === 'proofreader') {
    const { ready_for_revision } = req.body as { ready_for_revision?: boolean }
    updateData = { ready_for_revision }
  } else if (role === 'ads') {
    const { done } = req.body as { done?: boolean }
    updateData = { done }
  } else if (role === 'website') {
    const { pdp_url, drive_folder, done } = req.body as { pdp_url?: string; drive_folder?: string; done?: boolean }
    updateData = { pdp_url, drive_folder, done }
  } else {
    return res.status(403).json({ error: 'Insufficient permissions' })
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

// PUT /corrections/:id — admin + management + proofreader + website (full); ads (done only, product must be ready)
router.put('/corrections/:id', authenticate, async (req: AuthRequest, res: Response) => {
  const role = req.userRole ?? ''
  const fullRoles = ['admin', 'management', 'proofreader', 'website']

  if (!fullRoles.includes(role) && role !== 'ads') {
    return res.status(403).json({ error: 'Insufficient permissions' })
  }

  let updateData = req.body
  if (role === 'ads') {
    // ads may only toggle done, and only when the product is ready_for_revision
    const correction = await supabase
      .from('proof_corrections').select('product_id').eq('id', req.params.id).single()
    if (correction.error) return res.status(500).json({ error: correction.error.message })

    const product = await supabase
      .from('proof_products').select('ready_for_revision').eq('id', correction.data.product_id).single()
    if (product.error) return res.status(500).json({ error: product.error.message })
    if (!product.data.ready_for_revision) return res.status(403).json({ error: 'Product is not ready for revision' })

    const { done } = req.body as { done?: boolean }
    updateData = { done }
  }

  const { data, error } = await supabase
    .from('proof_corrections')
    .update(updateData)
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
