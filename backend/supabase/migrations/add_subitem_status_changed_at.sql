-- Track when ad_status / website_status last changed on monday_subitems.
-- Unlike the lp_* phase timestamps (stamped once, first time), these are
-- overwritten on every change so the Team Queue can show how long an item
-- has been sitting in its *current* status.

ALTER TABLE public.monday_subitems
  ADD COLUMN IF NOT EXISTS ad_status_changed_at      timestamptz,
  ADD COLUMN IF NOT EXISTS website_status_changed_at timestamptz;
