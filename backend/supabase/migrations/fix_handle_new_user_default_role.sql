-- Run in Supabase SQL Editor
--
-- The live handle_new_user() trigger still defaulted new profiles to the
-- old 'viewer' role, which update_roles.sql renamed to 'website' years ago
-- and removed from profiles_role_check. Since POST /api/admin/users/users
-- never passes a role in user_metadata, every new-user insert hit this
-- default and violated the check constraint — unrelated to the hyphenated
-- language-code fix, this breaks ALL new user creation.

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
