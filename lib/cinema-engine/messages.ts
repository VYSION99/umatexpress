import { CINEMA_HOST_ASSISTANCE_SCHEMA } from "./host-assistance-schema";
import { CINEMA_PRIVATE_STUDY_SCHEMA } from "./private-study-schema";
import { CINEMA_CHAT_ASSISTANT_SCHEMA } from "./chat-assistant-schema";
import { CampusEngineError } from "@/lib/campus-engine/errors";
import { CINEMA_CHAT_MAX_LENGTH, type CinemaChatMessage } from "@/lib/cinema-engine/protocol";
import { isTursoConfiguredRuntime, rowsToObjects, runSchemaPass, turso, tursoTransaction } from "@/lib/turso";

/**
 * Cinema chat: the room socket is the delivery path, this table is the memory.
 *
 * A message is persisted before it is broadcast, so a student who reconnects —
 * or joins late — reads the same last fifty the room would have shown them.
 * Messages are capped in length, carry the video position in `metadata` rather
 * than in prose, and are purged by `runCinemaCleanup` once the room's retention
 * window has passed. Nothing here is an archive.
 */
export const CINEMA_MESSAGES_SCHEMA_VERSION = "054_cinema_host_assistance";

/** How many messages a reconnecting socket is replayed. */
export const CINEMA_CHAT_REPLAY_LIMIT = 50;

/** Nothing a room may read in one call is larger than this. */
const CHAT_READ_LIMIT = 200;

const CINEMA_MESSAGE_STATEMENTS = [
  ...CINEMA_CHAT_ASSISTANT_SCHEMA,
  ...CINEMA_PRIVATE_STUDY_SCHEMA,
  ...CINEMA_HOST_ASSISTANCE_SCHEMA,
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
  `CREATE TABLE IF NOT EXISTS cinema_message_order (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL,
    parent_id TEXT NOT NULL DEFAULT '', thread_id TEXT NOT NULL DEFAULT '')`,
  `INSERT OR IGNORE INTO cinema_message_order(message_id,session_id,thread_id)
    SELECT id,session_id,id FROM cinema_messages ORDER BY created_at,rowid`,
  `CREATE INDEX IF NOT EXISTS idx_cinema_chat_order ON cinema_message_order(session_id,sequence)`,
  `CREATE INDEX IF NOT EXISTS idx_cinema_chat_thread ON cinema_message_order(session_id,thread_id,sequence)`,
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
    const numeric = parsed?.atSeconds == null ? NaN : Number(parsed.atSeconds);
    return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
  } catch {
    return null;
  }
}

function videoFromMetadata(metadata: unknown): CinemaChatMessage["video"] {
  try {
    const value = JSON.parse(String(metadata || "{}")) as { video?: { sourceType?: string; videoId?: string } };
    return value.video && ["YOUTUBE", "UPLOAD"].includes(value.video.sourceType || "") && typeof value.video.videoId === "string"
      ? value.video as NonNullable<CinemaChatMessage["video"]> : undefined;
  } catch { return undefined; }
}

const CHAT_SELECT = `SELECT o.message_id AS id,o.session_id,COALESCE(m.sender_id,'') AS sender_id,
  COALESCE(m.sender_name,'') AS sender_name,COALESCE(m.content,'') AS content,COALESCE(m.metadata,'') AS metadata,
  COALESCE(m.created_at,'') AS created_at,o.sequence,o.parent_id,o.thread_id,
  CASE WHEN m.id IS NULL THEN 1 ELSE 0 END AS removed
  FROM cinema_message_order o LEFT JOIN cinema_messages m ON m.id=o.message_id AND m.session_id=o.session_id`;

function assistantFromMetadata(metadata: unknown): CinemaChatMessage["assistant"] {
  try { return (JSON.parse(String(metadata || "{}")) as { assistant?: CinemaChatMessage["assistant"] }).assistant; }
  catch { return undefined; }
}

function aiAssistedFromMetadata(metadata: unknown) {
  try { return (JSON.parse(String(metadata || "{}")) as { aiAssisted?: unknown }).aiAssisted === true; } catch { return false; }
}

