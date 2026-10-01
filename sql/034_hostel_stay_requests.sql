-- 034_hostel_stay_requests.sql
-- Apply after 033 and all previous hostel migrations.

CREATE TABLE IF NOT EXISTS hostel_stay_request_settings (
 property_id TEXT PRIMARY KEY,moves_enabled INTEGER NOT NULL DEFAULT 0,renewals_enabled INTEGER NOT NULL DEFAULT 0,
 period_id TEXT NOT NULL DEFAULT '',opens_on TEXT NOT NULL DEFAULT '',closes_on TEXT NOT NULL DEFAULT '',
 version INTEGER NOT NULL DEFAULT 1,updated_by TEXT NOT NULL,updated_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS hostel_stay_requests (
 id TEXT PRIMARY KEY,reference TEXT NOT NULL UNIQUE,booking_id TEXT NOT NULL,booking_reference TEXT NOT NULL,
 property_id TEXT NOT NULL,landlord_id TEXT NOT NULL,student_email TEXT NOT NULL,student_name TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('MOVE','RENEWAL')),status TEXT NOT NULL DEFAULT 'SUBMITTED'
 CHECK(status IN ('SUBMITTED','REVIEWING','OFFERED','ACCEPTED','PAYMENT_PENDING','PAYMENT_REVIEW','FULFILLED','DECLINED','CANCELLED','EXPIRED')),
 preference TEXT NOT NULL,requested_listing_id TEXT NOT NULL DEFAULT '',create_hash TEXT NOT NULL,
 offer_json TEXT NOT NULL DEFAULT '',expires_at TEXT NOT NULL DEFAULT '',version INTEGER NOT NULL DEFAULT 0,
 checkout_reference TEXT NOT NULL DEFAULT '',checkout_url TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);

CREATE UNIQUE INDEX IF NOT EXISTS idx_stay_request_open ON hostel_stay_requests(booking_id,kind)
 WHERE status IN ('SUBMITTED','REVIEWING','OFFERED','ACCEPTED','PAYMENT_PENDING');

CREATE INDEX IF NOT EXISTS idx_stay_request_expiry ON hostel_stay_requests(status,expires_at);

CREATE INDEX IF NOT EXISTS idx_stay_request_student ON hostel_stay_requests(student_email,created_at DESC);

CREATE INDEX IF NOT EXISTS idx_stay_request_host ON hostel_stay_requests(landlord_id,property_id,status,updated_at DESC);

CREATE TABLE IF NOT EXISTS hostel_stay_request_events (
 id TEXT PRIMARY KEY,request_id TEXT NOT NULL,mutation_id TEXT NOT NULL,payload_hash TEXT NOT NULL,version INTEGER NOT NULL,
 action TEXT NOT NULL,actor_name TEXT NOT NULL,actor_email TEXT NOT NULL,note TEXT NOT NULL,details TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,
 UNIQUE(request_id,mutation_id),UNIQUE(request_id,version));

CREATE TRIGGER IF NOT EXISTS hostel_request_payment AFTER UPDATE OF status ON hostel_bookings
 WHEN NEW.status IN ('PAID','PAYMENT_REVIEW','EXPIRED','CANCELLED') AND OLD.status<>NEW.status BEGIN
 UPDATE hostel_stay_requests SET status=CASE NEW.status WHEN 'PAID' THEN 'FULFILLED' WHEN 'PAYMENT_REVIEW' THEN 'PAYMENT_REVIEW' ELSE 'EXPIRED' END,
 version=version+1,updated_at=NEW.updated_at WHERE checkout_reference=NEW.reference AND status IN ('PAYMENT_PENDING','PAYMENT_REVIEW','EXPIRED');
 INSERT INTO hostel_stay_request_events(id,request_id,mutation_id,payload_hash,version,action,actor_name,actor_email,note,details,created_at)
 SELECT lower(hex(randomblob(16))),id,'payment-'||version,'',version,status,'Payment verification','system',
 'Checkout status updated by verified booking processing.',NEW.reference,NEW.updated_at FROM hostel_stay_requests
 WHERE checkout_reference=NEW.reference AND updated_at=NEW.updated_at
 ON CONFLICT(request_id,version) DO NOTHING; END;
