-- ============================================================================
-- 014 — Hostel Finder foundation
-- ============================================================================
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
  -- Landlord-side commission, stored per booking when money arrives.
  commission_bps INTEGER NOT NULL DEFAULT 500,
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
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One offer per bed per period. A space is re-listed next year, never twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_hostel_listings_space_period ON hostel_listings(space_id, period_id);
CREATE INDEX IF NOT EXISTS idx_hostel_listings_period_status ON hostel_listings(period_id, status);

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
