-- Payment tracking for the BioEdge proofreading pipeline, mirroring proof_products.paid/paid_at.
alter table public.bioedge_proof_products
  add column if not exists paid boolean not null default false,
  add column if not exists paid_at timestamptz;
