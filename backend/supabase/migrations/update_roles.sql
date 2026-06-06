-- Update profiles role constraint from old roles (admin/approver/viewer)
-- to new roles (admin/management/proofreader/ads/website)

alter table public.profiles
  drop constraint if exists profiles_role_check;

alter table public.profiles
  add constraint profiles_role_check
  check (role in ('admin', 'management', 'proofreader', 'ads', 'website'));

-- Update existing rows: approver → management, viewer → website
update public.profiles set role = 'management' where role = 'approver';
update public.profiles set role = 'website'    where role = 'viewer';

-- Update default for new signups
alter table public.profiles
  alter column role set default 'website';

-- Update the trigger function default
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name, role)
  values (
    new.id,
    new.raw_user_meta_data->>'full_name',
    coalesce(new.raw_user_meta_data->>'role', 'website')
  );
  return new;
end;
$$;
