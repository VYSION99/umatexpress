-- Durable webhook processing. Safe to rerun; legacy event claims remain untouched.
CREATE TABLE IF NOT EXISTS payment_inbox (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  event_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  reference TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PROCESSING','PROCESSED','REVIEW')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  lease_token TEXT,
  lease_until TEXT,
  last_error TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  UNIQUE(provider, event_type, resource_id)
);
CREATE INDEX IF NOT EXISTS idx_payment_inbox_due ON payment_inbox(status, available_at, lease_until);