function messageView(row: Record<string, unknown>): CinemaChatMessage {
  const removed = Number(row.removed || 0) === 1;
  return {
    id: String(row.id || ""),
    sessionId: String(row.session_id || ""),
    senderId: String(row.sender_id || ""),
    senderName: String(row.sender_name || ""),
    content: String(row.content || ""),
    atSeconds: removed ? null : timestampFromMetadata(row.metadata),
    sequence: Number(row.sequence || 0),
    parentMessageId: String(row.parent_id || "") || undefined,
    threadId: String(row.thread_id || row.id || ""),
    video: removed ? undefined : videoFromMetadata(row.metadata),
    removed,
    assistant: removed ? undefined : assistantFromMetadata(row.metadata),
    aiAssisted: !removed && aiAssistedFromMetadata(row.metadata),
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
  requestId?: string;
  parentMessageId?: string;
  video?: CinemaChatMessage["video"];
  expectedVideo?: CinemaChatMessage["video"];
  requireMembership?: boolean;
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
  const numericAt = input.atSeconds == null ? NaN : Number(input.atSeconds);
  const atSeconds = Number.isFinite(numericAt) && numericAt >= 0 ? numericAt : null;
  let id = crypto.randomUUID() as string;
  if (input.requestId) {
    if (!/^[A-Za-z0-9-]{8,64}$/.test(input.requestId)) throw new CampusEngineError("VALIDATION_ERROR", "Invalid message identifier.", 400);
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([sessionId, senderId, input.requestId])));
    id = Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
    const existing = await readCinemaMessage(id);
    if (existing) return existing;
  }
  // Check idempotency before current-source validation: a lost acknowledgement
  // must still resolve after the playlist has advanced.
  if (input.expectedVideo && (!input.video || input.expectedVideo.sourceType !== input.video.sourceType || input.expectedVideo.videoId !== input.video.videoId)) {
    throw new CampusEngineError("CONFLICT", "The video changed before this message arrived. Remove its video reference or write a new message.", 409);
  }
  const parentId = String(input.parentMessageId || "");
  const parent = parentId ? await readCinemaMessage(parentId) : null;
  if (parentId && (!parent || parent.sessionId !== sessionId || parent.removed)) {
    throw new CampusEngineError("NOT_FOUND", "The message you are replying to is no longer available in this room.", 404);
  }
  const threadId = parent?.threadId || parent?.id || id;
  const row = {
    id,
    session_id: sessionId,
    sender_id: senderId,
    sender_name: String(input.sender?.name || "").slice(0, 80),
    content,
    metadata: JSON.stringify({ ...(atSeconds === null ? {} : { atSeconds }), ...(input.video && atSeconds !== null ? { video: input.video } : {}) }),
    created_at: new Date().toISOString(),
  };
  await tursoTransaction([
    { sql: `INSERT INTO cinema_messages (id,session_id,sender_id,sender_name,content,metadata,created_at)
        SELECT ?,?,?,?,?,?,? ${input.requireMembership ? `WHERE EXISTS(SELECT 1 FROM cinema_sessions s JOIN cinema_participants p ON p.session_id=s.id
          WHERE s.id=? AND p.student_id=? AND s.status IN ('CREATED','LIVE'))` : ""} ON CONFLICT(id) DO NOTHING`,
      args: [row.id, row.session_id, row.sender_id, row.sender_name, row.content, row.metadata, row.created_at, ...(input.requireMembership ? [sessionId, senderId] : [])] },
    { sql: `INSERT OR IGNORE INTO cinema_message_order(message_id,session_id,parent_id,thread_id)
        SELECT id,session_id,?,? FROM cinema_messages WHERE id=? AND session_id=?`, args: [parentId, threadId, id, sessionId] },
  ]);
  const stored = await readCinemaMessage(id);
  if (!stored && input.requireMembership) throw new CampusEngineError("FORBIDDEN", "Your room access changed before this message arrived.", 403);
  return stored || messageView(row);
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
  const rows = rowsToObjects(await turso(`${CHAT_SELECT} WHERE o.session_id = ? ORDER BY o.sequence DESC LIMIT ${capped}`, [id]));
  return rows.map(messageView).reverse();
}

/** Chat is temporary: the cleanup job removes it with the membership. */
export async function purgeCinemaMessages(sessionId: string) {
  await requireTurso();
  await ensureCinemaMessageTables();
  const [result] = await tursoTransaction([
    { sql: "DELETE FROM cinema_messages WHERE session_id = ?", args: [String(sessionId || "")] },
    { sql: "DELETE FROM cinema_message_order WHERE session_id = ?", args: [String(sessionId || "")] },
    { sql: "DELETE FROM cinema_chat_ai_evidence WHERE job_id IN (SELECT id FROM cinema_chat_ai_jobs WHERE session_id=?)", args: [String(sessionId || "")] },
    { sql: "DELETE FROM cinema_chat_ai_jobs WHERE session_id=?", args: [String(sessionId || "")] },
    { sql: "DELETE FROM cinema_private_study_evidence WHERE request_id IN (SELECT id FROM cinema_private_study_requests WHERE session_id=?)", args: [String(sessionId || "")] },
    { sql: "DELETE FROM cinema_host_assistance WHERE request_id IN (SELECT id FROM cinema_private_study_requests WHERE session_id=?)", args: [String(sessionId || "")] },
    { sql: "DELETE FROM cinema_private_study_requests WHERE session_id=?", args: [String(sessionId || "")] },
  ]);
  return Number(result.affected_row_count || 0);
}

/** One message, for a report that has to name what it is about. */
export async function readCinemaMessage(messageId: string): Promise<CinemaChatMessage | null> {
  await requireTurso();
  await ensureCinemaMessageTables();
  const id = String(messageId || "").trim();
  if (!id) return null;
  const row = rowsToObjects(await turso(`${CHAT_SELECT} WHERE o.message_id = ? LIMIT 1`, [id]))[0];
  return row ? messageView(row) : null;
}

