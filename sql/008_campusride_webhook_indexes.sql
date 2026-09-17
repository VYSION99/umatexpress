-- campusRide Paystack webhook support indexes.
-- No new table is required. These indexes make callback/webhook settlement
-- and driver queue lookups fast on existing Turso databases.

CREATE INDEX IF NOT EXISTS idx_campus_payments_reference ON campus_payments(reference);
CREATE INDEX IF NOT EXISTS idx_campus_payments_queue ON campus_payments(queue_entry_id);
CREATE INDEX IF NOT EXISTS idx_campus_queue_reference ON campus_queue_entries(reference);
CREATE INDEX IF NOT EXISTS idx_campus_queue_ride_status ON campus_queue_entries(ride_id, queue_status);
