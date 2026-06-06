-- Assign a role to a user by email
-- Run this in the Supabase SQL Editor
-- Roles: admin | management | proofreader | ads | website

update public.profiles
set role = 'proofreader'           -- ← change role here
where id = (
  select id from auth.users
  where email = 'user@example.com' -- ← change email here
);
