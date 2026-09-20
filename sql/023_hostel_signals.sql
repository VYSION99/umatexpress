-- 023: hostel trust signals — the patterns a person should look at.
--
-- A signal is evidence, not a verdict: nothing here suspends a listing, holds a
-- payout or blocks a booking. One row per pattern per entity while it is open,
-- refreshed by a rescan, so the queue cannot fill with duplicates.

CREATE TABLE IF NOT EXISTS hostel_risk_signals (
  id TEXT PRIMARY KEY,
  signal_key TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'MEDIUM',
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  landlord_id TEXT NOT NULL DEFAULT '',
  property_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  evidence TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'OPEN',
  reviewed_by TEXT NOT NULL DEFAULT '',
  reviewed_at TEXT NOT NULL DEFAULT '',
  review_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_hostel_signals_entity ON hostel_risk_signals(signal_key, entity_id, status);
CREATE INDEX IF NOT EXISTS idx_hostel_signals_status ON hostel_risk_signals(status, severity, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hostel_signals_landlord ON hostel_risk_signals(landlord_id, status);
