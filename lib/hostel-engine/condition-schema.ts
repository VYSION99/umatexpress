import { hasColumn, runSchemaPass, turso } from '@/lib/turso';
import { ensureHostelMaintenanceTables } from './maintenance-schema';
const STATEMENTS: string[] = [
  "CREATE TABLE IF NOT EXISTS hostel_condition_settings (\n property_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),\n checklist_json TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL\n)",
  "CREATE TABLE IF NOT EXISTS hostel_condition_records (\n id TEXT PRIMARY KEY, reference TEXT NOT NULL UNIQUE, booking_id TEXT NOT NULL, booking_reference TEXT NOT NULL,\n assignment_id TEXT NOT NULL, property_id TEXT NOT NULL, landlord_id TEXT NOT NULL, student_email TEXT NOT NULL, student_name TEXT NOT NULL,\n room_id TEXT NOT NULL, space_id TEXT NOT NULL, room_label TEXT NOT NULL, space_label TEXT NOT NULL, checklist_json TEXT NOT NULL,\n status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','SUBMITTED','CLARIFICATION_REQUESTED','ACKNOWLEDGED','CLOSED')),\n move_in_revision INTEGER NOT NULL DEFAULT 0, move_in_ack INTEGER NOT NULL DEFAULT 0,\n checkout_revision INTEGER NOT NULL DEFAULT 0, checkout_ack INTEGER NOT NULL DEFAULT 0,\n dispute_by TEXT NOT NULL DEFAULT '' CHECK(dispute_by IN ('','STUDENT','STAFF')), dispute_note TEXT NOT NULL DEFAULT '',\n version INTEGER NOT NULL DEFAULT 0, archived_at TEXT NOT NULL DEFAULT '', closed_at TEXT NOT NULL DEFAULT '',\n created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(booking_id,assignment_id)\n)",
  "CREATE INDEX IF NOT EXISTS idx_condition_student ON hostel_condition_records(student_email,created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_condition_host ON hostel_condition_records(landlord_id,property_id,status,updated_at DESC)",
  "CREATE TABLE IF NOT EXISTS hostel_condition_events (\n id TEXT PRIMARY KEY, record_id TEXT NOT NULL, mutation_id TEXT NOT NULL, payload_hash TEXT NOT NULL,\n version INTEGER NOT NULL, action TEXT NOT NULL, actor_type TEXT NOT NULL, actor_email TEXT NOT NULL, actor_name TEXT NOT NULL,\n note TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(record_id,mutation_id), UNIQUE(record_id,version)\n)",
  "CREATE INDEX IF NOT EXISTS idx_condition_events ON hostel_condition_events(record_id,version DESC)",
  "CREATE TABLE IF NOT EXISTS hostel_condition_revisions (\n id TEXT PRIMARY KEY, record_id TEXT NOT NULL, event_id TEXT NOT NULL UNIQUE, phase TEXT NOT NULL CHECK(phase IN ('MOVE_IN','CHECKOUT')),\n revision INTEGER NOT NULL, items_json TEXT NOT NULL, author_type TEXT NOT NULL, author_name TEXT NOT NULL, created_at TEXT NOT NULL,\n UNIQUE(record_id,phase,revision)\n)",
  "CREATE TABLE IF NOT EXISTS hostel_condition_photos (\n id TEXT PRIMARY KEY, record_id TEXT NOT NULL, event_id TEXT NOT NULL, item_key TEXT NOT NULL DEFAULT '', object_key TEXT NOT NULL UNIQUE,\n content_type TEXT NOT NULL, bytes INTEGER NOT NULL, file_name TEXT NOT NULL, created_at TEXT NOT NULL\n)",
  "CREATE INDEX IF NOT EXISTS idx_condition_photos ON hostel_condition_photos(record_id)"
];
let ready: Promise<void> | null = null;
export function ensureHostelConditionTables() {
 ready ??= (async () => {
  await ensureHostelMaintenanceTables();
  if (!await hasColumn('hostel_stays','assignment_id')) {
   try { await turso("ALTER TABLE hostel_stays ADD COLUMN assignment_id TEXT NOT NULL DEFAULT 'initial'"); }
   catch (error) { if (!await hasColumn('hostel_stays','assignment_id')) throw error; }
  }
  await runSchemaPass({metaTable:'campus_schema_meta',id:'hostelConditions',version:'032_hostel_conditions',statements:STATEMENTS});
 })().catch(error=>{ready=null;throw error;});
 return ready;
}
