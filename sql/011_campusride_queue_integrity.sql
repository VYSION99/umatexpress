-- campusRide queue integrity.
-- Run after sql/010_campusride_phase1_driver_security.sql.
-- Skip the ALTER TABLE lines if your DB already has the column; the backfill
-- and index are safe to re-run.

-- Monotonic queue positions. The counter only ever increases, so a position is
-- never reused after a cancellation and concurrent joins cannot collide.
ALTER TABLE campus_rides ADD COLUMN next_queue_position INTEGER NOT NULL DEFAULT 1;

-- Unpaid reservations now hold a slot until this timestamp, then release it.
ALTER TABLE campus_queue_entries ADD COLUMN expires_at TEXT;

-- Never hand out a position that an existing entry already occupies.
UPDATE campus_rides
SET next_queue_position = COALESCE(
  (SELECT MAX(queue_position) + 1 FROM campus_queue_entries q WHERE q.ride_id = campus_rides.id),
  1
);

CREATE INDEX IF NOT EXISTS idx_campus_queue_expiry
ON campus_queue_entries(queue_status, expires_at);
