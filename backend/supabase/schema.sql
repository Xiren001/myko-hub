-- ============================================================
-- Myko Operations Hub — Supabase Schema
-- Run this in the Supabase SQL editor (Project → SQL Editor → New query)
-- ============================================================

-- Profiles (extends auth.users)
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  role text not null default 'viewer' check (role in ('admin', 'approver', 'viewer')),
  created_at timestamptz default now()
);

-- Auto-create profile on signup
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name, role)
  values (new.id, new.raw_user_meta_data->>'full_name', coalesce(new.raw_user_meta_data->>'role', 'viewer'));
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Settings (single row)
create table if not exists public.settings (
  id int primary key default 1,
  build_target_days int default 3,
  proof_target_days int default 3,
  test_target_days int default 7,
  expand_target_days int default 5,
  total_target_days int default 14,
  tool_approval_threshold numeric default 100,
  payment_approval_threshold numeric default 500,
  updated_at timestamptz default now(),
  approver_permissions jsonb default '{"dashboard":true,"jewelry_tracker":true,"funnel_tracker":true,"proofread_queue":true,"mistake_log":true,"monthly_planner":true,"decision_rights":true,"settings":false}'::jsonb,
  constraint single_row check (id = 1)
);

insert into public.settings (id) values (1) on conflict do nothing;

-- Builds (jewelry + funnel unified)
create table if not exists public.builds (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('jewelry', 'funnel')),
  week_number int check (week_number between 1 and 4),
  month_year date,
  product_name text not null,
  language text,
  approved_date date,
  phase1_start date,
  into_proofread date,
  into_testing date,
  outcome_decided date,
  outcome text check (outcome in ('stopped', 'testing', 'expanding')),
  notes text,
  proofreader text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- QA checklist items
create table if not exists public.qa_items (
  id uuid primary key default gen_random_uuid(),
  build_id uuid not null references public.builds(id) on delete cascade,
  item_key text not null,
  done boolean default false,
  notes text,
  completed_at timestamptz,
  unique(build_id, item_key)
);

-- Mistakes
create table if not exists public.mistakes (
  id uuid primary key default gen_random_uuid(),
  date date,
  product_name text,
  category text,
  caught_where text,
  description text,
  root_cause text,
  sop_updated boolean default false,
  notes text,
  month_year date,
  created_at timestamptz default now()
);

-- Report narratives
create table if not exists public.report_narratives (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('weekly', 'monthly')),
  week_number int,
  month_year date not null,
  narrative_text text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(type, week_number, month_year)
);

-- Planner notes
create table if not exists public.planner_notes (
  id uuid primary key default gen_random_uuid(),
  date date not null unique,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ============================================================
-- Row Level Security
-- ============================================================

alter table public.profiles enable row level security;
alter table public.settings enable row level security;
alter table public.builds enable row level security;
alter table public.qa_items enable row level security;
alter table public.mistakes enable row level security;
alter table public.report_narratives enable row level security;
alter table public.planner_notes enable row level security;

-- Helper: get current user role
create or replace function public.current_user_role()
returns text language sql security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid();
$$;

-- Profiles: users can read own profile; admin reads all
create policy "profiles_select" on public.profiles for select using (
  id = auth.uid() or public.current_user_role() = 'admin'
);
create policy "profiles_update" on public.profiles for update using (
  id = auth.uid() or public.current_user_role() = 'admin'
);

-- Settings: everyone reads; only admin writes
create policy "settings_select" on public.settings for select using (auth.uid() is not null);
create policy "settings_update" on public.settings for update using (public.current_user_role() = 'admin');

-- Builds: everyone reads; only admin writes
create policy "builds_select" on public.builds for select using (auth.uid() is not null);
create policy "builds_insert" on public.builds for insert with check (public.current_user_role() = 'admin');
create policy "builds_update" on public.builds for update using (public.current_user_role() = 'admin');
create policy "builds_delete" on public.builds for delete using (public.current_user_role() = 'admin');

-- QA items: everyone reads; only admin writes
create policy "qa_select" on public.qa_items for select using (auth.uid() is not null);
create policy "qa_insert" on public.qa_items for insert with check (public.current_user_role() = 'admin');
create policy "qa_update" on public.qa_items for update using (public.current_user_role() = 'admin');
create policy "qa_delete" on public.qa_items for delete using (public.current_user_role() = 'admin');

-- Mistakes: everyone reads; only admin writes
create policy "mistakes_select" on public.mistakes for select using (auth.uid() is not null);
create policy "mistakes_insert" on public.mistakes for insert with check (public.current_user_role() = 'admin');
create policy "mistakes_update" on public.mistakes for update using (public.current_user_role() = 'admin');
create policy "mistakes_delete" on public.mistakes for delete using (public.current_user_role() = 'admin');

-- Report narratives: everyone reads; admin + approver write
create policy "narratives_select" on public.report_narratives for select using (auth.uid() is not null);
create policy "narratives_insert" on public.report_narratives for insert with check (
  public.current_user_role() in ('admin', 'approver')
);
create policy "narratives_update" on public.report_narratives for update using (
  public.current_user_role() in ('admin', 'approver')
);

-- Planner notes: everyone reads; admin + approver write
create policy "planner_select" on public.planner_notes for select using (auth.uid() is not null);
create policy "planner_insert" on public.planner_notes for insert with check (
  public.current_user_role() in ('admin', 'approver')
);
create policy "planner_update" on public.planner_notes for update using (
  public.current_user_role() in ('admin', 'approver')
);
