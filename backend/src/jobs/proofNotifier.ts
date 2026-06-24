import { Resend } from 'resend'
import { supabase } from '../supabase'

const resend = new Resend(process.env.RESEND_API_KEY)
const FROM_EMAIL = process.env.NOTIFICATION_FROM_EMAIL ?? 'EcomFaszik <notifications@notification.thenivora.co>'
const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:3000'

export interface NotifyResult {
  sent: boolean
  count: number
  reason?: string
}

export async function sendProofNotificationsForLanguage(language: string): Promise<NotifyResult> {
  const { data: products, error: prodErr } = await supabase
    .from('proof_products')
    .select('id, product_name, pdp_url')
    .eq('language', language)
    .is('notified_at', null)
    .eq('done', false)

  if (prodErr) return { sent: false, count: 0, reason: prodErr.message }
  if (!products?.length) return { sent: false, count: 0, reason: 'no pending products' }

  const { data: emailConfig } = await supabase
    .from('proof_notification_emails')
    .select('emails')
    .eq('language', language)
    .maybeSingle()

  if (!emailConfig?.emails?.length) return { sent: false, count: products.length, reason: 'no emails configured' }

  const count = products.length
  const subject = `${count} product${count > 1 ? 's' : ''} waiting for ${language} proofread`

  const rows = products.map(p => `
    <tr>
      <td style="padding:10px 12px;font-size:14px;color:#111;border-bottom:1px solid #f0f0f0;">
        ${p.product_name}
      </td>
      <td style="padding:10px 12px;text-align:right;border-bottom:1px solid #f0f0f0;">
        ${p.pdp_url ? `<a href="${p.pdp_url}" style="color:#5b4aff;font-size:12px;text-decoration:none;">View PDP →</a>` : ''}
      </td>
    </tr>`).join('')

  const html = `
<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111;">
  <h2 style="font-size:18px;margin:0 0 8px;">
    ${count} product${count > 1 ? 's' : ''} waiting for <strong>${language}</strong> proofread
  </h2>
  <p style="color:#555;font-size:14px;margin:0 0 20px;">
    The following product${count > 1 ? 's are' : ' is'} ready for your review:
  </p>
  <table style="width:100%;border-collapse:collapse;background:#fafafa;border-radius:8px;overflow:hidden;">
    ${rows}
  </table>
  <p style="margin-top:24px;">
    <a href="${FRONTEND_URL}/proofread-queue"
       style="display:inline-block;background:#5b4aff;color:#fff;text-decoration:none;
              padding:10px 20px;border-radius:6px;font-size:14px;font-weight:500;">
      Open Proofreading Queue →
    </a>
  </p>
  <p style="color:#aaa;font-size:11px;margin-top:24px;">
    You received this because you are assigned as a ${language} proofreader.
  </p>
</div>`

  const results = await Promise.all(
    emailConfig.emails.map((to: string) =>
      resend.emails.send({ from: FROM_EMAIL, to, subject, html })
    )
  )

  const failed = results.filter(r => r.error)
  if (failed.length) {
    const reasons = failed.map(r => r.error?.message ?? 'unknown').join('; ')
    return { sent: false, count, reason: `Resend error: ${reasons}` }
  }

  await supabase
    .from('proof_products')
    .update({ notified_at: new Date().toISOString() })
    .in('id', products.map(p => p.id))

  return { sent: true, count }
}
