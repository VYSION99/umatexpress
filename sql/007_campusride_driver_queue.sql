-- campusRide driver queue lifecycle hardening.
-- For existing Turso databases, run each ALTER only if the column does not exist.
-- The runtime also self-heals these columns through ensureCampusRideTables().

ALTER TABLE campus_queue_entries ADD COLUMN ride_pin TEXT NOT NULL DEFAULT '';
ALTER TABLE campus_queue_entries ADD COLUMN accepted_at TEXT;
ALTER TABLE campus_queue_entries ADD COLUMN arrived_at TEXT;
ALTER TABLE campus_queue_entries ADD COLUMN boarded_at TEXT;
ALTER TABLE campus_queue_entries ADD COLUMN completed_at TEXT;
ALTER TABLE campus_queue_entries ADD COLUMN cancelled_at TEXT;

CREATE INDEX IF NOT EXISTS idx_campus_queue_ride_status ON campus_queue_entries(ride_id, queue_status);
CREATE INDEX IF NOT EXISTS idx_campus_queue_reference ON campus_queue_entries(reference);
