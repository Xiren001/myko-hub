import { Router, Response } from 'express'
import { supabase } from '../supabase'
import { authenticate, requireAdmin, requireManagement, AuthRequest } from '../middleware/auth'
import { enrichBuild, monthStart, monthEnd } from '../utils/calculations'

const router = Router()

router.get('/proofread-queue', authenticate, async (req: AuthRequest, res: Response) => {
  const buildType = (req.query.type as string) || 'jewelry'
  let query = supabase
    .from('builds')
    .select('*')
    .not('into_proofread', 'is', null)
    .is('proof_end', null)
    .or('outcome.is.null,outcome.neq.stopped')
    .eq('type', buildType)
    .neq('language', 'EN')
    .order('into_proofread', { ascending: true })

  const { data, error } = await query
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

router.post('/', authenticate, requireManagement, async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase.from('builds').insert(req.body).select().single()
  if (error) return res.status(500).json({ error: error.message })

  if (data.into_proofread && data.language && data.language !== 'EN' &&
      (data.type === 'jewelry' || data.type === 'funnel')) {
    const { count } = await supabase
      .from('proof_products')
      .select('id', { count: 'exact', head: true })
      .eq('product_name', data.product_name)
      .eq('language', data.language)
      .eq('type', data.type)
    if ((count ?? 0) === 0) {
      await supabase.from('proof_products').insert({
        product_name: data.product_name,
        language:     data.language,
        proofreader:  data.proofreader ?? null,
        type:         data.type,
        done:         false,
      })
    }
  }

  res.status(201).json(enrichBuild(data))
})

router.put('/:id', authenticate, requireAdmin, async (req: AuthRequest, res: Response) => {
  // Capture old language before update so we can detect language changes
  const { data: before } = await supabase
    .from('builds')
    .select('language')
    .eq('id', req.params.id)
    .single()

  // Strip computed fields that don't exist as DB columns
  const { phase, build_days, proof_days, test_days, total_days, created_at, ...updateData } = req.body
  const { data, error } = await supabase
    .from('builds')
    .update({ ...updateData, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select()
    .single()
  if (error) return res.status(500).json({ error: error.message })

  // Auto-create/sync a proof_products entry when a build is in proofread.
  // If the language changed, update the existing entry instead of creating a duplicate.
  if (data.into_proofread && data.language && data.language !== 'EN' &&
      (data.type === 'jewelry' || data.type === 'funnel')) {
    const newLang = data.language as string
    const oldLang = before?.language as string | undefined
    const buildType = data.type as string

    if (oldLang && oldLang !== newLang) {
      await supabase.from('proof_products')
        .update({ language: newLang })
        .eq('product_name', data.product_name)
        .eq('language', oldLang)
        .eq('type', buildType)
    } else {
      const { count } = await supabase
        .from('proof_products')
        .select('id', { count: 'exact', head: true })
        .eq('product_name', data.product_name)
        .eq('language', newLang)
        .eq('type', buildType)

      if ((count ?? 0) === 0) {
        await supabase.from('proof_products').insert({
          product_name: data.product_name,
          language:     newLang,
          proofreader:  data.proofreader ?? null,
          type:         buildType,
          done:         false,
        })
      }
    }
  }

  res.json(enrichBuild(data))
})

router.delete('/:id', authenticate, requireAdmin, async (req: AuthRequest, res: Response) => {
  const { error } = await supabase.from('builds').delete().eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })
  res.status(204).end()
})

export default router
