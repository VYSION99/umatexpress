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
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT ''
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
  created_at TEXT NOT NULL
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
-- ALTER TABLE bookings                 ADD COLUMN booking_status TEXT NOT NULL DEFAULT 'AWAITING_PAYMENT';
-- ALTER TABLE bookings                 ADD COLUMN hold_expires_at TEXT;
-- ALTER TABLE bookings                 ADD COLUMN confirmed_at TEXT;
-- ALTER TABLE bookings                 ADD COLUMN departure_time TEXT;
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
