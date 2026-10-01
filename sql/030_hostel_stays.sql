-- Occupancy is independent of payment. Existing paid bookings await staff check-in.
CREATE TABLE IF NOT EXISTS hostel_stays (
  booking_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'EXPECTED' CHECK(status IN ('EXPECTED','CHECKED_IN','CHECKED_OUT','NO_SHOW','CANCELLED')),
  expected_arrival_on TEXT NOT NULL DEFAULT '',
  checked_in_at TEXT NOT NULL DEFAULT '',
  checked_out_at TEXT NOT NULL DEFAULT '',
  key_reference TEXT NOT NULL DEFAULT '',
  updated_by TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS hostel_stay_events (
  id TEXT PRIMARY KEY, booking_id TEXT NOT NULL, landlord_id TEXT NOT NULL,
  action TEXT NOT NULL, actor TEXT NOT NULL, details TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hostel_stay_events_booking ON hostel_stay_events(booking_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hostel_stays_status ON hostel_stays(status,expected_arrival_on);
INSERT INTO hostel_stays (booking_id,expected_arrival_on,updated_at)
 SELECT b.id,COALESCE(p.starts_on,''),b.updated_at FROM hostel_bookings b
 LEFT JOIN hostel_periods p ON p.id=b.period_id WHERE b.status='PAID'
 ON CONFLICT(booking_id) DO NOTHING;
CREATE TRIGGER IF NOT EXISTS hostel_one_active_student_booking
 BEFORE INSERT ON hostel_bookings WHEN NEW.status='PENDING_PAYMENT'
 AND EXISTS (SELECT 1 FROM hostel_bookings b LEFT JOIN hostel_stays st ON st.booking_id=b.id
 WHERE lower(b.student_email)=lower(NEW.student_email) AND b.period_id=NEW.period_id
 AND b.status IN ('PENDING_PAYMENT','PAID','PAYMENT_REVIEW')
 AND COALESCE(st.status,'EXPECTED') NOT IN ('CHECKED_OUT','NO_SHOW','CANCELLED'))
 BEGIN SELECT RAISE(ABORT,'HOSTEL_ACTIVE_STUDENT_BOOKING'); END;
