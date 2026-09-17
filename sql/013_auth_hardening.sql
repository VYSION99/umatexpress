-- Access hardening: session revocation and brute-force lockouts.
-- Run after sql/012_payment_events.sql. Skip the ALTER TABLE lines if the
-- column already exists; the CREATE statements are safe to re-run.

-- Bumping this version on a password change retires every existing session.
ALTER TABLE campus_drivers ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;

-- Same mechanism for administrator sessions.
ALTER TABLE admin_credentials ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0;

-- Durable failed-attempt counters for login and PIN verification.
CREATE TABLE IF NOT EXISTS auth_failures (
  scope        TEXT NOT NULL,
  subject      TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT NOT NULL DEFAULT '',
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (scope, subject)
);

CREATE INDEX IF NOT EXISTS idx_auth_failures_locked
ON auth_failures(scope, locked_until);
