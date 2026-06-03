import { Router, Response } from 'express'
import { supabase } from '../supabase'
import { authenticate, requireAdmin, AuthRequest } from '../middleware/auth'

const QA_ITEMS = [
  // Shared — Shopify product & checkout
  { key: 'shopify_product_live', section: 'shopify', label: 'Product live in Shopify; SKUs, inventory and shipping profile set' },
  { key: 'shopify_variants', section: 'shopify', label: 'Variants correct (jewelry: metal/finish · ring size · chain/bracelet length)' },
  { key: 'shopify_price_tax', section: 'shopify', label: 'Price, tax and shipping configured for this market/currency' },
  { key: 'shopify_checkout_test', section: 'shopify', label: 'Shopify checkout completes; native payment methods for the geo enabled and test-charged' },
  { key: 'shopify_emails_localized', section: 'shopify', label: 'Confirmation/transactional emails localized' },
  // Jewelry — Shopify page
  { key: 'jewelry_page_speed', section: 'jewelry', label: 'Page loads fast on mobile (≈3s); images crisp, zoom works, multiple angles + worn/scale shot' },
  { key: 'jewelry_ctas', section: 'jewelry', label: 'Add-to-cart, all CTAs/links and the sticky mobile buy-bar work' },
  { key: 'jewelry_sizing', section: 'jewelry', label: 'Sizing/ring-size guide present and correct for the locale' },
  { key: 'jewelry_claims', section: 'jewelry', label: 'Material/hallmark claims accurate; reviews & secure-checkout badges shown' },
  // Funnel — Funnelish 2-page funnel
  { key: 'funnel_advertorial_loads', section: 'funnel', label: 'Advertorial page loads fast; headline/images render correctly in target language' },
  { key: 'funnel_sales_page', section: 'funnel', label: 'Sales page: all sections, CTAs, and price points correct for geo/currency' },
  { key: 'funnel_redirect', section: 'funnel', label: 'Sales-page CTA → Shopify checkout redirect fires correctly; cart is not empty and variant is correct' },
  { key: 'funnel_checkout_test', section: 'funnel', label: 'End-to-end test: advertorial → sales → Shopify checkout → order confirmation' },
  // Localization
  { key: 'loc_translation_reviewed', section: 'localization', label: 'Translation reviewed by proofreader; no machine-translation artifacts' },
  { key: 'loc_currency_format', section: 'localization', label: 'Currency symbol and number format match the locale' },
  { key: 'loc_legal', section: 'localization', label: 'Legal/compliance copy (returns, privacy) localized' },
]

const router = Router()

router.get('/:buildId', authenticate, async (req: AuthRequest, res: Response) => {
  const { data: existing } = await supabase
    .from('qa_items')
    .select('*')
    .eq('build_id', req.params.buildId)

  // Merge template with saved state
  const itemMap = Object.fromEntries((existing ?? []).map(i => [i.item_key, i]))
  const items = QA_ITEMS.map(template => ({
    ...template,
    ...(itemMap[template.key] ?? { done: false, notes: null }),
    build_id: req.params.buildId,
  }))
  res.json(items)
})

router.put('/:buildId', authenticate, requireAdmin, async (req: AuthRequest, res: Response) => {
  const updates = req.body as Array<{ key: string; done: boolean; notes?: string }>
  const rows = updates.map(u => ({
    build_id: req.params.buildId,
    item_key: u.key,
    done: u.done,
    notes: u.notes ?? null,
    completed_at: u.done ? new Date().toISOString() : null,
  }))
  const { data, error } = await supabase
    .from('qa_items')
    .upsert(rows, { onConflict: 'build_id,item_key' })
    .select()
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

export default router
