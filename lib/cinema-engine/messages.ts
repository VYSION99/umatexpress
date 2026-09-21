import { CampusEngineError } from "@/lib/campus-engine/errors";
import { CINEMA_CHAT_MAX_LENGTH, type CinemaChatMessage } from "@/lib/cinema-engine/protocol";
import { isTursoConfiguredRuntime, rowsToObjects, runSchemaPass, turso } from "@/lib/turso";

/**
 * Cinema chat: the room socket is the delivery path, this table is the memory.
 *
 * A message is persisted before it is broadcast, so a student who reconnects —
 * or joins late — reads the same last fifty the room would have shown them.
 * Messages are capped in length, carry the video position in `metadata` rather
 * than in prose, and are purged by `runCinemaCleanup` once the room's retention
 * window has passed. Nothing here is an archive.
 */
export const CINEMA_MESSAGES_SCHEMA_VERSION = "027_cinema_messages";

/** How many messages a reconnecting socket is replayed. */
export const CINEMA_CHAT_REPLAY_LIMIT = 50;

/** Nothing a room may read in one call is larger than this. */
const CHAT_READ_LIMIT = 200;

const CINEMA_MESSAGE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS cinema_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    sender_id TEXT NOT NULL DEFAULT '',
    sender_name TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL,
    metadata TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cinema_messages_session ON cinema_messages(session_id, created_at DESC)`,
];

let cinemaMessageTablesReady: Promise<void> | null = null;

/** Memoised per isolate, like every other schema pass. */
export function ensureCinemaMessageTables() {
  cinemaMessageTablesReady ??= runSchemaPass({
    metaTable: "campus_schema_meta",
    id: "cinemaMessages",
    version: CINEMA_MESSAGES_SCHEMA_VERSION,
    statements: CINEMA_MESSAGE_STATEMENTS,
  }).catch((error: unknown) => {
    cinemaMessageTablesReady = null;
    throw error;
  });
  return cinemaMessageTablesReady;
}

/**
 * The metadata column is the plan's `{ "atSeconds": 320.0 }`, parsed
 * defensively: a row written by an older or hand-edited build must degrade to
 * "no timestamp" rather than break the replay.
 */
function timestampFromMetadata(metadata: unknown): number | null {
  const raw = String(metadata || "");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { atSeconds?: unknown };
    const numeric = Number(parsed?.atSeconds);
    return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
  } catch {
    return null;
  }
}

function messageView(row: Record<string, unknown>): CinemaChatMessage {
  return {
    id: String(row.id || ""),
    sessionId: String(row.session_id || ""),
    senderId: String(row.sender_id || ""),
    senderName: String(row.sender_name || ""),
    content: String(row.content || ""),
    atSeconds: timestampFromMetadata(row.metadata),
    createdAt: String(row.created_at || ""),
  };
}

export type CinemaChatSender = { id: string; name?: string };

/**
 * One message, validated and stored. The sender's name is copied onto the row
 * the way membership copies it, so a replay does not need a join per message
 * and a student who changes their display name does not rewrite history.
 */
export async function writeCinemaMessage(input: {
  sessionId: string;
  sender: CinemaChatSender;
  content: unknown;
  atSeconds?: unknown;
}): Promise<CinemaChatMessage> {
  await requireTurso();
  await ensureCinemaMessageTables();
  const sessionId = String(input.sessionId || "").trim();
  if (!sessionId) throw new CampusEngineError("VALIDATION_ERROR", "A message needs a room.", 400);
  const senderId = String(input.sender?.id || "").trim();
  if (!senderId) throw new CampusEngineError("VALIDATION_ERROR", "A message needs a sender.", 400);
  const content = String(input.content ?? "").trim();
  if (!content) throw new CampusEngineError("VALIDATION_ERROR", "An empty message was not sent.", 400);
  if (content.length > CINEMA_CHAT_MAX_LENGTH) {
    throw new CampusEngineError("VALIDATION_ERROR", `A message may be at most ${CINEMA_CHAT_MAX_LENGTH} characters.`, 400);
  }
  const numericAt = Number(input.atSeconds);
  const atSeconds = Number.isFinite(numericAt) && numericAt >= 0 ? numericAt : null;
  const row = {
    id: crypto.randomUUID(),
    session_id: sessionId,
    sender_id: senderId,
    sender_name: String(input.sender?.name || "").slice(0, 80),
    content,
    metadata: atSeconds === null ? "" : JSON.stringify({ atSeconds }),
    created_at: new Date().toISOString(),
  };
  await turso(
    "INSERT INTO cinema_messages (id,session_id,sender_id,sender_name,content,metadata,created_at) VALUES (?,?,?,?,?,?,?)",
    [row.id, row.session_id, row.sender_id, row.sender_name, row.content, row.metadata, row.created_at],
  );
  return messageView(row);
}

/**
 * The tail of the conversation, oldest first: the shape a chat window renders.
 * The query takes the newest rows and the caller reverses them. The tie-break
 * on `rowid` matters: a burst typed inside one millisecond shares a timestamp,
 * and without it SQLite would replay that burst in reverse.
 */
export async function recentCinemaMessages(sessionId: string, limit = CINEMA_CHAT_REPLAY_LIMIT): Promise<CinemaChatMessage[]> {
  await requireTurso();
  await ensureCinemaMessageTables();
  const id = String(sessionId || "").trim();
  if (!id) return [];
  const capped = Math.min(Math.max(Math.round(Number(limit) || CINEMA_CHAT_REPLAY_LIMIT), 1), CHAT_READ_LIMIT);
  const rows = rowsToObjects(await turso(
    `SELECT id,session_id,sender_id,sender_name,content,metadata,created_at FROM cinema_messages
      WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ${capped}`,
    [id],
  ));
  return rows.map(messageView).reverse();
}

/** Chat is temporary: the cleanup job removes it with the membership. */
export async function purgeCinemaMessages(sessionId: string) {
  await requireTurso();
  await ensureCinemaMessageTables();
  const result = await turso("DELETE FROM cinema_messages WHERE session_id = ?", [String(sessionId || "")]);
  return Number(result.affected_row_count || 0);
}

async function requireTurso() {
  if (await isTursoConfiguredRuntime()) return;
  throw new CampusEngineError("CONFIG_REQUIRED", "Cinema needs the database to be configured.", 503);
}
