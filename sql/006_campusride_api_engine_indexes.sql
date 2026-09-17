CREATE INDEX IF NOT EXISTS idx_campus_rides_status ON campus_rides(status);
CREATE INDEX IF NOT EXISTS idx_campus_rides_driver ON campus_rides(driver_id);
CREATE INDEX IF NOT EXISTS idx_campus_rides_current_zone ON campus_rides(current_zone_id);
CREATE INDEX IF NOT EXISTS idx_campus_rides_corridor_status ON campus_rides(corridor_id, status);
CREATE INDEX IF NOT EXISTS idx_campus_queue_ride_status ON campus_queue_entries(ride_id, queue_status);
CREATE INDEX IF NOT EXISTS idx_campus_queue_reference ON campus_queue_entries(reference);
CREATE INDEX IF NOT EXISTS idx_campus_queue_phone ON campus_queue_entries(phone);
CREATE INDEX IF NOT EXISTS idx_campus_payments_reference ON campus_payments(reference);
CREATE INDEX IF NOT EXISTS idx_campus_drivers_active_zone ON campus_drivers(active, current_zone_id);
CREATE INDEX IF NOT EXISTS idx_campus_drivers_last_seen ON campus_drivers(last_seen_at);
CREATE INDEX IF NOT EXISTS idx_campus_audit_target ON campus_audit_logs(target_type, target_reference);

