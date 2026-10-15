import { CampusEngineError } from "@/lib/campus-engine/errors";
import { isRoomActive, readRoom } from "@/lib/cinema-engine/rooms";
import { rowsToObjects, runSchemaPass, turso, tursoTransaction } from "@/lib/turso";

const TRANSCRIPT_SCHEMA_VERSION = "037_cinema_transcripts";
const MAX_SEGMENTS = 2_000;
const MAX_TEXT = 1_000;

const statements = [
  `CREATE TABLE IF NOT EXISTS cinema_session_privacy (
    session_id TEXT PRIMARY KEY,
    transcript_enabled INTEGER NOT NULL DEFAULT 0,
    ai_study_enabled INTEGER NOT NULL DEFAULT 0,
    caption_language TEXT NOT NULL DEFAULT 'en-GH',
    retention_hours INTEGER NOT NULL DEFAULT 24,
    updated_by TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS cinema_transcript_segments (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    speaker_id TEXT NOT NULL DEFAULT '',
    speaker_name TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL,
    at_seconds INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'CALL',
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL DEFAULT ''
  )`,
  "CREATE INDEX IF NOT EXISTS idx_cinema_transcript_session ON cinema_transcript_segments(session_id,at_seconds,created_at)",
];

let ready: Promise<void> | null = null;
export function ensureCinemaTranscriptTables() {
  ready ??= runSchemaPass({ metaTable: "campus_schema_meta", id: "cinemaTranscripts", version: TRANSCRIPT_SCHEMA_VERSION, statements }).catch((error) => {
    ready = null;
    throw error;
  });
  return ready;
}

export type CinemaTranscriptPrivacy = {
  transcriptEnabled: boolean;
  aiStudyEnabled: boolean;
  captionLanguage: string;
  retentionHours: number;
};

export type CinemaTranscriptSegment = {
  id: string;
  speakerId: string;
  speakerName: string;
  text: string;
  atSeconds: number;
  source: "CALL" | "UPLOAD";
  createdAt: string;
};

async function memberRoom(id: string, studentId: string) {
  const room = await readRoom({ id, studentId });
  if (!room.isMember) throw new CampusEngineError("FORBIDDEN", "Join this room to use its transcript.", 403);
  return room;
}

export async function readCinemaTranscriptPrivacy(id: string, studentId: string): Promise<CinemaTranscriptPrivacy> {
  await ensureCinemaTranscriptTables();
  await memberRoom(id, studentId);
  const row = rowsToObjects(await turso("SELECT transcript_enabled,ai_study_enabled,caption_language,retention_hours FROM cinema_session_privacy WHERE session_id=? LIMIT 1", [id]))[0];
  return {
    transcriptEnabled: Number(row?.transcript_enabled || 0) === 1,
    aiStudyEnabled: Number(row?.ai_study_enabled || 0) === 1,
    captionLanguage: String(row?.caption_language || "en-GH"),
    retentionHours: Math.min(168, Math.max(1, Number(row?.retention_hours || 24))),
  };
}

export async function updateCinemaTranscriptPrivacy(input: { id: string; studentId: string; transcriptEnabled: unknown; aiStudyEnabled: unknown; captionLanguage?: unknown; retentionHours?: unknown }) {
  await ensureCinemaTranscriptTables();
  const room = await memberRoom(input.id, input.studentId);
  if (!room.isHost) throw new CampusEngineError("FORBIDDEN", "Only the host can change transcript and AI privacy.", 403);
  const language = String(input.captionLanguage || "en-GH").trim().slice(0, 16) || "en-GH";
  const retention = Math.min(168, Math.max(1, Math.floor(Number(input.retentionHours) || 24)));
  const stamp = new Date().toISOString();
  await turso(
    `INSERT INTO cinema_session_privacy (session_id,transcript_enabled,ai_study_enabled,caption_language,retention_hours,updated_by,updated_at)
     VALUES (?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET transcript_enabled=excluded.transcript_enabled,ai_study_enabled=excluded.ai_study_enabled,caption_language=excluded.caption_language,retention_hours=excluded.retention_hours,updated_by=excluded.updated_by,updated_at=excluded.updated_at`,
    [input.id, input.transcriptEnabled === true ? 1 : 0, input.aiStudyEnabled === true ? 1 : 0, language, retention, input.studentId, stamp],
  );
  return readCinemaTranscriptPrivacy(input.id, input.studentId);
}

