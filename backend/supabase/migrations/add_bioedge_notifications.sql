-- BioEdge notification pipeline — fully separate from proof_notification_*,
-- mirroring add_proof_notifications.sql but scoped to bioedge_proof_products.
CREATE TABLE IF NOT EXISTS bioedge_notification_emails (
  language   TEXT PRIMARY KEY,
  emails     TEXT[] NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bioedge_notification_queue (
  language      TEXT PRIMARY KEY,
  scheduled_for TIMESTAMPTZ NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bioedge_notification_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO bioedge_notification_settings (key, value) VALUES ('delay_minutes', '1')
ON CONFLICT (key) DO NOTHING;
