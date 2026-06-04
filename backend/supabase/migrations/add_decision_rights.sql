create table if not exists public.decision_rights (
  id uuid primary key default gen_random_uuid(),
  section text not null default '',
  decision text not null,
  myko text not null default '—',
  abigel text not null default '—',
  owner text not null default '—',
  sort_order int default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.decision_rights enable row level security;

create policy "decision_rights_select" on public.decision_rights for select using (auth.uid() is not null);
create policy "decision_rights_insert" on public.decision_rights for insert with check (public.current_user_role() = 'admin');
create policy "decision_rights_update" on public.decision_rights for update using (public.current_user_role() = 'admin');
create policy "decision_rights_delete" on public.decision_rights for delete using (public.current_user_role() = 'admin');
