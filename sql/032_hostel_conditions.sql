-- Apply once; runtime migration checks the assignment_id column before adding it.
ALTER TABLE hostel_stays ADD COLUMN assignment_id TEXT NOT NULL DEFAULT 'initial';
CREATE TABLE IF NOT EXISTS hostel_condition_settings (
 property_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
 checklist_json TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS hostel_condition_records (
 id TEXT PRIMARY KEY, reference TEXT NOT NULL UNIQUE, booking_id TEXT NOT NULL, booking_reference TEXT NOT NULL,
 assignment_id TEXT NOT NULL, property_id TEXT NOT NULL, landlord_id TEXT NOT NULL, student_email TEXT NOT NULL, student_name TEXT NOT NULL,
 room_id TEXT NOT NULL, space_id TEXT NOT NULL, room_label TEXT NOT NULL, space_label TEXT NOT NULL, checklist_json TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','SUBMITTED','CLARIFICATION_REQUESTED','ACKNOWLEDGED','CLOSED')),
 move_in_revision INTEGER NOT NULL DEFAULT 0, move_in_ack INTEGER NOT NULL DEFAULT 0,
 checkout_revision INTEGER NOT NULL DEFAULT 0, checkout_ack INTEGER NOT NULL DEFAULT 0,
 dispute_by TEXT NOT NULL DEFAULT '' CHECK(dispute_by IN ('','STUDENT','STAFF')), dispute_note TEXT NOT NULL DEFAULT '',
 version INTEGER NOT NULL DEFAULT 0, archived_at TEXT NOT NULL DEFAULT '', closed_at TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(booking_id,assignment_id)
);
CREATE INDEX IF NOT EXISTS idx_condition_student ON hostel_condition_records(student_email,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_condition_host ON hostel_condition_records(landlord_id,property_id,status,updated_at DESC);
CREATE TABLE IF NOT EXISTS hostel_condition_events (
 id TEXT PRIMARY KEY, record_id TEXT NOT NULL, mutation_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
 version INTEGER NOT NULL, action TEXT NOT NULL, actor_type TEXT NOT NULL, actor_email TEXT NOT NULL, actor_name TEXT NOT NULL,
 note TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(record_id,mutation_id), UNIQUE(record_id,version)
);
CREATE INDEX IF NOT EXISTS idx_condition_events ON hostel_condition_events(record_id,version DESC);
CREATE TABLE IF NOT EXISTS hostel_condition_revisions (
 id TEXT PRIMARY KEY, record_id TEXT NOT NULL, event_id TEXT NOT NULL UNIQUE, phase TEXT NOT NULL CHECK(phase IN ('MOVE_IN','CHECKOUT')),
 revision INTEGER NOT NULL, items_json TEXT NOT NULL, author_type TEXT NOT NULL, author_name TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(record_id,phase,revision)
);
CREATE TABLE IF NOT EXISTS hostel_condition_photos (
 id TEXT PRIMARY KEY, record_id TEXT NOT NULL, event_id TEXT NOT NULL, item_key TEXT NOT NULL DEFAULT '', object_key TEXT NOT NULL UNIQUE,
 content_type TEXT NOT NULL, bytes INTEGER NOT NULL, file_name TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_condition_photos ON hostel_condition_photos(record_id);
