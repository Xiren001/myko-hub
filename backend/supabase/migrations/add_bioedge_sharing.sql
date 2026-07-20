-- Opt-in toggle: when true, Waves and BioEdge logins/notifications are no
-- longer kept separate — any login can see both systems' data, and BioEdge
-- auto-notifications reuse the Waves email list/delay instead of their own.
alter table public.settings add column if not exists share_bioedge_with_waves boolean not null default false;
