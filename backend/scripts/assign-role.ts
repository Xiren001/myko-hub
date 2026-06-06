/**
 * Assign a role to a user by email.
 * Usage: npm run assign-role -- <email> <role>
 * Roles: admin | management | proofreader | ads | website
 *
 * Example:
 *   npm run assign-role -- john@example.com proofreader
 */
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

dotenv.config()

const VALID_ROLES = ['admin', 'management', 'proofreader', 'ads', 'website'] as const
type Role = typeof VALID_ROLES[number]

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

async function main() {
  const [email, role] = process.argv.slice(2)

  if (!email || !role) {
    console.error('Usage: npm run assign-role -- <email> <role>')
    console.error(`Roles: ${VALID_ROLES.join(' | ')}`)
    process.exit(1)
  }

  if (!VALID_ROLES.includes(role as Role)) {
    console.error(`Invalid role "${role}". Must be one of: ${VALID_ROLES.join(', ')}`)
    process.exit(1)
  }

  // Look up user by email via admin API
  const { data: { users }, error: listErr } = await supabase.auth.admin.listUsers()
  if (listErr) throw listErr

  const user = users.find(u => u.email === email)
  if (!user) {
    console.error(`No user found with email: ${email}`)
    process.exit(1)
  }

  // Upsert into profiles
  const { error: upsertErr } = await supabase
    .from('profiles')
    .upsert({ id: user.id, role }, { onConflict: 'id' })

  if (upsertErr) throw upsertErr

  console.log(`✓ Assigned role "${role}" to ${email} (${user.id})`)
}

main().catch(err => {
  console.error('Failed:', err.message)
  process.exit(1)
})
