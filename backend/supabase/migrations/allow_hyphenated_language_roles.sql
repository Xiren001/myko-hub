-- Run in Supabase SQL Editor
--
-- Language codes can be regional variants with a hyphen (e.g. "ES-CL", "ES-MX"),
-- pulled straight from proof_products.language. The profiles_role_check constraint
-- only allowed [a-z]+ after the proofreader_ prefix, so creating a proofreader_es-cl
-- login failed with "Database error creating new user".

alter table public.profiles drop constraint if exists profiles_role_check;

alter table public.profiles add constraint profiles_role_check check (
  role in ('admin', 'management', 'ads', 'website', 'proofreader')
  or role ~ '^proofreader_[a-z-]+$'
  or role = 'bioedge_management'
  or role = 'bioedge_ads'
  or role = 'bioedge_website'
  or role = 'bioedge_proofreader'
  or role ~ '^bioedge_proofreader_[a-z-]+$'
);