function segmentView(row: Record<string, unknown>): CinemaTranscriptSegment {
  return {
    id: String(row.id || ""), speakerId: String(row.speaker_id || ""), speakerName: String(row.speaker_name || "") || "Speaker",
    text: String(row.text || ""), atSeconds: Math.max(0, Number(row.at_seconds || 0)),
    source: String(row.source || "CALL") === "UPLOAD" ? "UPLOAD" : "CALL", createdAt: String(row.created_at || ""),
  };
}

export async function listCinemaTranscript(input: { id: string; studentId: string; query?: string }): Promise<CinemaTranscriptSegment[]> {
  await ensureCinemaTranscriptTables();
  await memberRoom(input.id, input.studentId);
  const query = String(input.query || "").trim().slice(0, 100);
  const rows = query
    ? await turso("SELECT id,speaker_id,speaker_name,text,at_seconds,source,created_at FROM cinema_transcript_segments WHERE session_id=? AND text LIKE ? ORDER BY at_seconds,created_at LIMIT 300", [input.id, `%${query.replace(/[%_]/g, "")}%`])
    : await turso("SELECT id,speaker_id,speaker_name,text,at_seconds,source,created_at FROM cinema_transcript_segments WHERE session_id=? ORDER BY at_seconds,created_at LIMIT 500", [input.id]);
  return rowsToObjects(rows).map(segmentView);
}

/** A small playback window for the always-on caption overlay. */
export async function listCinemaCaptionWindow(input: { id: string; studentId: string; atSeconds: unknown }): Promise<CinemaTranscriptSegment[]> {
  await ensureCinemaTranscriptTables();
  await memberRoom(input.id, input.studentId);
  const at = Number.isFinite(Number(input.atSeconds)) ? Math.min(604_800, Math.max(0, Math.floor(Number(input.atSeconds)))) : 0;
  const recent = new Date(Date.now() - 15_000).toISOString();
  return rowsToObjects(await turso(
    `SELECT id,speaker_id,speaker_name,text,at_seconds,source,created_at FROM cinema_transcript_segments
     WHERE session_id=? AND ((source='CALL' AND created_at>=?) OR (source='UPLOAD' AND at_seconds BETWEEN ? AND ?))
     ORDER BY at_seconds,created_at LIMIT 50`,
    [input.id, recent, Math.max(0, at - 15), at + 15],
  )).map(segmentView);
}

