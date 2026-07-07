-- Run in Supabase SQL Editor

create table if not exists public.wave_report_monthly_snapshots (
  id          uuid primary key default gen_random_uuid(),
  month_start date unique not null,
  month_end   date not null,
  data        jsonb not null,
  created_at  timestamptz default now()
);

alter table public.wave_report_monthly_snapshots enable row level security;

create policy "wave_report_monthly_snapshots_read"
  on public.wave_report_monthly_snapshots for select to authenticated using (true);

-- Insert the monthly cron schedule default into proof_notification_settings if not already present
-- dayOfMonth is capped at 28 so the snapshot fires in every month (including February)
insert into public.proof_notification_settings (key, value)
values ('wave_report_monthly_cron', '{"dayOfMonth":28,"hour":22,"minute":0,"timezone":"Asia/Manila"}')
on conflict (key) do nothing;
