-- Track landing_page_status phase timestamps on monday_items
-- Populated automatically by the Monday.com webhook when status changes

ALTER TABLE public.monday_items
  ADD COLUMN IF NOT EXISTS lp_building_at        timestamptz,
  ADD COLUMN IF NOT EXISTS lp_ready_at           timestamptz,
  ADD COLUMN IF NOT EXISTS lp_proofread_at       timestamptz,
  ADD COLUMN IF NOT EXISTS lp_ready_to_launch_at timestamptz,
  ADD COLUMN IF NOT EXISTS lp_launched_at        timestamptz;
