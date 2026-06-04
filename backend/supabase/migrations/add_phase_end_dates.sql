alter table public.builds
  add column if not exists phase1_end date,
  add column if not exists proof_end date;
