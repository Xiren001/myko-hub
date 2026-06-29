-- Run in Supabase SQL Editor

create table if not exists public.product_sales (
  product_title text primary key,
  net_sales     numeric not null default 0,
  updated_at    timestamptz default now()
);

alter table public.product_sales enable row level security;

create policy "product_sales_read"
  on public.product_sales for select to authenticated using (true);
