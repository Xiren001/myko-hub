-- Add type column to proof_products to distinguish jewelry vs funnel
alter table public.proof_products
  add column if not exists type text not null default 'jewelry'
  check (type in ('jewelry', 'funnel'));
