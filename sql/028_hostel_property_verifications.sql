CREATE TABLE IF NOT EXISTS hostel_property_verifications (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  note TEXT NOT NULL,
  reviewed_by TEXT NOT NULL,
  reviewed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hostel_verifications_property ON hostel_property_verifications(property_id,kind,reviewed_at DESC);
