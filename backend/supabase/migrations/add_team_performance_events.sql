-- Run this in Supabase SQL Editor

create table if not exists public.team_performance_events (
  id uuid primary key default gen_random_uuid(),
  track text not null check (track in ('ads', 'web_dev')),
  person_name text not null,
  monday_subitem_id text not null,
  monday_item_id text,
  week_start date not null,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (track, monday_subitem_id, week_start, person_name)
);

create index if not exists team_performance_events_track_week_idx
  on public.team_performance_events (track, week_start);

alter table public.team_performance_events enable row level security;

create policy "team_performance_events_read" on public.team_performance_events
  for select to authenticated using (true);