export async function addCinemaTranscriptSegment(input: { id: string; studentId: string; speakerName: string; text: unknown; atSeconds: unknown; source?: unknown }) {
  await ensureCinemaTranscriptTables();
  const room = await memberRoom(input.id, input.studentId);
  const privacy = await readCinemaTranscriptPrivacy(input.id, input.studentId);
  if (!privacy.transcriptEnabled) throw new CampusEngineError("INVALID_STATE", "The host has not enabled transcripts for this session.", 409);
  const text = String(input.text || "").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
  if (!text) throw new CampusEngineError("VALIDATION_ERROR", "A caption needs spoken text.", 400);
  const source = String(input.source || "CALL").toUpperCase() === "UPLOAD" ? "UPLOAD" : "CALL";
  if (source === "UPLOAD" && !room.isHost) throw new CampusEngineError("FORBIDDEN", "Only the host can import video captions.", 403);
  if (source === "CALL" && !isRoomActive(room.status)) throw new CampusEngineError("INVALID_STATE", "Live captions stop when the session ends.", 409);
  const stamp = new Date();
  const expires = new Date(stamp.getTime() + privacy.retentionHours * 3_600_000).toISOString();
  const id = crypto.randomUUID();
  const atSeconds = Number.isFinite(Number(input.atSeconds)) ? Math.min(604_800, Math.max(0, Math.floor(Number(input.atSeconds)))) : 0;
  const inserted = await turso(
    `INSERT INTO cinema_transcript_segments (id,session_id,speaker_id,speaker_name,text,at_seconds,source,created_at,expires_at)
     SELECT ?,?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM cinema_transcript_segments WHERE session_id=?) < ?`,
    [id, input.id, input.studentId, String(input.speakerName || "Speaker").slice(0, 80), text, atSeconds, source, stamp.toISOString(), expires, input.id, MAX_SEGMENTS],
  );
  if (Number(inserted.affected_row_count || 0) !== 1) throw new CampusEngineError("CONFLICT", "This transcript has reached its 2,000-line limit.", 409);
  return { id, speakerId: input.studentId, speakerName: input.speakerName, text, atSeconds, source, createdAt: stamp.toISOString() } as CinemaTranscriptSegment;
}

export async function importCinemaVtt(input: { id: string; studentId: string; speakerName: string; content: unknown }) {
  await ensureCinemaTranscriptTables();
  const room = await memberRoom(input.id, input.studentId);
  if (!room.isHost) throw new CampusEngineError("FORBIDDEN", "Only the host can import video captions.", 403);
  const privacy = await readCinemaTranscriptPrivacy(input.id, input.studentId);
  if (!privacy.transcriptEnabled) throw new CampusEngineError("INVALID_STATE", "Enable transcripts before importing captions.", 409);
  const content = String(input.content || "").slice(0, 250_000);
  const blocks = content.replace(/\r/g, "").split(/\n\n+/);
  const captions: Array<{ text: string; atSeconds: number }> = [];
  for (const block of blocks.slice(0, 500)) {
    const lines = block.split("\n").filter(Boolean);
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;
    const match = lines[timingIndex].match(/(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)\s*-->/);
    if (!match) continue;
    const seconds = Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
    const text = lines.slice(timingIndex + 1).join(" ").replace(/<[^>]+>/g, " ").trim();
    if (!text) continue;
    captions.push({ text: text.slice(0, MAX_TEXT), atSeconds: Math.max(0, Math.floor(seconds)) });
  }
  if (!captions.length) throw new CampusEngineError("VALIDATION_ERROR", "No valid WebVTT captions were found.", 400);
  const stamp = new Date();
  const expires = new Date(stamp.getTime() + privacy.retentionHours * 3_600_000).toISOString();
  let imported = 0;
  for (let index = 0; index < captions.length; index += 80) {
    const results = await tursoTransaction(captions.slice(index, index + 80).map((caption) => ({
      sql: `INSERT INTO cinema_transcript_segments (id,session_id,speaker_id,speaker_name,text,at_seconds,source,created_at,expires_at)
        SELECT ?,?,?,?,?,?,'UPLOAD',?,? WHERE (SELECT COUNT(*) FROM cinema_transcript_segments WHERE session_id=?) < ?`,
      args: [crypto.randomUUID(), input.id, input.studentId, String(input.speakerName || "Host").slice(0, 80), caption.text, caption.atSeconds, stamp.toISOString(), expires, input.id, MAX_SEGMENTS],
    })));
    imported += results.reduce((sum, result) => sum + Number(result.affected_row_count || 0), 0);
  }
  return { imported };
}

export async function clearCinemaTranscript(id: string, studentId: string) {
  await ensureCinemaTranscriptTables();
  const room = await memberRoom(id, studentId);
  if (!room.isHost) throw new CampusEngineError("FORBIDDEN", "Only the host can clear the transcript.", 403);
  await turso("DELETE FROM cinema_transcript_segments WHERE session_id=?", [id]);
  return { cleared: true };
}
