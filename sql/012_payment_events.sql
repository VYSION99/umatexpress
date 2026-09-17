-- Payment webhook idempotency.
-- Run after sql/011_campusride_queue_integrity.sql. Safe to re-run.

-- One row per provider webhook delivery. The composite key lets the webhook
-- detect a replay before it applies any settlement.
CREATE TABLE IF NOT EXISTS payment_events (
  provider    TEXT NOT NULL,
  event_id    TEXT NOT NULL,
  reference   TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (provider, event_id)
);

CREATE INDEX IF NOT EXISTS idx_payment_events_reference
ON payment_events(provider, reference);
