import { runSchemaPass } from "@/lib/turso";

const STATEMENTS = [
  "CREATE TABLE IF NOT EXISTS hostel_stays (\n  booking_id TEXT PRIMARY KEY,\n  status TEXT NOT NULL DEFAULT 'EXPECTED' CHECK(status IN ('EXPECTED','CHECKED_IN','CHECKED_OUT','NO_SHOW','CANCELLED')),\n  expected_arrival_on TEXT NOT NULL DEFAULT '',\n  checked_in_at TEXT NOT NULL DEFAULT '',\n  checked_out_at TEXT NOT NULL DEFAULT '',\n  key_reference TEXT NOT NULL DEFAULT '',\n  updated_by TEXT NOT NULL DEFAULT '',\n  updated_at TEXT NOT NULL,\n  version INTEGER NOT NULL DEFAULT 0\n)",
  "CREATE TABLE IF NOT EXISTS hostel_stay_events (\n  id TEXT PRIMARY KEY, booking_id TEXT NOT NULL, landlord_id TEXT NOT NULL,\n  action TEXT NOT NULL, actor TEXT NOT NULL, details TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL\n)",
  "CREATE INDEX IF NOT EXISTS idx_hostel_stay_events_booking ON hostel_stay_events(booking_id,created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_hostel_stays_status ON hostel_stays(status,expected_arrival_on)",
  "INSERT INTO hostel_stays (booking_id,expected_arrival_on,updated_at)\n SELECT b.id,COALESCE(p.starts_on,''),b.updated_at FROM hostel_bookings b\n LEFT JOIN hostel_periods p ON p.id=b.period_id WHERE b.status='PAID'\n ON CONFLICT(booking_id) DO NOTHING",
  "CREATE TRIGGER IF NOT EXISTS hostel_one_active_student_booking\n BEFORE INSERT ON hostel_bookings WHEN NEW.status='PENDING_PAYMENT'\n AND EXISTS (SELECT 1 FROM hostel_bookings b LEFT JOIN hostel_stays st ON st.booking_id=b.id\n WHERE lower(b.student_email)=lower(NEW.student_email) AND b.period_id=NEW.period_id\n AND b.status IN ('PENDING_PAYMENT','PAID','PAYMENT_REVIEW')\n AND COALESCE(st.status,'EXPECTED') NOT IN ('CHECKED_OUT','NO_SHOW','CANCELLED'))\n BEGIN SELECT RAISE(ABORT,'HOSTEL_ACTIVE_STUDENT_BOOKING'); END;"
];

export function migrateHostelStays() {
  return runSchemaPass({ id: "hostel_stays", version: "030_hostel_stays", statements: STATEMENTS });
}
