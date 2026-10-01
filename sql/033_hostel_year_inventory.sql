-- 033_hostel_year_inventory.sql
-- Apply after the previous hostel migrations. Existing conflicting reservations must be resolved first.

CREATE TABLE IF NOT EXISTS hostel_bed_claims (
 booking_id TEXT PRIMARY KEY, space_id TEXT NOT NULL, period_id TEXT NOT NULL, student_email TEXT NOT NULL,
 UNIQUE(space_id,period_id));

CREATE UNIQUE INDEX IF NOT EXISTS idx_hostel_claim_student_year ON hostel_bed_claims(student_email,period_id) WHERE student_email<>'';

INSERT INTO hostel_bed_claims (booking_id,space_id,period_id,student_email)
 SELECT b.id,b.space_id,b.period_id,lower(b.student_email) FROM hostel_bookings b LEFT JOIN hostel_stays st ON st.booking_id=b.id
 WHERE b.status IN ('PENDING_PAYMENT','PAID','PAYMENT_REVIEW') AND COALESCE(st.status,'EXPECTED') IN ('EXPECTED','CHECKED_IN')
 AND NOT EXISTS (SELECT 1 FROM hostel_bed_claims c WHERE c.booking_id=b.id);

CREATE TRIGGER IF NOT EXISTS hostel_claim_insert AFTER INSERT ON hostel_bookings
 WHEN NEW.status IN ('PENDING_PAYMENT','PAID') BEGIN
 INSERT INTO hostel_bed_claims VALUES(NEW.id,NEW.space_id,NEW.period_id,lower(NEW.student_email)); END;

CREATE TRIGGER IF NOT EXISTS hostel_claim_move AFTER UPDATE OF space_id,period_id,status ON hostel_bookings
 WHEN NEW.status IN ('PENDING_PAYMENT','PAID') AND NOT EXISTS(SELECT 1 FROM hostel_stays WHERE booking_id=NEW.id AND status IN ('CHECKED_OUT','NO_SHOW','CANCELLED')) BEGIN
 DELETE FROM hostel_bed_claims WHERE booking_id=NEW.id;
 INSERT INTO hostel_bed_claims VALUES(NEW.id,NEW.space_id,NEW.period_id,lower(NEW.student_email)); END;

CREATE TRIGGER IF NOT EXISTS hostel_claim_release AFTER UPDATE OF status ON hostel_bookings
 WHEN NEW.status IN ('EXPIRED','CANCELLED','REFUNDED') BEGIN DELETE FROM hostel_bed_claims WHERE booking_id=NEW.id; END;

CREATE TRIGGER IF NOT EXISTS hostel_claim_depart AFTER UPDATE OF status ON hostel_stays
 WHEN NEW.status IN ('CHECKED_OUT','NO_SHOW','CANCELLED') BEGIN DELETE FROM hostel_bed_claims WHERE booking_id=NEW.booking_id; END;

CREATE TRIGGER IF NOT EXISTS hostel_claim_retire BEFORE UPDATE OF status ON hostel_spaces
 WHEN NEW.status='RETIRED' AND EXISTS(SELECT 1 FROM hostel_bed_claims WHERE space_id=NEW.id)
 BEGIN SELECT RAISE(ABORT,'HOSTEL_BED_HAS_YEAR_RESERVATION'); END;
