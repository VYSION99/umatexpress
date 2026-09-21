-- ============================================================================
-- UMaTeXPRESS — full consolidated migration
-- ============================================================================
-- One file for manual migrations, replacing sql/001 .. sql/013.
--
-- Safe to run on a fresh database and safe to run twice: every statement in
-- the active sections is CREATE ... IF NOT EXISTS, INSERT OR IGNORE, or an
-- UPDATE guarded by a value check.
--
-- On an EXISTING database this file will not add new columns to tables that
-- already exist (SQLite has no "ADD COLUMN IF NOT EXISTS"). The app self-heals
-- those columns at runtime, or you can run section 7 by hand.
--
-- Sections:
--   1. vacationRide
--   2. Admin
--   3. campusRide
--   4. Platform (payments, auth)
--   5. Indexes
--   6. Seed data
--   7. Data updates (idempotent)
--   8. Additive columns for pre-existing databases (commented)
--   9. Emergency: admin password recovery (commented)
--   10. Hostel Finder (phase 1 foundation)
-- ============================================================================


-- ============================================================================
-- 1. vacationRide
-- ============================================================================

CREATE TABLE IF NOT EXISTS scheduled_trips (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  route_from TEXT NOT NULL,
  route_to TEXT NOT NULL,
  travel_date TEXT NOT NULL DEFAULT '2026-09-05',
  departure_time TEXT NOT NULL,
  arrival_time TEXT NOT NULL,
  price INTEGER NOT NULL,
  capacity INTEGER NOT NULL,
  coach_type TEXT NOT NULL DEFAULT 'VIP Coach',
  tag TEXT NOT NULL DEFAULT '',
  amenities TEXT NOT NULL DEFAULT '["AC","Wi-Fi","USB power"]',
  notes TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  archived INTEGER NOT NULL DEFAULT 0,
  display_order INTEGER NOT NULL DEFAULT 0,
  organizer_id TEXT,
  review_status TEXT NOT NULL DEFAULT 'DRAFT',
  review_reason TEXT NOT NULL DEFAULT '',
  submitted_at TEXT,
  reviewed_at TEXT,
  reviewed_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT ''
);

-- Phase 2: organizer accounts and trip ownership. A trip with no organizer_id
-- is the platform's. `status` is the account gate; `kyc_status` is a separate,
-- later gate that only ever decides whether money may be paid out.
CREATE TABLE IF NOT EXISTS trip_organizers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  organization TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'PENDING',
  kyc_status TEXT NOT NULL DEFAULT 'PENDING',
  kyc_id_type TEXT NOT NULL DEFAULT '',
  kyc_id_number TEXT NOT NULL DEFAULT '',
  kyc_reason TEXT NOT NULL DEFAULT '',
  kyc_submitted_at TEXT,
  kyc_reviewed_at TEXT,
  payout_method TEXT NOT NULL DEFAULT '',
  payout_account_name TEXT NOT NULL DEFAULT '',
  payout_account_number TEXT NOT NULL DEFAULT '',
  payout_account_last4 TEXT NOT NULL DEFAULT '',
  payout_bank_code TEXT NOT NULL DEFAULT '',
  payout_bank_name TEXT NOT NULL DEFAULT '',
  payout_updated_at TEXT,
  paystack_recipient_code TEXT NOT NULL DEFAULT '',
  commission_bps INTEGER NOT NULL DEFAULT 300,
  review_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- The per-organizer trip notice. The platform-wide notice stays in
