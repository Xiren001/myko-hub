create table if not exists public.proof_products (
  id uuid primary key default gen_random_uuid(),
  language text,
  proofreader text,
  product_name text not null,
  pdp_url text,
  drive_folder text,
  done boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.proof_corrections (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references public.proof_products(id) on delete cascade,
  location text,
  original_text text,
  corrected_text text,
  issue_type text,
  severity text,
  notes text,
  done boolean default false,
  created_at timestamptz default now()
);

alter table public.proof_products enable row level security;
alter table public.proof_corrections enable row level security;

create policy "proof_products_select" on public.proof_products for select using (auth.uid() is not null);
create policy "proof_products_insert" on public.proof_products for insert with check (public.current_user_role() = 'admin');
create policy "proof_products_update" on public.proof_products for update using (public.current_user_role() = 'admin');
create policy "proof_products_delete" on public.proof_products for delete using (public.current_user_role() = 'admin');

create policy "proof_corrections_select" on public.proof_corrections for select using (auth.uid() is not null);
create policy "proof_corrections_insert" on public.proof_corrections for insert with check (public.current_user_role() = 'admin');
create policy "proof_corrections_update" on public.proof_corrections for update using (public.current_user_role() = 'admin');
create policy "proof_corrections_delete" on public.proof_corrections for delete using (public.current_user_role() = 'admin');
