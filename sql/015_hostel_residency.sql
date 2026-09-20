-- ============================================================================
-- 015 — Hostel residency: bookings, payouts, plugins and messages
-- ============================================================================
-- Phase 2/3/4 of the Hostel Finder. A paid booking is a residency: it holds the
-- bed, splits the payment 91/9 between the landlord and the platform, writes an
-- accrual the payout phase releases, and opens the thread the resident and the
-- landlord talk on.
--
-- Plugins are the services a landlord switches on for a year, each with one
-- platform price, billed beside the 9% commission rather than instead of it.
--
-- Safe to run on a fresh database and safe to run twice. The same statements
-- live in 000_umatexpress_full_migration.sql (section 11); the app also applies
-- them at runtime, so a deployment works before this file is run by hand.
-- ============================================================================

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
  commission_bps INTEGER NOT NULL DEFAULT 900,
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

-- The agreed hostel rate is 9%. Rows still on the placeholder 5% default move
-- with it; a rate anybody negotiated on purpose was never stored as 500.
UPDATE hostel_landlords SET commission_bps = 900, updated_at = updated_at WHERE commission_bps = 500;
