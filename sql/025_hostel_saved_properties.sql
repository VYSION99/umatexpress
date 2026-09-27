CREATE TABLE IF NOT EXISTS hostel_saved_properties (
  id TEXT PRIMARY KEY,
  student_email TEXT NOT NULL,
  property_id TEXT NOT NULL,
  period_id TEXT NOT NULL,
  alert_enabled INTEGER NOT NULL DEFAULT 0,
  last_available INTEGER NOT NULL DEFAULT 0,
  generation INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(student_email, property_id, period_id)
);
CREATE INDEX IF NOT EXISTS idx_hostel_saved_student ON hostel_saved_properties(student_email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hostel_saved_alert ON hostel_saved_properties(alert_enabled, last_available, updated_at);
