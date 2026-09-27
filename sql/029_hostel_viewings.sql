CREATE TABLE IF NOT EXISTS hostel_viewing_slots (
  id TEXT PRIMARY KEY, property_id TEXT NOT NULL, starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL, capacity INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'OPEN',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hostel_viewing_slots_property ON hostel_viewing_slots(property_id,starts_at,status);
CREATE TABLE IF NOT EXISTS hostel_viewing_requests (
  id TEXT PRIMARY KEY, slot_id TEXT NOT NULL, property_id TEXT NOT NULL,
  student_email TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'PENDING',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(slot_id,student_email)
);
CREATE INDEX IF NOT EXISTS idx_hostel_viewing_requests_slot ON hostel_viewing_requests(slot_id,status);
CREATE INDEX IF NOT EXISTS idx_hostel_viewing_requests_student ON hostel_viewing_requests(student_email,created_at DESC);
