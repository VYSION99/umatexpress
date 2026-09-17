-- campusRide Phase 1: driver identity and password security.
-- Run after sql/009_production_hardening.sql.
-- Skip each ALTER TABLE line if the column already exists.

ALTER TABLE campus_drivers ADD COLUMN password_reset_required INTEGER NOT NULL DEFAULT 1;
ALTER TABLE campus_drivers ADD COLUMN password_changed_at TEXT;

-- Mark existing drivers with a stored hash as requiring password change until
-- they sign in and set their own password.
UPDATE campus_drivers
SET password_reset_required = 1
WHERE password_reset_required IS NULL;

CREATE INDEX IF NOT EXISTS idx_campus_drivers_password_reset
ON campus_drivers(password_reset_required, active);
