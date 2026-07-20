import { Router, Response } from 'express'
import { supabase } from '../supabase'
import { authenticate, requireAdmin, AuthRequest } from '../middleware/auth'

const router = Router()

// GET /languages — distinct non-EN languages from proof_products
router.get('/languages', authenticate, requireAdmin, async (_req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('proof_products')
    .select('language')
    .not('language', 'is', null)
    .neq('language', 'EN')

  if (error) return res.status(500).json({ error: error.message })

  const langs = Array.from(new Set((data ?? []).map(r => r.language as string))).sort()
  res.json(langs)
})

// GET /bioedge-languages — distinct non-EN languages from bioedge_proof_products
router.get('/bioedge-languages', authenticate, requireAdmin, async (_req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('bioedge_proof_products')
    .select('language')
    .not('language', 'is', null)
    .neq('language', 'EN')

  if (error) return res.status(500).json({ error: error.message })

  const langs = Array.from(new Set((data ?? []).map(r => r.language as string))).sort()
  res.json(langs)
})

// GET /users — list all auth users with their profile role
router.get('/users', authenticate, requireAdmin, async (_req: AuthRequest, res: Response) => {
  const { data, error } = await supabase.auth.admin.listUsers()
  if (error) return res.status(500).json({ error: error.message })

  const ids = data.users.map(u => u.id)
  const { data: profiles } = await supabase.from('profiles').select('id, role, extra_languages').in('id', ids)

  const roleMap: Record<string, string> = {}
  const extraLangMap: Record<string, string[]> = {}
  for (const p of profiles ?? []) {
    roleMap[p.id] = p.role
    extraLangMap[p.id] = (p.extra_languages as string[] | null) ?? []
  }

  res.json(data.users.map(u => ({
    id: u.id,
    email: u.email,
    role: roleMap[u.id] ?? 'viewer',
    extra_languages: extraLangMap[u.id] ?? [],
    created_at: u.created_at,
  })))
})

// POST /users — create a new auth user and set their profile role
router.post('/users', authenticate, requireAdmin, async (req: AuthRequest, res: Response) => {
  const { email, password, role } = req.body as { email: string; password: string; role: string }

  if (!email || !password || !role) {
    return res.status(400).json({ error: 'email, password, and role are required' })
  }

  const { data: created, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  if (error) return res.status(500).json({ error: error.message })

  await supabase.from('profiles').update({ role }).eq('id', created.user.id)

  res.status(201).json({ id: created.user.id, email: created.user.email, role, extra_languages: [] })
})

// PATCH /users/:id/languages — set the extra languages an existing proofreader login can also access
router.patch('/users/:id/languages', authenticate, requireAdmin, async (req: AuthRequest, res: Response) => {
  const { extra_languages } = req.body as { extra_languages: string[] }

  if (!Array.isArray(extra_languages) || !extra_languages.every(l => typeof l === 'string')) {
    return res.status(400).json({ error: 'extra_languages must be an array of strings' })
  }

  const normalized = [...new Set(extra_languages.map(l => l.toUpperCase()))]

  const { error } = await supabase
    .from('profiles')
    .update({ extra_languages: normalized })
    .eq('id', req.params.id)

  if (error) return res.status(500).json({ error: error.message })

  res.json({ id: req.params.id, extra_languages: normalized })
})

// DELETE /users/:id — delete an auth user
router.delete('/users/:id', authenticate, requireAdmin, async (req: AuthRequest, res: Response) => {
  const { error } = await supabase.auth.admin.deleteUser(req.params.id)
  if (error) return res.status(500).json({ error: error.message })
  res.status(204).end()
})

export default router
