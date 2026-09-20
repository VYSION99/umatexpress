import { ensureHostelTables } from "@/lib/hostel-engine/landlord";
import { runSchemaPass } from "@/lib/turso";

/**
 * The communication tables live in their own module so both the chat engine and
 * the booking engine can guarantee them without importing each other.
 */
const MESSAGE_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS hostel_messages (
    id TEXT PRIMARY KEY,
    booking_id TEXT NOT NULL,
    sender_type TEXT NOT NULL,
    sender_id TEXT NOT NULL DEFAULT '',
    sender_name TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL,
    metadata TEXT NOT NULL DEFAULT '',
    read_by TEXT NOT NULL DEFAULT '',
    read_at TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS hostel_announcements (
    id TEXT PRIMARY KEY,
    landlord_id TEXT NOT NULL,
    property_id TEXT NOT NULL DEFAULT '',
    author_email TEXT NOT NULL DEFAULT '',
    author_name TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PUBLISHED',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_hostel_messages_booking ON hostel_messages(booking_id, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_hostel_messages_unread ON hostel_messages(booking_id, read_by, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_hostel_announcements_landlord ON hostel_announcements(landlord_id, property_id, created_at DESC)",
];

let messageTablesReady: Promise<void> | null = null;

export function ensureHostelMessageTables() {
  messageTablesReady ??= (async () => {
    await ensureHostelTables();
    await runSchemaPass({ id: "hostel_messages", version: "015_hostel_messages", statements: MESSAGE_SCHEMA_STATEMENTS });
  })();
  return messageTablesReady;
}
