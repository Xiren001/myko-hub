-- Run this in Supabase SQL Editor

create table if not exists public.monday_waves (
  id uuid primary key default gen_random_uuid(),
  wave_number int not null,
  board_id text unique,
  name text not null,
  description text,
  created_at timestamptz default now()
);

create table if not exists public.monday_items (
  id uuid primary key default gen_random_uuid(),
  wave_id uuid not null references public.monday_waves(id) on delete cascade,
  monday_item_id text unique,
  name text not null,
  group_name text,
  creatives_status text,
  landing_page_status text,
  drive_link text,
  found_by text,
  sort_order int default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.monday_subitems (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.monday_items(id) on delete cascade,
  monday_subitem_id text unique,
  name text not null,
  ad_status text,
  website_status text,
  concluded boolean default false,
  listed_for_proofread boolean default false,
  product_name text,
  shopify_pdp_link text,
  page_link text,
  drive_link text,
  meta boolean default false,
  tiktok boolean default false,
  youtube boolean default false,
  pinterest boolean default false,
  google_shopping boolean default false,
  google_search boolean default false,
  sort_order int default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Enable realtime
alter publication supabase_realtime add table monday_waves;
alter publication supabase_realtime add table monday_items;
alter publication supabase_realtime add table monday_subitems;

-- RLS: authenticated users can read
alter table public.monday_waves enable row level security;
alter table public.monday_items enable row level security;
alter table public.monday_subitems enable row level security;

create policy "monday_waves_read"    on public.monday_waves    for select to authenticated using (true);
create policy "monday_items_read"    on public.monday_items    for select to authenticated using (true);
create policy "monday_subitems_read" on public.monday_subitems for select to authenticated using (true);
