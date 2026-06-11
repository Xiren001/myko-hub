import { Router, Response } from 'express'
import { supabase } from '../supabase'
import { authenticate, requireManagement, requireCorrectionWrite, AuthRequest } from '../middleware/auth'

const router = Router()

// GET /products
router.get('/products', authenticate, async (req: AuthRequest, res: Response) => {
  let q = supabase.from('proof_products').select('*').order('language').order('product_name')
  if (req.userLang) q = q.eq('language', req.userLang)

  const { data, error } = await q
  if (error) return res.status(500).json({ error: error.message })

  const { data: counts } = await supabase.from('proof_corrections').select('product_id')

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
// ads: ads_done only
// website: pdp_url, drive_folder, website_done
// done is auto-computed as website_done AND ads_done for ads/website roles
router.put('/products/:id', authenticate, async (req: AuthRequest, res: Response) => {
  const role = req.userRole ?? ''

  let updateData: Record<string, unknown>
  if (role === 'admin' || role === 'management') {
    const { correction_count, ...rest } = req.body
    updateData = rest
  } else if (role === 'proofreader') {
    const { ready_for_revision } = req.body as { ready_for_revision?: boolean }
    updateData = { ready_for_revision }
  } else if (role === 'ads') {
    const { ads_done } = req.body as { ads_done?: boolean }
    updateData = { ads_done }
  } else if (role === 'website') {
    const { pdp_url, drive_folder, website_done } = req.body as { pdp_url?: string; drive_folder?: string; website_done?: boolean }
    updateData = Object.fromEntries(
      Object.entries({ pdp_url, drive_folder, website_done }).filter(([, v]) => v !== undefined)
    )
  } else {
    return res.status(403).json({ error: 'Insufficient permissions' })
  }

  // Lang proofreaders can only write to their own language
  if (req.userLang) {
    const { data: existing } = await supabase.from('proof_products').select('language').eq('id', req.params.id).single()
    if (existing?.language !== req.userLang) return res.status(403).json({ error: 'Language access denied' })
  }

  // Auto-compute done = website_done AND ads_done when a split flag is updated
  let prevDone: boolean | undefined
  if ('website_done' in updateData || 'ads_done' in updateData) {
    const { data: cur } = await supabase
      .from('proof_products')
      .select('website_done, ads_done, done')
      .eq('id', req.params.id)
      .single()
    if (cur) {
      prevDone = cur.done
      const webDone = 'website_done' in updateData ? (updateData.website_done as boolean) : cur.website_done
      const adsDone = 'ads_done'     in updateData ? (updateData.ads_done     as boolean) : cur.ads_done
      updateData.done = webDone && adsDone
    }
  }

  const { data, error } = await supabase
    .from('proof_products')
    .update({ ...updateData, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select()
    .single()

  if (error) return res.status(500).json({ error: error.message })

  // Sync to linked jewelry build when done actually changes
  const doneChanged = 'done' in updateData && (
    (role === 'admin' || role === 'management') || data.done !== prevDone
  )
  if (doneChanged && data.language && data.language !== 'EN') {
    const isDone = data.done as boolean
    const today = new Date().toISOString().split('T')[0]
    if (isDone) {
      await supabase.from('builds')
        .update({ proof_end: today, updated_at: new Date().toISOString() })
        .eq('product_name', data.product_name)
        .eq('language', data.language)
        .eq('type', 'jewelry')
        .not('into_proofread', 'is', null)
        .is('proof_end', null)
    } else {
      await supabase.from('builds')
        .update({ proof_end: null, updated_at: new Date().toISOString() })
        .eq('product_name', data.product_name)
        .eq('language', data.language)
        .eq('type', 'jewelry')
        .not('into_proofread', 'is', null)
    }
  }

  // Sync monday_url back to the matching jewelry build
  if ('monday_url' in updateData && data.language && data.language !== 'EN') {
    await supabase.from('builds')
      .update({ monday_url: (data.monday_url ?? null), updated_at: new Date().toISOString() })
      .eq('product_name', data.product_name as string)
      .eq('language', data.language as string)
      .eq('type', 'jewelry')
      .not('into_proofread', 'is', null)
  }

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
