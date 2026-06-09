-- Split the single `done` flag into per-team flags
-- website_done: set by the website team when they finish applying website corrections
-- ads_done:     set by the ads team when they finish applying ads corrections
-- done:         auto-computed by the backend as website_done AND ads_done

alter table public.proof_products
  add column if not exists website_done boolean not null default false,
  add column if not exists ads_done     boolean not null default false;

-- Backfill: products already marked done get both flags set
update public.proof_products
set website_done = true, ads_done = true
where done = true;
