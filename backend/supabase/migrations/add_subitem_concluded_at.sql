-- Track when an ad subitem's "concluded" checkbox first ticks true, so
-- ads funnel duration (created_at → concluded_at) can be reported.
ALTER TABLE public.monday_subitems
  ADD COLUMN IF NOT EXISTS concluded_at timestamptz;

