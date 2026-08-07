-- Run this in Supabase SQL Editor

-- Singleton row: existence of the row means the one-time backfill scan has already run.
create table if not exists public.team_performance_backfill (
  id int primary key default 1,
  ran_at timestamptz not null default now(),
  constraint team_performance_backfill_singleton check (id = 1)
);

alter table public.team_performance_backfill enable row level security;

create policy "team_performance_backfill_read" on public.team_performance_backfill
  for select to authenticated using (true);
