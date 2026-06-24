-- Notification tracking on products
ALTER TABLE proof_products ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ;

-- Per-language email recipients
CREATE TABLE IF NOT EXISTS proof_notification_emails (
  language   TEXT PRIMARY KEY,
  emails     TEXT[] NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Debounce queue: one row per language, upserted on each new product
CREATE TABLE IF NOT EXISTS proof_notification_queue (
  language      TEXT PRIMARY KEY,
  scheduled_for TIMESTAMPTZ NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Global notification settings
CREATE TABLE IF NOT EXISTS proof_notification_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO proof_notification_settings (key, value) VALUES ('delay_minutes', '1')
ON CONFLICT (key) DO NOTHING;
