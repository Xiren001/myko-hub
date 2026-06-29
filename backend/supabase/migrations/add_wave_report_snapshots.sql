-- Run in Supabase SQL Editor

create table if not exists public.wave_report_snapshots (
  id          uuid primary key default gen_random_uuid(),
  week_start  date unique not null,
  week_end    date not null,
  data        jsonb not null,
  created_at  timestamptz default now()
);

alter table public.wave_report_snapshots enable row level security;

create policy "wave_report_snapshots_read"
  on public.wave_report_snapshots for select to authenticated using (true);

-- Insert the cron schedule default into proof_notification_settings if not already present
insert into public.proof_notification_settings (key, value)
values ('wave_report_cron', '{"day":6,"hour":22,"minute":0,"timezone":"Asia/Manila"}')
on conflict (key) do nothing;
