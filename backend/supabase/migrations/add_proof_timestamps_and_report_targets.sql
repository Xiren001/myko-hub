-- Timestamps on proof_products for turnaround tracking
ALTER TABLE public.proof_products
  ADD COLUMN IF NOT EXISTS ready_for_revision_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS website_done_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ads_done_at            TIMESTAMPTZ;

-- Seed today's timestamp for existing records
UPDATE public.proof_products SET ready_for_revision_at = NOW() WHERE ready_for_revision = TRUE AND ready_for_revision_at IS NULL;
UPDATE public.proof_products SET website_done_at        = NOW() WHERE website_done       = TRUE AND website_done_at        IS NULL;
UPDATE public.proof_products SET ads_done_at            = NOW() WHERE ads_done           = TRUE AND ads_done_at            IS NULL;

-- New configurable target columns on settings
ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS proofread_turnaround_target_days INT NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS web_revision_target_days         INT NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS ads_revision_target_days         INT NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS en_completion_target_days        INT NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS es_de_translation_target_days    INT NOT NULL DEFAULT 4,
  ADD COLUMN IF NOT EXISTS total_translation_target_days    INT NOT NULL DEFAULT 7;
