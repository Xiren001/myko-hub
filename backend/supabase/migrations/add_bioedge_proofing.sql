-- BioEdge proofreading pipeline — fully separate from the Waves/proof_products stack.
-- Mirrors monday_items/monday_subitems/proof_products/proof_corrections, scoped to
-- BioEdge board 5025150936 (subitems board 5025150942).

create table if not exists public.bioedge_items (
  id uuid primary key default gen_random_uuid(),
  monday_item_id text not null unique,
  name text not null,
  group_name text,
  ad_status text,
  funnel_status text,
  batch text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.bioedge_subitems (
  id uuid primary key default gen_random_uuid(),
  item_id uuid references public.bioedge_items(id) on delete cascade,
  monday_subitem_id text not null unique,
  name text,
  language text,
  targeted_country text,
  ad_status text,
  funnel_status text,
  ads_drive_link text,
  completed_funnel_url text,
  url_path text,
  bundle_names text,
  currency text,
  selling_prices text,
  catalog text,
  buy_now_permalink text,
  fb_page text,
  ad_account text,
  we_tracked boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.bioedge_proof_products (
  id uuid primary key default gen_random_uuid(),
  subitem_id uuid references public.bioedge_subitems(id) on delete set null,
  language text,
  proofreader text,
  product_name text not null,
  pdp_url text,
  monday_url text,
  drive_folder text,
  done boolean not null default false,
  website_done boolean not null default false,
  ads_done boolean not null default false,
  ready_for_revision boolean not null default false,
  ready_for_revision_at timestamptz,
  website_done_at timestamptz,
  ads_done_at timestamptz,
  notified_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.bioedge_proof_corrections (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references public.bioedge_proof_products(id) on delete cascade,
  source text,
  location text,
  original_text text,
  corrected_text text,
  issue_type text,
  severity text,
  notes text,
  done boolean default false,
  created_at timestamptz default now()
);

alter table public.bioedge_items enable row level security;
alter table public.bioedge_subitems enable row level security;
alter table public.bioedge_proof_products enable row level security;
alter table public.bioedge_proof_corrections enable row level security;

drop policy if exists "bioedge_items_select" on public.bioedge_items;
create policy "bioedge_items_select" on public.bioedge_items for select using (auth.uid() is not null);
drop policy if exists "bioedge_items_write" on public.bioedge_items;
create policy "bioedge_items_write" on public.bioedge_items for all using (public.current_user_role() = 'admin');

drop policy if exists "bioedge_subitems_select" on public.bioedge_subitems;
create policy "bioedge_subitems_select" on public.bioedge_subitems for select using (auth.uid() is not null);
drop policy if exists "bioedge_subitems_write" on public.bioedge_subitems;
create policy "bioedge_subitems_write" on public.bioedge_subitems for all using (public.current_user_role() = 'admin');

drop policy if exists "bioedge_proof_products_select" on public.bioedge_proof_products;
create policy "bioedge_proof_products_select" on public.bioedge_proof_products for select using (auth.uid() is not null);
drop policy if exists "bioedge_proof_products_insert" on public.bioedge_proof_products;
create policy "bioedge_proof_products_insert" on public.bioedge_proof_products for insert with check (public.current_user_role() = 'admin');
drop policy if exists "bioedge_proof_products_update" on public.bioedge_proof_products;
create policy "bioedge_proof_products_update" on public.bioedge_proof_products for update using (public.current_user_role() = 'admin');
drop policy if exists "bioedge_proof_products_delete" on public.bioedge_proof_products;
create policy "bioedge_proof_products_delete" on public.bioedge_proof_products for delete using (public.current_user_role() = 'admin');

drop policy if exists "bioedge_proof_corrections_select" on public.bioedge_proof_corrections;
create policy "bioedge_proof_corrections_select" on public.bioedge_proof_corrections for select using (auth.uid() is not null);
drop policy if exists "bioedge_proof_corrections_insert" on public.bioedge_proof_corrections;
create policy "bioedge_proof_corrections_insert" on public.bioedge_proof_corrections for insert with check (public.current_user_role() = 'admin');
drop policy if exists "bioedge_proof_corrections_update" on public.bioedge_proof_corrections;
create policy "bioedge_proof_corrections_update" on public.bioedge_proof_corrections for update using (public.current_user_role() = 'admin');
drop policy if exists "bioedge_proof_corrections_delete" on public.bioedge_proof_corrections;
create policy "bioedge_proof_corrections_delete" on public.bioedge_proof_corrections for delete using (public.current_user_role() = 'admin');

-- Best-effort: add the new proof tables to the realtime publication so
-- useRealtimeRefresh(['bioedge_proof_products', 'bioedge_proof_corrections']) works.
-- Guarded in case the tables are already members (or the publication is managed elsewhere).
do $$
begin
  alter publication supabase_realtime add table public.bioedge_proof_products;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.bioedge_proof_corrections;
exception when duplicate_object then null;
end $$;
