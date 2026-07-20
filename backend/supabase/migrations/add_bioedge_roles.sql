-- Relax profiles.role's CHECK constraint to also allow bioedge_* role variants
-- (bioedge_management, bioedge_ads, bioedge_website, bioedge_proofreader_<lang>) —
-- the BioEdge-system equivalents of the existing management/ads/website/proofreader_<lang>
-- roles, kept as fully separate logins (see backend/src/middleware/auth.ts's system tagging).
--
-- The existing literal-list constraint from update_roles.sql doesn't even cover
-- proofreader_es today (it must have been relaxed directly in Supabase outside
-- tracked migrations) — this replaces it with a regex-based constraint that
-- actually reflects what the app uses, admin included.
alter table public.profiles drop constraint if exists profiles_role_check;

alter table public.profiles add constraint profiles_role_check check (
  role in ('admin', 'management', 'ads', 'website')
  or role ~ '^proofreader_[a-z]+$'
  or role = 'bioedge_management'
  or role = 'bioedge_ads'
  or role = 'bioedge_website'
  or role ~ '^bioedge_proofreader_[a-z]+$'
);
