-- UMaTeXPRESS dynamic trip hardening reference migration.
--
-- The app also performs additive scheduled_trips migrations at runtime. Use
-- this file as a manual Turso reference when you want to inspect or rebuild
-- an existing database cleanly.

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

-- If you already have scheduled_trips and a column is missing, run only the
-- matching ALTER statement below. Do not run an ALTER for a column that already
-- exists.
--
-- ALTER TABLE scheduled_trips ADD COLUMN travel_date TEXT NOT NULL DEFAULT '2026-09-05';
-- ALTER TABLE scheduled_trips ADD COLUMN tag TEXT NOT NULL DEFAULT '';
-- ALTER TABLE scheduled_trips ADD COLUMN amenities TEXT NOT NULL DEFAULT '["AC","Wi-Fi","USB power"]';
-- ALTER TABLE scheduled_trips ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
-- ALTER TABLE scheduled_trips ADD COLUMN display_order INTEGER NOT NULL DEFAULT 0;
-- ALTER TABLE scheduled_trips ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';

-- Optional existing-table cleanup for stricter trip_id TEXT schema.
-- Run these only if you already have old INTEGER trip_id tables and want the
-- schema to match the dynamic trip code exactly.

/*
CREATE TABLE IF NOT EXISTS bookings_new (
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

INSERT OR IGNORE INTO bookings_new (
  id, reference, passenger_name, email, phone, seat, trip_id, travel_date,
  amount, payment_status, booking_status, hold_expires_at, confirmed_at,
  departure_time, created_at
)
SELECT
  id, reference, passenger_name, email, phone, seat, CAST(trip_id AS TEXT),
  travel_date, amount, payment_status, booking_status, hold_expires_at,
  confirmed_at, departure_time, created_at
FROM bookings;

CREATE TABLE IF NOT EXISTS seat_holds_new (
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

INSERT OR IGNORE INTO seat_holds_new (
  id, booking_id, trip_id, travel_date, seat, status, expires_at, created_at
)
SELECT
  id, booking_id, CAST(trip_id AS TEXT), travel_date, seat, status, expires_at, created_at
FROM seat_holds;

-- After confirming copied row counts, swap manually:
-- DROP TABLE bookings;
-- ALTER TABLE bookings_new RENAME TO bookings;
-- DROP TABLE seat_holds;
-- ALTER TABLE seat_holds_new RENAME TO seat_holds;
*/