/** Revalidate bounded evidence in one read, always scoped to its original room. */
export async function readCinemaMessagesById(sessionId: string, ids: string[]): Promise<CinemaChatMessage[]> {
  await requireTurso(); await ensureCinemaMessageTables();
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  if (unique.length > 100) throw new CampusEngineError("VALIDATION_ERROR", "Choose at most 100 messages.", 400);
  return rowsToObjects(await turso(`${CHAT_SELECT} WHERE o.session_id=? AND o.message_id IN (${unique.map(() => "?").join(",")})`, [sessionId, ...unique])).map(messageView);
}

/**
 * Moderator removal. The row goes first, so a reconnect can never replay what
 * was taken down; the live room is told separately, best-effort, because a
 * socket that has already received a frame cannot unknow it anyway.
 */
export async function removeCinemaMessage(messageId: string, expectedSessionId = "") {
  await requireTurso();
  await ensureCinemaMessageTables();
  const message = await readCinemaMessage(messageId);
  if (!message || message.removed) throw new CampusEngineError("NOT_FOUND", "That message no longer exists.", 404);
  // A console route acts on a room; a message that belongs to another room
  // reports as missing rather than letting one room's action touch another's.
  if (expectedSessionId && message.sessionId !== String(expectedSessionId)) {
    throw new CampusEngineError("NOT_FOUND", "That message is not in this room.", 404);
  }
  await tursoTransaction([
    { sql: `UPDATE cinema_chat_ai_jobs SET status='CANCELLED',claim_token='',lease_until='',error='A source message was removed.',updated_at=?
        WHERE session_id=? AND (id=? OR answer_id=? OR id IN (SELECT job_id FROM cinema_chat_ai_evidence WHERE kind='MESSAGE' AND source_id=?))`,
      args: [new Date().toISOString(), message.sessionId, message.id, message.id, message.id] },
    { sql: "DELETE FROM cinema_messages WHERE id IN (SELECT answer_id FROM cinema_chat_ai_jobs WHERE session_id=? AND status='CANCELLED' AND answer_id<>'')", args: [message.sessionId] },
    { sql: "UPDATE cinema_private_study_requests SET status='CANCELLED',answer='',citations='[]',dependencies='[]',claim_token='',lease_until='',error='A source message was removed.',updated_at=? WHERE session_id=? AND status<>'DELETED' AND (anchor_id=? OR id IN (SELECT request_id FROM cinema_private_study_evidence WHERE kind='MESSAGE' AND source_id=?))", args: [new Date().toISOString(), message.sessionId, message.id, message.id] },
    { sql: "DELETE FROM cinema_messages WHERE id = ?", args: [message.id] },
  ]);
  return message;
}

async function requireTurso() {
  if (await isTursoConfiguredRuntime()) return;
  throw new CampusEngineError("CONFIG_REQUIRED", "Cinema needs the database to be configured.", 503);
}

/** Monotonic cursors survive timestamp ties and moderator deletion. */
export async function cinemaMessagePage(input: { sessionId: string; before?: number; after?: number; through?: number; threadId?: string; limit?: number }) {
  await requireTurso(); await ensureCinemaMessageTables();
  const limit = Math.max(1, Math.min(100, Math.floor(input.limit || 50)));
  const where = ["o.session_id = ?"]; const args: (string | number)[] = [input.sessionId];
  const latest = rowsToObjects(await turso("SELECT COALESCE(MAX(sequence),0) AS sequence FROM cinema_message_order WHERE session_id=?", [input.sessionId]))[0];
  const through = Math.min(Number(latest?.sequence || 0), input.through ?? Number(latest?.sequence || 0));
  where.push("o.sequence <= ?"); args.push(through);
  if (input.before !== undefined) { where.push("o.sequence < ?"); args.push(input.before); }
  if (input.after !== undefined) { where.push("o.sequence > ?"); args.push(input.after); }
  if (input.threadId) { where.push("o.thread_id = ?"); args.push(input.threadId); }
  const ascending = input.after !== undefined;
  const rows = rowsToObjects(await turso(`${CHAT_SELECT} WHERE ${where.join(" AND ")} ORDER BY o.sequence ${ascending ? "ASC" : "DESC"} LIMIT ${limit + 1}`, args));
  const hasMore = rows.length > limit;
  const messages = rows.slice(0, limit).map(messageView);
  if (!ascending) messages.reverse();
  const parentIds = [...new Set(messages.map(message => message.parentMessageId).filter(Boolean))] as string[];
  const context = parentIds.length ? rowsToObjects(await turso(`${CHAT_SELECT} WHERE o.session_id=? AND o.message_id IN (${parentIds.map(() => "?").join(",")})`, [input.sessionId, ...parentIds])).map(messageView) : [];
  return { messages, context, hasMore, through, before: messages[0]?.sequence || 0, after: messages.at(-1)?.sequence || input.after || 0 };
}
