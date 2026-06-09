-- Track per-product proofreader payments (admin marks paid after paying)
alter table public.proof_products
  add column if not exists paid    boolean not null default false,
  add column if not exists paid_at date;
