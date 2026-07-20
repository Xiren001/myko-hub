-- Direct link to the subitem's Monday.com pulse, so BioEdge proofreading
-- entries can carry a monday_url the same way the UI already renders one.
alter table public.bioedge_subitems add column if not exists monday_url text;
