-- Track website_status phase timestamps on monday_subitems
-- Populated automatically by the Monday.com webhook when website_status changes

ALTER TABLE public.monday_subitems
  ADD COLUMN IF NOT EXISTS lp_building_at        timestamptz,
  ADD COLUMN IF NOT EXISTS lp_ready_at           timestamptz,
  ADD COLUMN IF NOT EXISTS lp_proofread_at       timestamptz,
  ADD COLUMN IF NOT EXISTS lp_ready_to_launch_at timestamptz,
  ADD COLUMN IF NOT EXISTS lp_launched_at        timestamptz;
