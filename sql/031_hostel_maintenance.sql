CREATE TABLE IF NOT EXISTS hostel_maintenance_settings (
 property_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
 service_hours TEXT NOT NULL DEFAULT '', acknowledgement_hours INTEGER NOT NULL DEFAULT 24 CHECK(acknowledgement_hours BETWEEN 1 AND 168),
 version INTEGER NOT NULL DEFAULT 0, updated_by TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS hostel_maintenance_requests (
 id TEXT PRIMARY KEY, reference TEXT UNIQUE NOT NULL, booking_id TEXT NOT NULL, property_id TEXT NOT NULL, landlord_id TEXT NOT NULL,
 student_email TEXT NOT NULL, student_name TEXT NOT NULL, room_label TEXT NOT NULL, space_label TEXT NOT NULL,
 category TEXT NOT NULL CHECK(category IN ('WATER','ELECTRICITY','PLUMBING','FURNITURE','INTERNET','OTHER')),
 urgency TEXT NOT NULL CHECK(urgency IN ('ROUTINE','URGENT')), location_type TEXT NOT NULL CHECK(location_type IN ('ROOM','SHARED')),
 location_detail TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL,
 entry_permission TEXT NOT NULL CHECK(entry_permission IN ('PRESENT_ONLY','ARRANGE_FIRST','PERMITTED')), preferred_access TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'SUBMITTED' CHECK(status IN ('SUBMITTED','ACKNOWLEDGED','IN_PROGRESS','WAITING_FOR_STUDENT','RESOLVED','CLOSED','CANCELLED')),
 assignee_email TEXT NOT NULL DEFAULT '', assignee_name TEXT NOT NULL DEFAULT '',
 client_request_id TEXT NOT NULL, payload_hash TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0, mutation_id TEXT NOT NULL,
 acknowledgement_due_at TEXT NOT NULL, acknowledged_at TEXT NOT NULL DEFAULT '', resolved_at TEXT NOT NULL DEFAULT '',
 escalated_at TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(student_email,client_request_id)
);
CREATE INDEX IF NOT EXISTS idx_maintenance_student ON hostel_maintenance_requests(student_email,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_maintenance_host_queue ON hostel_maintenance_requests(landlord_id,status,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_maintenance_property ON hostel_maintenance_requests(property_id,status,acknowledgement_due_at);
CREATE TABLE IF NOT EXISTS hostel_maintenance_events (
 id TEXT PRIMARY KEY, request_id TEXT NOT NULL, mutation_id TEXT NOT NULL, actor_type TEXT NOT NULL, actor_email TEXT NOT NULL, actor_name TEXT NOT NULL,
 action TEXT NOT NULL, previous_status TEXT NOT NULL, status TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', details TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL,
 UNIQUE(request_id,mutation_id)
);
CREATE INDEX IF NOT EXISTS idx_maintenance_events ON hostel_maintenance_events(request_id,created_at,id);
CREATE TABLE IF NOT EXISTS hostel_maintenance_attachments (
 id TEXT PRIMARY KEY, request_id TEXT NOT NULL, event_id TEXT NOT NULL, object_key TEXT UNIQUE NOT NULL, content_type TEXT NOT NULL,
 bytes INTEGER NOT NULL, file_name TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_maintenance_attachments ON hostel_maintenance_attachments(request_id);
