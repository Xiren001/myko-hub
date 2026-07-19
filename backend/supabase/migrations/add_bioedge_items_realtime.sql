-- bioedge_items/bioedge_subitems were missing from the realtime publication,
-- so the /bioedge tracker page's useRealtimeRefresh(['bioedge_items', 'bioedge_subitems'])
-- never received live updates — only bioedge_proof_products/corrections were added
-- in add_bioedge_proofing.sql. Guarded so it's safe to re-run.

do $$
begin
  alter publication supabase_realtime add table public.bioedge_items;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.bioedge_subitems;
exception when duplicate_object then null;
end $$;
