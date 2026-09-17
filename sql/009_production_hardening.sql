-- UMaTeXPRESS production hardening migration.
-- Run this after 001-008. It is safe to run more than once, except the
-- ALTER TABLE statements should be skipped if your DB already has the column.

-- VacationRide: keep the base fare and provider charge separate from total paid.
-- Skip each ALTER if PRAGMA table_info(payments) already lists the column.
ALTER TABLE payments ADD COLUMN fare_amount INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payments ADD COLUMN fee_amount INTEGER NOT NULL DEFAULT 0;

UPDATE payments
SET fare_amount = amount
WHERE fare_amount = 0;

-- CampusRide: keep the base fare and provider charge separate from total paid.
-- Skip each ALTER if PRAGMA table_info(campus_payments) already lists the column.
ALTER TABLE campus_payments ADD COLUMN fare_amount INTEGER NOT NULL DEFAULT 0;
ALTER TABLE campus_payments ADD COLUMN fee_amount INTEGER NOT NULL DEFAULT 0;

UPDATE campus_payments
SET fare_amount = amount
WHERE fare_amount = 0;

-- Prevent duplicate active queue positions for the same ride.
CREATE UNIQUE INDEX IF NOT EXISTS idx_campus_queue_active_position
ON campus_queue_entries(ride_id, queue_position)
WHERE queue_status IN ('PAID_WAITING','ACCEPTED_BY_DRIVER','DRIVER_ARRIVED','BOARDED');

-- Prevent duplicate driver phone records once real driver accounts are used.
CREATE UNIQUE INDEX IF NOT EXISTS idx_campus_drivers_phone
ON campus_drivers(phone)
WHERE phone <> '';

-- Helpful operational indexes.
CREATE INDEX IF NOT EXISTS idx_payments_status_created
ON payments(status, created_at);

CREATE INDEX IF NOT EXISTS idx_bookings_status_created
ON bookings(booking_status, created_at);

CREATE INDEX IF NOT EXISTS idx_campus_payments_status_created
ON campus_payments(status, created_at);

CREATE INDEX IF NOT EXISTS idx_campus_queue_status_created
ON campus_queue_entries(queue_status, created_at);
