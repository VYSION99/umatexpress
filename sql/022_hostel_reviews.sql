-- 022: hostel reviews — the score a paid stay earns.
--
-- One row per booking, written by the student whose own paid bed it was, so the
-- average cannot be manufactured. A landlord may answer once, and staff may
-- hide a review (with a reason) but never edit or delete one.

CREATE TABLE IF NOT EXISTS hostel_reviews (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL,
  property_id TEXT NOT NULL,
  landlord_id TEXT NOT NULL,
  period_id TEXT NOT NULL DEFAULT '',
  student_email TEXT NOT NULL,
  student_name TEXT NOT NULL DEFAULT '',
  rating INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'PUBLISHED',
  reply TEXT NOT NULL DEFAULT '',
  reply_by TEXT NOT NULL DEFAULT '',
  replied_at TEXT NOT NULL DEFAULT '',
  hidden_reason TEXT NOT NULL DEFAULT '',
  moderated_by TEXT NOT NULL DEFAULT '',
  moderated_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_hostel_reviews_booking ON hostel_reviews(booking_id);
CREATE INDEX IF NOT EXISTS idx_hostel_reviews_property ON hostel_reviews(property_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hostel_reviews_landlord ON hostel_reviews(landlord_id, status, created_at DESC);
