-- Cinema hybrid streaming foundation. Safe to rerun.
-- Provider credentials and JaaS tokens are deliberately not stored here.

CREATE TABLE IF NOT EXISTS cinema_streaming_quota_leases (
  quota_key TEXT PRIMARY KEY,
  entitlement_id TEXT NOT NULL,
  next_free_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cinema_streaming_entitlements (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  organizer_id TEXT NOT NULL,
  quota_key TEXT NOT NULL,
  plan_code TEXT NOT NULL,
  provider TEXT NOT NULL,
  free_tier INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'RESERVED',
  max_stage_unique INTEGER NOT NULL,
  max_stage_concurrent INTEGER NOT NULL,
  max_duration_minutes INTEGER NOT NULL,
  starts_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  initial_host_student_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cinema_streaming_entitlements_quota
  ON cinema_streaming_entitlements(quota_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cinema_streaming_entitlements_status
  ON cinema_streaming_entitlements(status, starts_at);

CREATE TABLE IF NOT EXISTS cinema_stage_admissions (
  entitlement_id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  first_admitted_at TEXT NOT NULL,
  last_claimed_at TEXT NOT NULL DEFAULT '',
  active_device_id TEXT NOT NULL DEFAULT '',
  active_until TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ADMITTED',
  PRIMARY KEY(entitlement_id, student_id)
);

CREATE INDEX IF NOT EXISTS idx_cinema_stage_admissions_active
  ON cinema_stage_admissions(entitlement_id, status, active_until);

CREATE TABLE IF NOT EXISTS cinema_host_transfers (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  entitlement_id TEXT NOT NULL DEFAULT '',
  from_student_id TEXT NOT NULL,
  to_student_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  requested_at TEXT NOT NULL,
  accepted_at TEXT NOT NULL DEFAULT '',
  cancelled_at TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_cinema_host_transfers_event
  ON cinema_host_transfers(event_id, requested_at DESC);

-- An application-side safety rail for the JaaS monthly-active-user allowance.
-- Provider billing remains authoritative; this ledger prevents a new free
-- identity from receiving a token once the configured stop threshold is met.
CREATE TABLE IF NOT EXISTS cinema_jaas_monthly_users (
  month_key TEXT NOT NULL,
  student_id TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY(month_key, student_id)
);

CREATE INDEX IF NOT EXISTS idx_cinema_jaas_monthly_users_month
  ON cinema_jaas_monthly_users(month_key, first_seen_at);

