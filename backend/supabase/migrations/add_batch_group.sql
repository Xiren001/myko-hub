-- Add batch_group to builds table for the Jewelry Tracker batch grouping feature
ALTER TABLE public.builds ADD COLUMN IF NOT EXISTS batch_group integer;
