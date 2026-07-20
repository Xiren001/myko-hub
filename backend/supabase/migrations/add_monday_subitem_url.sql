-- Direct link to the subitem's Monday.com pulse, so proof_products entries
-- auto-created from Waves subitems carry a monday_url too, same as BioEdge.
alter table public.monday_subitems add column if not exists monday_url text;
