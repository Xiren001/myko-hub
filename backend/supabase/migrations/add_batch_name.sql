-- Add batch_name to builds for custom batch renaming
ALTER TABLE public.builds ADD COLUMN IF NOT EXISTS batch_name text;