-- trip_settings and is the fallback for trips that have no organizer.
CREATE TABLE IF NOT EXISTS trip_notices (
  organizer_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL DEFAULT '',
  route TEXT NOT NULL DEFAULT '',
  fare TEXT NOT NULL DEFAULT '',
  night_bus TEXT NOT NULL DEFAULT '',
  day_buses TEXT NOT NULL DEFAULT '',
  drop_off_points TEXT NOT NULL DEFAULT '',
  amenities TEXT NOT NULL DEFAULT '',
  contacts TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  reference TEXT UNIQUE NOT NULL,
  passenger_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  seat INTEGER NOT NULL,
  trip_id TEXT NOT NULL,
  travel_date TEXT NOT NULL,
  amount INTEGER NOT NULL,
  payment_status TEXT NOT NULL DEFAULT 'PENDING',
  booking_status TEXT NOT NULL DEFAULT 'AWAITING_PAYMENT',
  hold_expires_at TEXT,
  confirmed_at TEXT,
  departure_time TEXT,
  organizer_id TEXT,
  commission_amount INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- Phase 4: one ledger row per confirmed booking. Amounts are pesewas and
-- append-only; a release or a reversal changes `status` and the timestamps,
-- never the money. The unique booking index is what makes accrual idempotent
-- when payment verification and the Paystack webhook both confirm one booking.
CREATE TABLE IF NOT EXISTS organizer_payouts (
  id TEXT PRIMARY KEY,
  organizer_id TEXT NOT NULL,
  booking_id TEXT NOT NULL,
  booking_reference TEXT NOT NULL DEFAULT '',
  trip_id TEXT NOT NULL DEFAULT '',
  gross_amount INTEGER NOT NULL DEFAULT 0,
  commission_amount INTEGER NOT NULL DEFAULT 0,
  net_amount INTEGER NOT NULL DEFAULT 0,
  commission_bps INTEGER NOT NULL DEFAULT 300,
  release_after TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACCRUED',
  batch_id TEXT NOT NULL DEFAULT '',
  transfer_reference TEXT NOT NULL DEFAULT '',
  payout_attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  released_at TEXT,
  transferred_at TEXT,
  reversed_at TEXT,
  reversed_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One payout attempt. `mode` says whether an administrator made the transfer
-- by hand and recorded the reference, or the Paystack Transfers API did it;
-- `status` says how that attempt ended. Entries carry the batch id only while
-- the money is in flight, so a failed batch leaves the rows owed.
CREATE TABLE IF NOT EXISTS organizer_payout_batches (
  id TEXT PRIMARY KEY,
  organizer_id TEXT NOT NULL,
  total_amount INTEGER NOT NULL DEFAULT 0,
  entry_count INTEGER NOT NULL DEFAULT 0,
  transfer_reference TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT 'MANUAL',
  status TEXT NOT NULL DEFAULT 'RECORDED',
  transfer_code TEXT NOT NULL DEFAULT '',
  recipient_code TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  initiated_at TEXT,
  settled_at TEXT,
  updated_at TEXT,
  created_at TEXT NOT NULL
);

-- What a passenger or an organizer said went wrong, and what the platform
-- decided. This records decisions; it does not move money, because a refund is
-- made where every other money movement is made. `raised_by` is an account
-- email for a student and an organizer id for an organizer; the ownership check
-- happens before the row is written, never after.
CREATE TABLE IF NOT EXISTS trip_disputes (
  id TEXT PRIMARY KEY,
  organizer_id TEXT NOT NULL DEFAULT '',
  trip_id TEXT NOT NULL DEFAULT '',
  booking_reference TEXT NOT NULL DEFAULT '',
  raised_by_role TEXT NOT NULL DEFAULT '',
  raised_by TEXT NOT NULL DEFAULT '',
  raised_by_contact TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'OTHER',
  subject TEXT NOT NULL DEFAULT '',
  details TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'OPEN',
  resolution TEXT NOT NULL DEFAULT '',
  resolution_note TEXT NOT NULL DEFAULT '',
  resolved_by TEXT NOT NULL DEFAULT '',
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS seat_holds (
  id TEXT PRIMARY KEY,
  booking_id TEXT UNIQUE NOT NULL,
  trip_id TEXT NOT NULL,
  travel_date TEXT NOT NULL,
  seat INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'HELD',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(trip_id, travel_date, seat)
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  reference_id TEXT UNIQUE NOT NULL,
  external_id TEXT NOT NULL,
  financial_transaction_id TEXT,
  payer_phone TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  failure_reason TEXT,
  access_token_hash TEXT,
  fare_amount INTEGER NOT NULL DEFAULT 0,
  fee_amount INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS trip_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  display_mode TEXT NOT NULL DEFAULT 'BOTH',
  morning_departure TEXT NOT NULL DEFAULT '06:30',
  morning_arrival TEXT NOT NULL DEFAULT '11:30',
  evening_departure TEXT NOT NULL DEFAULT '13:00',
  evening_arrival TEXT NOT NULL DEFAULT '18:00',
  flyer_promo TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);


-- ============================================================================
-- 2. Admin
-- ============================================================================

CREATE TABLE IF NOT EXISTS admin_credentials (
  email TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_iterations INTEGER NOT NULL,
  session_epoch INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id TEXT PRIMARY KEY,
  admin_email TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_reference TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);


-- ============================================================================
-- 3. campusRide
-- ============================================================================

CREATE TABLE IF NOT EXISTS campus_zones (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  landmark TEXT NOT NULL DEFAULT '',
  latitude REAL,
  longitude REAL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campus_route_corridors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  origin_zone_id TEXT NOT NULL,
  destination_zone_id TEXT NOT NULL,
  estimated_minutes INTEGER NOT NULL DEFAULT 10,
  active INTEGER NOT NULL DEFAULT 1,
  -- Optional surveyed corridor geometry: JSON array of [lng,lat] pairs. When
  -- NULL the map draws a generated arc between the two zones.
  path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campus_fares (
  id TEXT PRIMARY KEY,
  corridor_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'GHS',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campus_vehicles (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  plate_number TEXT NOT NULL DEFAULT '',
  vehicle_type TEXT NOT NULL DEFAULT 'Shuttle',
  capacity INTEGER NOT NULL DEFAULT 4,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campus_drivers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT UNIQUE,
  password_hash TEXT,
  password_salt TEXT,
  password_iterations INTEGER NOT NULL DEFAULT 100000,
  password_reset_required INTEGER NOT NULL DEFAULT 1,
  password_changed_at TEXT,
  token_version INTEGER NOT NULL DEFAULT 0,
  vehicle_id TEXT,
  current_zone_id TEXT,
  current_latitude REAL,
  current_longitude REAL,
  active INTEGER NOT NULL DEFAULT 1,
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campus_driver_sessions (
  id TEXT PRIMARY KEY,
  driver_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campus_rides (
  id TEXT PRIMARY KEY,
  driver_id TEXT,
  vehicle_id TEXT,
  corridor_id TEXT NOT NULL,
  current_zone_id TEXT,
  current_latitude REAL,
  current_longitude REAL,
  status TEXT NOT NULL DEFAULT 'OPEN',
  capacity INTEGER NOT NULL DEFAULT 4,
  available_slots INTEGER NOT NULL DEFAULT 4,
  accepting_queue INTEGER NOT NULL DEFAULT 1,
  next_queue_position INTEGER NOT NULL DEFAULT 1,
  started_at TEXT,
  ended_at TEXT,
  last_location_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campus_queue_entries (
  id TEXT PRIMARY KEY,
  reference TEXT UNIQUE NOT NULL,
  ride_id TEXT,
  corridor_id TEXT NOT NULL,
  passenger_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  pickup_zone_id TEXT NOT NULL,
  destination_zone_id TEXT NOT NULL,
  queue_position INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  payment_status TEXT NOT NULL DEFAULT 'WAITING_PAYMENT',
  queue_status TEXT NOT NULL DEFAULT 'WAITING_PAYMENT',
  ride_pin TEXT NOT NULL DEFAULT '',
  ticket_image_ready INTEGER NOT NULL DEFAULT 0,
  accepted_at TEXT,
  arrived_at TEXT,
  boarded_at TEXT,
  completed_at TEXT,
  cancelled_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campus_payments (
  id TEXT PRIMARY KEY,
  queue_entry_id TEXT NOT NULL,
  reference TEXT UNIQUE NOT NULL,
  provider TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'GHS',
  status TEXT NOT NULL DEFAULT 'PENDING',
  authorization_url TEXT,
  access_token_hash TEXT,
  fare_amount INTEGER NOT NULL DEFAULT 0,
  fee_amount INTEGER NOT NULL DEFAULT 0,
  paid_at TEXT,
  raw_response TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campus_ticket_events (
  id TEXT PRIMARY KEY,
  queue_entry_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campus_announcements (
  id TEXT PRIMARY KEY,
  audience TEXT NOT NULL DEFAULT 'ALL',
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campus_audit_logs (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_reference TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

-- The application records the schema version it has applied here, so a cold
-- Worker isolate can read one row and skip the whole idempotent schema pass.
-- This value must match CAMPUS_SCHEMA_VERSION in lib/campus-ride.ts. A mismatch
-- is harmless — the app replays the pass once and rewrites the row — but
-- keeping them equal preserves the single-subrequest cold start.
CREATE TABLE IF NOT EXISTS campus_schema_meta (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

INSERT OR REPLACE INTO campus_schema_meta (id, version, applied_at)
VALUES ('campusRide', '2026-09-18.1', datetime('now'));

-- The other schema passes the application keeps markers for. Each value must
-- match its constant in the source: TRIPS_SCHEMA_VERSION in
-- lib/dynamic-trips.ts, ORGANIZER_SCHEMA_VERSION in lib/organizers.ts and
-- PAYOUTS_SCHEMA_VERSION in lib/organizer-payouts.ts. A mismatch only costs a
-- replay of the pass, but keeping them equal preserves the one-subrequest
-- cold start.
INSERT OR REPLACE INTO campus_schema_meta (id, version, applied_at)
VALUES ('scheduledTrips', '2026-09-18.2', datetime('now'));

INSERT OR REPLACE INTO campus_schema_meta (id, version, applied_at)
VALUES ('tripOrganizers', '2026-09-18.3', datetime('now'));

-- The organizer payout ledger and its transfer attempts.
INSERT OR REPLACE INTO campus_schema_meta (id, version, applied_at)
VALUES ('organizerPayouts', '2026-09-18.2', datetime('now'));

-- Disputes. Must match DISPUTES_SCHEMA_VERSION in lib/disputes.ts.
INSERT OR REPLACE INTO campus_schema_meta (id, version, applied_at)
VALUES ('tripDisputes', '2026-09-18.1', datetime('now'));

-- Existing trips predate review and belong to the platform, so they are already
-- live. Anything created afterwards starts as DRAFT and must be reviewed.
UPDATE scheduled_trips SET review_status = 'APPROVED'
WHERE organizer_id IS NULL AND review_status = 'DRAFT';


-- ============================================================================
-- 4. Platform (payments, auth)
-- ============================================================================

-- One row per provider webhook delivery; the webhook ignores replays.
CREATE TABLE IF NOT EXISTS payment_events (
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  reference TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (provider, event_id)
);

-- Durable fixed-window rate limit counters, shared across Worker isolates.
CREATE TABLE IF NOT EXISTS rate_limit_windows (
  scope TEXT NOT NULL,
  subject TEXT NOT NULL,
  window_key TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, subject, window_key)
);

-- One account per UMaT student, shared by campusRide and vacationRide. Only
-- @st.umat.edu.gh addresses may be stored. Passwords are PBKDF2-SHA256 hashes;
-- token_version is bumped on a password change to retire older sessions.
-- email_verified stays 0: no email provider is configured, so the address is
-- checked against the university domain but not yet proved by delivery.
CREATE TABLE IF NOT EXISTS student_accounts (
  id                  TEXT PRIMARY KEY,
  email               TEXT NOT NULL UNIQUE,
  name                TEXT NOT NULL DEFAULT '',
  phone               TEXT NOT NULL DEFAULT '',
  password_hash       TEXT NOT NULL,
  password_salt       TEXT NOT NULL,
  password_iterations INTEGER NOT NULL,
  token_version       INTEGER NOT NULL DEFAULT 0,
  email_verified      INTEGER NOT NULL DEFAULT 0,
  active              INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  last_login_at       TEXT
);

-- One identity for every console service: admin, moderator, organizer and
-- driver. The role decides what the account may do, and the role is always
-- read from the signed session, never from a request body or query string.
-- A NULL password_hash means the account is bridged to a legacy credential
-- store (admin_credentials or campus_drivers): the console adopts an identity
-- that already exists and only owns the password once one is set here.
-- status: PENDING (waiting for approval) | ACTIVE | SUSPENDED
CREATE TABLE IF NOT EXISTS console_accounts (
  id                  TEXT PRIMARY KEY,
  email               TEXT NOT NULL UNIQUE,
  name                TEXT NOT NULL,
  phone               TEXT NOT NULL DEFAULT '',
  password_hash       TEXT,
  password_salt       TEXT,
  password_iterations INTEGER,
  role                TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'PENDING',
  profile_id          TEXT NOT NULL DEFAULT '',
  token_version       INTEGER NOT NULL DEFAULT 0,
  last_login_at       TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

-- Failed-attempt counters for login and PIN lockouts.
CREATE TABLE IF NOT EXISTS auth_failures (
  scope TEXT NOT NULL,
  subject TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, subject)
);

-- Per-day operational counters (queues, payments, webhook replays).
CREATE TABLE IF NOT EXISTS metrics_counters (
  name TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (name, day)
);

-- Passenger notifications awaiting delivery. One row per (reference, template),
-- so repeating a driver action cannot message the rider twice.
CREATE TABLE IF NOT EXISTS notification_outbox (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  recipient TEXT NOT NULL,
  template TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL,
  reference TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  available_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  read_at TEXT
);


-- ============================================================================
-- 5. Indexes
-- ============================================================================

-- Platform accounts
CREATE INDEX IF NOT EXISTS idx_student_accounts_active ON student_accounts(active, created_at);

-- Console identity
CREATE INDEX IF NOT EXISTS idx_console_accounts_role_status ON console_accounts(role, status);
CREATE INDEX IF NOT EXISTS idx_console_accounts_profile ON console_accounts(role, profile_id);

-- vacationRide
CREATE INDEX IF NOT EXISTS idx_payments_status_created ON payments(status, created_at);
CREATE INDEX IF NOT EXISTS idx_bookings_status_created ON bookings(booking_status, created_at);

-- Admin
CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_target ON admin_audit_logs(target_type, target_reference);
CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_created_at ON admin_audit_logs(created_at);

-- campusRide rides
CREATE INDEX IF NOT EXISTS idx_campus_rides_status ON campus_rides(status);
CREATE INDEX IF NOT EXISTS idx_campus_rides_driver ON campus_rides(driver_id);
CREATE INDEX IF NOT EXISTS idx_campus_rides_current_zone ON campus_rides(current_zone_id);
CREATE INDEX IF NOT EXISTS idx_campus_rides_corridor_status ON campus_rides(corridor_id, status);

-- campusRide queue
CREATE INDEX IF NOT EXISTS idx_campus_queue_ride_status ON campus_queue_entries(ride_id, queue_status);
CREATE INDEX IF NOT EXISTS idx_campus_queue_reference ON campus_queue_entries(reference);
CREATE INDEX IF NOT EXISTS idx_campus_queue_phone ON campus_queue_entries(phone);
CREATE INDEX IF NOT EXISTS idx_campus_queue_status_created ON campus_queue_entries(queue_status, created_at);
CREATE INDEX IF NOT EXISTS idx_campus_queue_expiry ON campus_queue_entries(queue_status, expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_campus_queue_active_position
ON campus_queue_entries(ride_id, queue_position)
WHERE queue_status IN ('PAID_WAITING','ACCEPTED_BY_DRIVER','DRIVER_ARRIVED','BOARDED');

-- campusRide payments
CREATE INDEX IF NOT EXISTS idx_campus_payments_reference ON campus_payments(reference);
CREATE INDEX IF NOT EXISTS idx_campus_payments_queue ON campus_payments(queue_entry_id);
CREATE INDEX IF NOT EXISTS idx_campus_payments_status_created ON campus_payments(status, created_at);

-- campusRide drivers
CREATE INDEX IF NOT EXISTS idx_campus_drivers_active_zone ON campus_drivers(active, current_zone_id);
CREATE INDEX IF NOT EXISTS idx_campus_drivers_last_seen ON campus_drivers(last_seen_at);
CREATE INDEX IF NOT EXISTS idx_campus_drivers_password_reset ON campus_drivers(password_reset_required, active);
CREATE UNIQUE INDEX IF NOT EXISTS idx_campus_drivers_phone ON campus_drivers(phone) WHERE phone <> '';

-- campusRide audit
CREATE INDEX IF NOT EXISTS idx_campus_audit_target ON campus_audit_logs(target_type, target_reference);

-- Organizer ownership
CREATE INDEX IF NOT EXISTS idx_scheduled_trips_organizer ON scheduled_trips(organizer_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_trips_review ON scheduled_trips(review_status, active, archived);
CREATE INDEX IF NOT EXISTS idx_trip_organizers_status ON trip_organizers(status);
CREATE INDEX IF NOT EXISTS idx_trip_organizers_kyc ON trip_organizers(kyc_status, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_trip_organizers_phone ON trip_organizers(phone) WHERE phone <> '';

-- Organizer payouts: idempotent accrual, per-organizer reads and due entries.
CREATE UNIQUE INDEX IF NOT EXISTS idx_organizer_payouts_booking ON organizer_payouts(booking_id);
CREATE INDEX IF NOT EXISTS idx_organizer_payouts_organizer ON organizer_payouts(organizer_id, status);
CREATE INDEX IF NOT EXISTS idx_organizer_payouts_due ON organizer_payouts(status, release_after);
CREATE INDEX IF NOT EXISTS idx_organizer_payout_batches ON organizer_payout_batches(organizer_id, created_at);
CREATE INDEX IF NOT EXISTS idx_organizer_payout_batches_status ON organizer_payout_batches(status, created_at);
CREATE INDEX IF NOT EXISTS idx_organizer_payouts_batch ON organizer_payouts(batch_id);
CREATE INDEX IF NOT EXISTS idx_trip_disputes_status ON trip_disputes(status, created_at);
CREATE INDEX IF NOT EXISTS idx_trip_disputes_organizer ON trip_disputes(organizer_id, created_at);
CREATE INDEX IF NOT EXISTS idx_trip_disputes_reference ON trip_disputes(booking_reference);

-- Platform
CREATE INDEX IF NOT EXISTS idx_payment_events_reference ON payment_events(provider, reference);
CREATE INDEX IF NOT EXISTS idx_auth_failures_locked ON auth_failures(scope, locked_until);
CREATE INDEX IF NOT EXISTS idx_rate_limit_expiry ON rate_limit_windows(expires_at);
CREATE INDEX IF NOT EXISTS idx_metrics_counters_day ON metrics_counters(day);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_dedupe ON notification_outbox(reference, template);
CREATE INDEX IF NOT EXISTS idx_notification_due ON notification_outbox(status, available_at);
-- The in-app notification feed reads one student's messages, newest first.
CREATE INDEX IF NOT EXISTS idx_notification_recipient ON notification_outbox(recipient, created_at);


-- ============================================================================
-- 6. Seed data
-- ============================================================================

INSERT OR IGNORE INTO trip_settings
  (id, display_mode, morning_departure, morning_arrival, evening_departure, evening_arrival, updated_at)
VALUES
  (1, 'BOTH', '06:30', '11:30', '13:00', '18:00', datetime('now'));


-- ============================================================================
-- 7. Data updates (idempotent)
-- ============================================================================

-- Backfill provider fee split for rows created before fare_amount existed.
UPDATE payments SET fare_amount = amount WHERE fare_amount = 0;
UPDATE campus_payments SET fare_amount = amount WHERE fare_amount = 0;

-- vacationRide fare correction: GHS 190 -> GHS 180.
UPDATE scheduled_trips
SET price = 180, updated_at = datetime('now')
WHERE price = 190;

UPDATE trip_settings
SET flyer_promo = replace(flyer_promo, 'GHS 190', 'GHS 180'), updated_at = datetime('now')
WHERE flyer_promo LIKE '%GHS 190%';


-- ============================================================================
-- 8. Additive columns for pre-existing databases (OPTIONAL)
-- ============================================================================
-- Only needed if your tables already existed before this consolidation and the
-- app has not yet self-healed them. Run ONLY the lines whose column is missing
-- (check with: PRAGMA table_info(<table>);). Running a line twice errors.
--
-- ALTER TABLE payments                 ADD COLUMN fare_amount INTEGER NOT NULL DEFAULT 0;
-- ALTER TABLE payments                 ADD COLUMN fee_amount INTEGER NOT NULL DEFAULT 0;
-- ALTER TABLE payments                 ADD COLUMN access_token_hash TEXT;
-- ALTER TABLE scheduled_trips          ADD COLUMN travel_date TEXT NOT NULL DEFAULT '2026-09-05';
-- ALTER TABLE scheduled_trips          ADD COLUMN tag TEXT NOT NULL DEFAULT '';
-- ALTER TABLE scheduled_trips          ADD COLUMN amenities TEXT NOT NULL DEFAULT '["AC","Wi-Fi","USB power"]';
-- ALTER TABLE scheduled_trips          ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
-- ALTER TABLE scheduled_trips          ADD COLUMN display_order INTEGER NOT NULL DEFAULT 0;
-- ALTER TABLE scheduled_trips          ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
-- ALTER TABLE scheduled_trips          ADD COLUMN organizer_id TEXT;
-- ALTER TABLE scheduled_trips          ADD COLUMN review_status TEXT NOT NULL DEFAULT 'DRAFT';
-- ALTER TABLE scheduled_trips          ADD COLUMN review_reason TEXT NOT NULL DEFAULT '';
-- ALTER TABLE scheduled_trips          ADD COLUMN submitted_at TEXT;
-- ALTER TABLE scheduled_trips          ADD COLUMN reviewed_at TEXT;
-- ALTER TABLE scheduled_trips          ADD COLUMN reviewed_by TEXT;
-- ALTER TABLE trip_organizers          ADD COLUMN review_reason TEXT NOT NULL DEFAULT '';
-- ALTER TABLE trip_organizers          ADD COLUMN kyc_id_type TEXT NOT NULL DEFAULT '';
-- ALTER TABLE trip_organizers          ADD COLUMN kyc_id_number TEXT NOT NULL DEFAULT '';
-- ALTER TABLE trip_organizers          ADD COLUMN kyc_reason TEXT NOT NULL DEFAULT '';
-- ALTER TABLE trip_organizers          ADD COLUMN kyc_submitted_at TEXT;
-- ALTER TABLE trip_organizers          ADD COLUMN kyc_reviewed_at TEXT;
-- ALTER TABLE trip_organizers          ADD COLUMN payout_account_last4 TEXT NOT NULL DEFAULT '';
-- ALTER TABLE trip_organizers          ADD COLUMN payout_updated_at TEXT;
-- ALTER TABLE trip_organizers          ADD COLUMN payout_bank_code TEXT NOT NULL DEFAULT '';
-- ALTER TABLE trip_organizers          ADD COLUMN payout_bank_name TEXT NOT NULL DEFAULT '';
-- ALTER TABLE organizer_payouts        ADD COLUMN payout_attempts INTEGER NOT NULL DEFAULT 0;
-- ALTER TABLE organizer_payouts        ADD COLUMN last_error TEXT NOT NULL DEFAULT '';
-- ALTER TABLE organizer_payout_batches ADD COLUMN mode TEXT NOT NULL DEFAULT 'MANUAL';
-- ALTER TABLE organizer_payout_batches ADD COLUMN status TEXT NOT NULL DEFAULT 'RECORDED';
-- ALTER TABLE organizer_payout_batches ADD COLUMN transfer_code TEXT NOT NULL DEFAULT '';
-- ALTER TABLE organizer_payout_batches ADD COLUMN recipient_code TEXT NOT NULL DEFAULT '';
-- ALTER TABLE organizer_payout_batches ADD COLUMN reason TEXT NOT NULL DEFAULT '';
-- ALTER TABLE organizer_payout_batches ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
-- ALTER TABLE organizer_payout_batches ADD COLUMN initiated_at TEXT;
-- ALTER TABLE organizer_payout_batches ADD COLUMN settled_at TEXT;
-- ALTER TABLE organizer_payout_batches ADD COLUMN updated_at TEXT;
-- ALTER TABLE bookings                 ADD COLUMN booking_status TEXT NOT NULL DEFAULT 'AWAITING_PAYMENT';
-- ALTER TABLE bookings                 ADD COLUMN hold_expires_at TEXT;
-- ALTER TABLE bookings                 ADD COLUMN confirmed_at TEXT;
-- ALTER TABLE bookings                 ADD COLUMN departure_time TEXT;
-- ALTER TABLE bookings                 ADD COLUMN organizer_id TEXT;
-- ALTER TABLE bookings                 ADD COLUMN commission_amount INTEGER NOT NULL DEFAULT 0;
-- ALTER TABLE admin_credentials        ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0;
-- ALTER TABLE campus_drivers           ADD COLUMN password_reset_required INTEGER NOT NULL DEFAULT 1;
-- ALTER TABLE campus_drivers           ADD COLUMN password_changed_at TEXT;
-- ALTER TABLE campus_drivers           ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;
-- ALTER TABLE student_accounts         ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;
-- ALTER TABLE student_accounts         ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;
-- ALTER TABLE student_accounts         ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
-- ALTER TABLE campus_queue_entries     ADD COLUMN ride_pin TEXT NOT NULL DEFAULT '';
-- ALTER TABLE campus_queue_entries     ADD COLUMN accepted_at TEXT;
-- ALTER TABLE campus_queue_entries     ADD COLUMN arrived_at TEXT;
-- ALTER TABLE campus_queue_entries     ADD COLUMN boarded_at TEXT;
-- ALTER TABLE campus_queue_entries     ADD COLUMN completed_at TEXT;
-- ALTER TABLE campus_queue_entries     ADD COLUMN cancelled_at TEXT;
-- ALTER TABLE campus_queue_entries     ADD COLUMN expires_at TEXT;
-- ALTER TABLE campus_rides             ADD COLUMN next_queue_position INTEGER NOT NULL DEFAULT 1;
-- ALTER TABLE campus_payments          ADD COLUMN fare_amount INTEGER NOT NULL DEFAULT 0;
-- ALTER TABLE campus_payments          ADD COLUMN fee_amount INTEGER NOT NULL DEFAULT 0;
-- ALTER TABLE notification_outbox      ADD COLUMN subject TEXT NOT NULL DEFAULT '';
-- ALTER TABLE notification_outbox      ADD COLUMN read_at TEXT;
-- ALTER TABLE campus_route_corridors   ADD COLUMN path TEXT;
--
-- After adding campus_rides.next_queue_position for the first time, run this
-- ONCE so new joins cannot reuse an existing position. Do not run it again:
--
-- UPDATE campus_rides
-- SET next_queue_position = COALESCE(
--   (SELECT MAX(queue_position) + 1 FROM campus_queue_entries q WHERE q.ride_id = campus_rides.id), 1);

-- Legacy scratch tables left behind by the historical sql/001 table rebuild.
-- They were never renamed into place and no application code reads them.
-- Confirm the canonical rows exist, then drop them:
--
-- DROP TABLE IF EXISTS bookings_new;
-- DROP TABLE IF EXISTS seat_holds_new;


-- ============================================================================
-- 9. Emergency: admin password recovery (OPTIONAL)
-- ============================================================================
-- Removes the stored hash for one admin so the app falls back to the bootstrap
-- ADMIN_PASSWORD secret on next login. The admin must then change it again.
--
-- DELETE FROM admin_credentials WHERE email = 'admin@example.com';

-- ============================================================================
-- 10. Hostel Finder (phase 1 foundation)
-- ============================================================================
-- Same statements as sql/014_hostel_foundation.sql, repeated here so the one
-- manual migration file stays complete. No money tables yet: bookings,
-- payments and payouts arrive with phases 2 and 3.

-- Phase 1 of the Hostel Finder: landlords, their buildings, rooms and beds,
-- the academic periods the platform sells against, the listing that offers one
-- bed for one period, and the photos a listing needs before it can be approved.
--
-- No money yet: bookings, payments, payouts and messages arrive with phase 2/3.
--
-- Safe to run on a fresh database and safe to run twice. The same statements
-- live in 000_umatexpress_full_migration.sql (section 10); the app also applies
-- them at runtime through ensureHostelTables(), so a deployment works before
-- the manual migration is run.
-- ============================================================================

CREATE TABLE IF NOT EXISTS hostel_landlords (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  organization TEXT NOT NULL DEFAULT '',
  -- Business gate, separate from the console account gate in console_accounts.
  status TEXT NOT NULL DEFAULT 'ACTIVE',              -- ACTIVE | SUSPENDED
  kyc_status TEXT NOT NULL DEFAULT 'PENDING',         -- PENDING | VERIFIED | REJECTED
  review_reason TEXT NOT NULL DEFAULT '',
  -- Landlord-side commission (3%), stored per booking when money arrives.
  commission_bps INTEGER NOT NULL DEFAULT 300,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_hostel_landlords_phone ON hostel_landlords(phone) WHERE phone <> '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_hostel_landlords_email ON hostel_landlords(email) WHERE email <> '';
CREATE INDEX IF NOT EXISTS idx_hostel_landlords_status ON hostel_landlords(status, kyc_status);

CREATE TABLE IF NOT EXISTS hostel_properties (
  id TEXT PRIMARY KEY,
  landlord_id TEXT NOT NULL,
  name TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  latitude REAL,
  longitude REAL,
  campus_distance_m INTEGER,
  -- Landlord toggle: when on, each room's utilities_fee becomes a fee line.
  utilities_enabled INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'DRAFT',               -- DRAFT | PENDING_REVIEW | APPROVED | SUSPENDED
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hostel_properties_landlord ON hostel_properties(landlord_id, status);
CREATE INDEX IF NOT EXISTS idx_hostel_properties_status ON hostel_properties(status);

CREATE TABLE IF NOT EXISTS hostel_rooms (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL,
  label TEXT NOT NULL,                                -- "Room 3"
  capacity INTEGER NOT NULL CHECK (capacity BETWEEN 1 AND 6),
  utilities_fee INTEGER NOT NULL DEFAULT 0,           -- pesewas, per bed
  amenities TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ACTIVE',              -- ACTIVE | RETIRED
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hostel_rooms_property ON hostel_rooms(property_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hostel_rooms_property_label ON hostel_rooms(property_id, label) WHERE status = 'ACTIVE';

CREATE TABLE IF NOT EXISTS hostel_spaces (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',                     -- "Bed A"
  -- The physical bed survives every academic year. Per-period availability is
  -- a listing, never a status here.
  status TEXT NOT NULL DEFAULT 'AVAILABLE',           -- AVAILABLE | RETIRED
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hostel_spaces_room_status ON hostel_spaces(room_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hostel_spaces_room_label ON hostel_spaces(room_id, label) WHERE status <> 'RETIRED';

CREATE TABLE IF NOT EXISTS hostel_periods (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,                                 -- "2026/27 Academic Year"
  starts_on TEXT NOT NULL,                            -- school reopening date
  ends_on TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hostel_periods_active ON hostel_periods(active, starts_on);

CREATE TABLE IF NOT EXISTS hostel_listings (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  period_id TEXT NOT NULL,
  price INTEGER NOT NULL,                             -- rent per bed, in pesewas
  status TEXT NOT NULL DEFAULT 'DRAFT',               -- DRAFT | PENDING_REVIEW | APPROVED | SUSPENDED
  review_reason TEXT NOT NULL DEFAULT '',
  submitted_at TEXT NOT NULL DEFAULT '',               -- when the landlord last sent it for review
  reviewed_at TEXT NOT NULL DEFAULT '',
  reviewed_by TEXT NOT NULL DEFAULT '',                -- the console account that decided
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One offer per bed per period. A space is re-listed next year, never twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_hostel_listings_space_period ON hostel_listings(space_id, period_id);
CREATE INDEX IF NOT EXISTS idx_hostel_listings_period_status ON hostel_listings(period_id, status);
CREATE INDEX IF NOT EXISTS idx_hostel_listings_status_submitted ON hostel_listings(status, submitted_at);

CREATE TABLE IF NOT EXISTS hostel_property_photos (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL,
  r2_key TEXT NOT NULL DEFAULT '',
  caption TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'PENDING',             -- PENDING | APPROVED | REJECTED
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hostel_photos_property ON hostel_property_photos(property_id, sort_order);


-- ============================================================================
-- 11. Hostel Finder (phase 2/3/4 — residency, plugins, communication)
-- ============================================================================
-- Same statements as sql/015_hostel_residency.sql, repeated here so the one
-- manual migration file stays complete.

CREATE TABLE IF NOT EXISTS hostel_bookings (
  id TEXT PRIMARY KEY,
  reference TEXT NOT NULL,                            -- HF-XXXXXXXX, the Paystack reference
  listing_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  room_id TEXT NOT NULL DEFAULT '',
  property_id TEXT NOT NULL,
  landlord_id TEXT NOT NULL,
  period_id TEXT NOT NULL,
  student_email TEXT NOT NULL DEFAULT '',
  student_name TEXT NOT NULL DEFAULT '',
  student_phone TEXT NOT NULL DEFAULT '',
  price INTEGER NOT NULL,                             -- bed rent, pesewas
  utilities_fee INTEGER NOT NULL DEFAULT 0,           -- pesewas, only when the property charges one
  total_amount INTEGER NOT NULL,                      -- price + utilities, what the student pays
  commission_bps INTEGER NOT NULL DEFAULT 300,
  commission_amount INTEGER NOT NULL DEFAULT 0,
  net_amount INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'PENDING_PAYMENT',     -- PENDING_PAYMENT | PAID | PAYMENT_REVIEW | EXPIRED | CANCELLED | REFUNDED
  hold_expires_at TEXT NOT NULL DEFAULT '',
  paid_at TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '',
  provider_reference TEXT NOT NULL DEFAULT '',
  access_token_hash TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_hostel_bookings_reference ON hostel_bookings(reference);
CREATE INDEX IF NOT EXISTS idx_hostel_bookings_student ON hostel_bookings(student_email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hostel_bookings_landlord ON hostel_bookings(landlord_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hostel_bookings_space ON hostel_bookings(space_id, status);
CREATE INDEX IF NOT EXISTS idx_hostel_bookings_hold ON hostel_bookings(status, hold_expires_at);

CREATE TABLE IF NOT EXISTS hostel_payouts (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL,
  landlord_id TEXT NOT NULL,
  gross_amount INTEGER NOT NULL,
  commission_bps INTEGER NOT NULL,
  commission_amount INTEGER NOT NULL,
  net_amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACCRUED',             -- ACCRUED | RELEASED | REVERSED
  release_after TEXT NOT NULL,                        -- period start minus three days
  released_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_hostel_payouts_booking ON hostel_payouts(booking_id);
CREATE INDEX IF NOT EXISTS idx_hostel_payouts_landlord ON hostel_payouts(landlord_id, status, release_after);

CREATE TABLE IF NOT EXISTS hostel_plugins (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'SERVICE',
  price INTEGER NOT NULL,                             -- platform fee per academic year, pesewas
  suggested_resident_price INTEGER NOT NULL DEFAULT 0,
  billing_period TEXT NOT NULL DEFAULT 'ACADEMIC_YEAR',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_hostel_plugins_code ON hostel_plugins(code);

CREATE TABLE IF NOT EXISTS hostel_plugin_subscriptions (
  id TEXT PRIMARY KEY,
  landlord_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  period_id TEXT NOT NULL,
  property_id TEXT NOT NULL DEFAULT '',               -- empty means every property the landlord has
  platform_price INTEGER NOT NULL,
  resident_price INTEGER NOT NULL DEFAULT 0,          -- 0 means the service is included in the rent
  status TEXT NOT NULL DEFAULT 'PENDING_PAYMENT',     -- PENDING_PAYMENT | ACTIVE | EXPIRED | CANCELLED
  reference TEXT NOT NULL,                            -- HP-XXXXXXXX
  access_token_hash TEXT NOT NULL DEFAULT '',
  hold_expires_at TEXT NOT NULL DEFAULT '',
  activated_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_hostel_subscriptions_reference ON hostel_plugin_subscriptions(reference);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hostel_subscriptions_scope ON hostel_plugin_subscriptions(landlord_id, plugin_id, period_id, property_id);
CREATE INDEX IF NOT EXISTS idx_hostel_subscriptions_status ON hostel_plugin_subscriptions(status, hold_expires_at);

CREATE TABLE IF NOT EXISTS hostel_service_requests (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  landlord_id TEXT NOT NULL,
  student_email TEXT NOT NULL DEFAULT '',
  price INTEGER NOT NULL DEFAULT 0,                   -- the resident price at the moment of asking
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'REQUESTED',           -- REQUESTED | APPROVED | DECLINED | ACTIVE | COMPLETED | CANCELLED
  decided_by TEXT NOT NULL DEFAULT '',
  decided_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hostel_service_booking ON hostel_service_requests(booking_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hostel_service_landlord ON hostel_service_requests(landlord_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS hostel_messages (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL,
  sender_type TEXT NOT NULL,                          -- STUDENT | HOST | ADMIN | SYSTEM
  sender_id TEXT NOT NULL DEFAULT '',
  sender_name TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '',
  read_by TEXT NOT NULL DEFAULT '',                   -- who read it: STUDENT | HOST
  read_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hostel_messages_booking ON hostel_messages(booking_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hostel_messages_unread ON hostel_messages(booking_id, read_by, created_at);

CREATE TABLE IF NOT EXISTS hostel_announcements (
  id TEXT PRIMARY KEY,
  landlord_id TEXT NOT NULL,
  property_id TEXT NOT NULL DEFAULT '',
  author_email TEXT NOT NULL DEFAULT '',
  author_name TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PUBLISHED',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hostel_announcements_landlord ON hostel_announcements(landlord_id, property_id, created_at DESC);

CREATE TABLE IF NOT EXISTS hostel_managers (
  id TEXT PRIMARY KEY,
  landlord_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ACTIVE',              -- ACTIVE | REVOKED
  invited_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_hostel_managers_email ON hostel_managers(landlord_id, email);
CREATE INDEX IF NOT EXISTS idx_hostel_managers_landlord ON hostel_managers(landlord_id, status);

-- The agreed hostel rate is 3%. Rows still on the placeholder 5% default move
-- with it; a rate anybody negotiated on purpose was never stored as 500.
UPDATE hostel_landlords SET commission_bps = 300, updated_at = updated_at WHERE commission_bps = 500;

-- ============================================================================
-- 016_hostel_payouts — the money-out half of a paid hostel booking
-- ============================================================================

CREATE TABLE IF NOT EXISTS hostel_payout_batches (
  id TEXT PRIMARY KEY,
  landlord_id TEXT NOT NULL,
  total_amount INTEGER NOT NULL DEFAULT 0,
  entry_count INTEGER NOT NULL DEFAULT 0,
  transfer_reference TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hostel_payout_batches_landlord ON hostel_payout_batches(landlord_id, created_at DESC);

ALTER TABLE hostel_payouts ADD COLUMN batch_id TEXT NOT NULL DEFAULT '';
ALTER TABLE hostel_payouts ADD COLUMN transfer_reference TEXT NOT NULL DEFAULT '';
ALTER TABLE hostel_payouts ADD COLUMN released_by TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_hostel_payouts_batch ON hostel_payouts(batch_id);

ALTER TABLE hostel_landlords ADD COLUMN payout_method TEXT NOT NULL DEFAULT '';
ALTER TABLE hostel_landlords ADD COLUMN payout_account_name TEXT NOT NULL DEFAULT '';
ALTER TABLE hostel_landlords ADD COLUMN payout_account_number TEXT NOT NULL DEFAULT '';
ALTER TABLE hostel_landlords ADD COLUMN payout_account_last4 TEXT NOT NULL DEFAULT '';
ALTER TABLE hostel_landlords ADD COLUMN payout_bank_code TEXT NOT NULL DEFAULT '';
ALTER TABLE hostel_landlords ADD COLUMN payout_bank_name TEXT NOT NULL DEFAULT '';
ALTER TABLE hostel_landlords ADD COLUMN payout_updated_at TEXT NOT NULL DEFAULT '';

-- ============================================================================
-- 017_hostel_commission_3pct — the hostel platform rate moves from 9% to 3%
-- ============================================================================
-- Bookings keep the rate they were charged; only landlord rows still on the old
-- platform default move.

UPDATE hostel_landlords SET commission_bps = 300, updated_at = updated_at WHERE commission_bps = 900;

-- ============================================================================
-- 018_hostel_photos — property photos become usable
-- ============================================================================

ALTER TABLE hostel_property_photos ADD COLUMN landlord_id TEXT NOT NULL DEFAULT '';
ALTER TABLE hostel_property_photos ADD COLUMN room_id TEXT NOT NULL DEFAULT '';
ALTER TABLE hostel_property_photos ADD COLUMN content_type TEXT NOT NULL DEFAULT '';
ALTER TABLE hostel_property_photos ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hostel_property_photos ADD COLUMN review_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE hostel_property_photos ADD COLUMN reviewed_by TEXT NOT NULL DEFAULT '';
ALTER TABLE hostel_property_photos ADD COLUMN reviewed_at TEXT NOT NULL DEFAULT '';
ALTER TABLE hostel_property_photos ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_hostel_photos_landlord ON hostel_property_photos(landlord_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hostel_photos_status ON hostel_property_photos(status, created_at DESC);

UPDATE hostel_property_photos SET landlord_id = COALESCE((SELECT p.landlord_id FROM hostel_properties p WHERE p.id = hostel_property_photos.property_id), '')
  WHERE landlord_id = '';

-- ============================================================================
-- 019_hostel_payout_transfers — hostel payouts leave through Paystack
-- ============================================================================

ALTER TABLE hostel_payout_batches ADD COLUMN mode TEXT NOT NULL DEFAULT 'MANUAL';
ALTER TABLE hostel_payout_batches ADD COLUMN status TEXT NOT NULL DEFAULT 'RECORDED';
ALTER TABLE hostel_payout_batches ADD COLUMN transfer_code TEXT NOT NULL DEFAULT '';
ALTER TABLE hostel_payout_batches ADD COLUMN recipient_code TEXT NOT NULL DEFAULT '';
ALTER TABLE hostel_payout_batches ADD COLUMN reason TEXT NOT NULL DEFAULT '';
ALTER TABLE hostel_payout_batches ADD COLUMN initiated_at TEXT NOT NULL DEFAULT '';
ALTER TABLE hostel_payout_batches ADD COLUMN settled_at TEXT NOT NULL DEFAULT '';

ALTER TABLE hostel_payouts ADD COLUMN payout_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hostel_payouts ADD COLUMN last_error TEXT NOT NULL DEFAULT '';

ALTER TABLE hostel_landlords ADD COLUMN paystack_recipient_code TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_hostel_payout_batches_inflight ON hostel_payout_batches(status, mode, initiated_at);

-- ============================================================================
-- 020_auth_recovery — password resets and one-time sign-in codes
-- ============================================================================

CREATE TABLE IF NOT EXISTS auth_recovery_requests (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  account_id TEXT NOT NULL,
  email TEXT NOT NULL,
  purpose TEXT NOT NULL,
  token_hash TEXT NOT NULL DEFAULT '',
  code_hash TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  used_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_recovery_lookup ON auth_recovery_requests(scope, email, purpose, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_recovery_token ON auth_recovery_requests(token_hash);

-- ============================================================================
-- 021_platform_settings — the deployment switches an administrator owns
-- ============================================================================

CREATE TABLE IF NOT EXISTS platform_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_by TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

-- ============================================================================
-- 022_hostel_reviews — the score a paid stay earns
-- ============================================================================

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

-- ============================================================================
-- 023_hostel_signals — patterns a person should look at
-- ============================================================================

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

-- ============================================================================
-- 024_hostel_refunds — cancelled beds, money on its way back.
-- ============================================================================

-- 024: hostel refunds — cancelled beds, money on its way back.
--
-- A refund is a request at the policy price, a person's decision, then a
-- Paystack transfer back to the student. The row keeps every step: the quote
-- the student was offered, the override (if a person made one) and why, the
-- provider reference, and the settlement that closes the booking. The bed's
-- accrual is reversed when the refund is approved, so a refunded bed never
-- pays the landlord; money already transferred becomes a debt on the next
-- payout (see hostel_payout_debt in lib/hostel-engine/payouts.ts).

CREATE TABLE IF NOT EXISTS hostel_refunds (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL,
  reference TEXT NOT NULL,
  landlord_id TEXT NOT NULL DEFAULT '',
  student_email TEXT NOT NULL DEFAULT '',
  amount INTEGER NOT NULL DEFAULT 0,
  gross_amount INTEGER NOT NULL DEFAULT 0,
  commission_amount INTEGER NOT NULL DEFAULT 0,
  net_amount INTEGER NOT NULL DEFAULT 0,
  policy TEXT NOT NULL DEFAULT 'NONE',
  percent INTEGER NOT NULL DEFAULT 0,
  override_reason TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'REQUESTED',
  requested_by TEXT NOT NULL DEFAULT '',
  decided_by TEXT NOT NULL DEFAULT '',
  decided_at TEXT NOT NULL DEFAULT '',
  paystack_reference TEXT NOT NULL DEFAULT '',
  provider_status TEXT NOT NULL DEFAULT '',
  settled_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hostel_refunds_booking ON hostel_refunds(booking_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hostel_refunds_status ON hostel_refunds(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hostel_refunds_landlord ON hostel_refunds(landlord_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hostel_refunds_provider ON hostel_refunds(paystack_reference) WHERE paystack_reference <> '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_hostel_refunds_open ON hostel_refunds(booking_id) WHERE status IN ('REQUESTED','APPROVED');

-- 026: cinema foundation — a room two students can be in at the same time.
--
-- Phase 1 of the Cinema plan (docs/Cinema/collaborative_study_video_architecture_plan.md):
-- the room and its membership, with no upload surface and no video object. The
-- host is a student_accounts row, the room carries the platform's uppercase
-- status vocabulary, and every timestamp is an ISO-8601 TEXT value, which is
-- what the rest of the schema speaks.
--
-- `cinema_participants` is membership, not presence: the Durable Object owns
-- who is connected while a room is live, and this table is how a join survives
-- a restart and how a moderator can answer "who was in this room" afterwards.
-- Uploads and the R2 surface arrive with Phase 2; chat is the 027 section
-- below, added with M4.

CREATE TABLE IF NOT EXISTS cinema_sessions (
  id                TEXT PRIMARY KEY,
  host_student_id   TEXT NOT NULL,
  title             TEXT NOT NULL DEFAULT '',
  video_source_type TEXT NOT NULL DEFAULT 'YOUTUBE',
  video_id          TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'CREATED',
  join_locked       INTEGER NOT NULL DEFAULT 0,
  started_at        TEXT NOT NULL DEFAULT '',
  ended_at          TEXT NOT NULL DEFAULT '',
  expired_at        TEXT NOT NULL DEFAULT '',
  deleted_at        TEXT NOT NULL DEFAULT '',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cinema_sessions_host ON cinema_sessions(host_student_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cinema_sessions_due ON cinema_sessions(status, ended_at);

CREATE TABLE IF NOT EXISTS cinema_participants (
  session_id   TEXT NOT NULL,
  student_id   TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  joined_at    TEXT NOT NULL,
  last_seen_at TEXT NOT NULL DEFAULT '',
  left_at      TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (session_id, student_id)
);

CREATE INDEX IF NOT EXISTS idx_cinema_participants_session ON cinema_participants(session_id, joined_at);
CREATE INDEX IF NOT EXISTS idx_cinema_participants_student ON cinema_participants(student_id, joined_at DESC);

-- 027: cinema chat — the memory behind the room socket.
--
-- The socket is the delivery path; this table is what a student who reconnects
-- or joins late is replayed (the newest fifty, oldest first). `metadata` holds
-- {"atSeconds": n} when the sender attached a video position, which the client
-- renders as a chip the host can use to bring the room to that moment. Rows
-- are purged by the cleanup job once `cinema_retention_hours` has passed, so
-- nothing here is an archive.

CREATE TABLE IF NOT EXISTS cinema_messages (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  sender_id   TEXT NOT NULL DEFAULT '',
  sender_name TEXT NOT NULL DEFAULT '',
  content     TEXT NOT NULL,
  metadata    TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cinema_messages_session ON cinema_messages(session_id, created_at DESC);

-- 028: cinema reports — the cards the console works through.
--
-- Students file reports from inside a room; nothing here is rule-generated, so
-- every row names the reporter. One open card exists per room or message
-- (`signal_key`, `entity_id`), and the unique index lets a second report fold
-- into the first instead of opening a duplicate. `report_count` counts distinct
-- reporters, `severity` escalates with them, and `evidence` holds
-- {"reports":[{"by","name","at"}],"messageExcerpt":...} so the moderator sees
-- what was said without rejoining the room. Reviewing or dismissing needs a
-- note and records who decided; the row is the audit trail's subject, not its
-- replacement.

CREATE TABLE IF NOT EXISTS cinema_risk_signals (
  id            TEXT PRIMARY KEY,
  signal_key    TEXT NOT NULL,
  severity      TEXT NOT NULL DEFAULT 'MEDIUM',
  entity_type   TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  reporter_id   TEXT NOT NULL DEFAULT '',
  reporter_name TEXT NOT NULL DEFAULT '',
  report_count  INTEGER NOT NULL DEFAULT 1,
  title         TEXT NOT NULL,
  detail        TEXT NOT NULL,
  evidence      TEXT NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'OPEN',
  reviewed_by   TEXT NOT NULL DEFAULT '',
  reviewed_at   TEXT NOT NULL DEFAULT '',
  review_note   TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cinema_signals_entity ON cinema_risk_signals(signal_key, entity_id, status);
CREATE INDEX IF NOT EXISTS idx_cinema_signals_status ON cinema_risk_signals(status, severity, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cinema_signals_session ON cinema_risk_signals(session_id, status);
