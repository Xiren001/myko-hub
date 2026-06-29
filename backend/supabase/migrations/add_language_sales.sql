-- Run in Supabase SQL Editor

create table if not exists public.language_sales (
  lang_code text primary key,
  country   text not null,
  net_sales numeric not null default 0,
  cogs      numeric not null default 0,
  updated_at timestamptz default now()
);

alter table public.language_sales enable row level security;

create policy "language_sales_read"
  on public.language_sales for select to authenticated using (true);
