alter table public.profiles add column if not exists extra_languages text[] not null default '{}';
