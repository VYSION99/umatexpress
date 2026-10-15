import { CampusEngineError } from "@/lib/campus-engine/errors";
import { callCloudflareAi, cloudflareAiModelName } from "@/lib/cloudflare-ai";
import { listCinemaBookmarks, readRoom } from "@/lib/cinema-engine/rooms";
import { listCinemaTranscript, readCinemaTranscriptPrivacy } from "@/lib/cinema-engine/transcripts";
import { rowsToObjects, runSchemaPass, turso } from "@/lib/turso";

const statements = [
  `CREATE TABLE IF NOT EXISTS cinema_study_packs (
    id TEXT PRIMARY KEY,session_id TEXT NOT NULL,summary TEXT NOT NULL DEFAULT '',chapters TEXT NOT NULL DEFAULT '[]',notes TEXT NOT NULL DEFAULT '[]',flashcards TEXT NOT NULL DEFAULT '[]',questions TEXT NOT NULL DEFAULT '[]',model TEXT NOT NULL DEFAULT '',created_by TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_cinema_study_session ON cinema_study_packs(session_id)",
];
let ready: Promise<void> | null = null;
export function ensureCinemaStudyTables() { ready ??= runSchemaPass({ metaTable: "campus_schema_meta", id: "cinemaStudyPacks", version: "039_cinema_study_packs", statements }).catch((e) => { ready = null; throw e; }); return ready; }

export type CinemaStudyPack = {
  id: string; summary: string;
  chapters: Array<{ title: string; atSeconds: number; summary: string }>;
  notes: string[]; flashcards: Array<{ front: string; back: string }>;
  questions: Array<{ question: string; answer: string }>;
  createdAt: string; updatedAt: string;
};

function safeArray<T>(value: unknown, map: (item: Record<string, unknown>) => T | null): T[] {
  try { const raw = typeof value === "string" ? JSON.parse(value) : value; return Array.isArray(raw) ? raw.map((v) => map(v && typeof v === "object" ? v as Record<string, unknown> : {})).filter((v): v is T => v !== null).slice(0, 20) : []; } catch { return []; }
}
function view(row: Record<string, unknown>): CinemaStudyPack {
  return {
    id: String(row.id || ""), summary: String(row.summary || ""),
    chapters: safeArray(row.chapters, (v) => v.title ? { title: String(v.title).slice(0, 120), atSeconds: Math.max(0, Number(v.atSeconds || 0)), summary: String(v.summary || "").slice(0, 400) } : null),
    notes: safeArray(row.notes, (v) => v.text ? String(v.text).slice(0, 500) : null),
    flashcards: safeArray(row.flashcards, (v) => v.front && v.back ? { front: String(v.front).slice(0, 300), back: String(v.back).slice(0, 500) } : null),
    questions: safeArray(row.questions, (v) => v.question && v.answer ? { question: String(v.question).slice(0, 400), answer: String(v.answer).slice(0, 600) } : null),
    createdAt: String(row.created_at || ""), updatedAt: String(row.updated_at || ""),
  };
}

async function member(id: string, studentId: string) { const room = await readRoom({ id, studentId }); if (!room.isMember) throw new CampusEngineError("FORBIDDEN", "Join this room to use its study pack.", 403); return room; }

export async function readCinemaStudyPack(id: string, studentId: string): Promise<CinemaStudyPack | null> {
  await ensureCinemaStudyTables(); await member(id, studentId);
  const row = rowsToObjects(await turso("SELECT * FROM cinema_study_packs WHERE session_id=? LIMIT 1", [id]))[0];
  return row ? view(row) : null;
}

function jsonObject(text: string): Record<string, unknown> {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced || text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  try { const parsed = JSON.parse(candidate); return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {}; } catch { throw new CampusEngineError("ENGINE_ERROR", "The study assistant returned an incomplete pack. Please try again.", 502); }
}

export async function generateCinemaStudyPack(input: { id: string; studentId: string }) {
  await ensureCinemaStudyTables(); const room = await member(input.id, input.studentId);
  if (!["HOST", "COHOST"].includes(room.currentRole)) throw new CampusEngineError("FORBIDDEN", "Only the host or a co-host can generate the shared study pack.", 403);
  const privacy = await readCinemaTranscriptPrivacy(input.id, input.studentId);
  if (!privacy.aiStudyEnabled) throw new CampusEngineError("INVALID_STATE", "The host has not enabled AI study tools for this session.", 409);
  const transcript = await listCinemaTranscript({ id: input.id, studentId: input.studentId });
  const bookmarks = await listCinemaBookmarks({ id: input.id, studentId: input.studentId });
  if (!transcript.length && !bookmarks.length) throw new CampusEngineError("INVALID_STATE", "Add captions, a transcript, or shared moments before generating a study pack.", 409);
  const context = [
    `Session: ${room.title}`,
    ...bookmarks.slice(0, 50).map((b) => `[${b.atSeconds}s] BOOKMARK: ${b.label}`),
    ...transcript.slice(-500).map((s) => `[${s.atSeconds}s] ${s.speakerName}: ${s.text}`),
  ].join("\n").slice(0, 60_000);
  const response = await callCloudflareAi(
    "You turn university study-session transcripts into accurate revision material. Return JSON only. Never invent facts absent from the source. Use timestamps from the source. Shape: {summary:string,chapters:[{title,atSeconds,summary}],notes:[{text}],flashcards:[{front,back}],questions:[{question,answer}]}. Produce 3-10 chapters, 5-15 notes, 5-12 flashcards, and 5-10 revision questions when the source supports them.",
    context,
  );
  const parsed = jsonObject(response);
  const pack = view({ id: crypto.randomUUID(), summary: String(parsed.summary || "").slice(0, 2_000), chapters: parsed.chapters, notes: parsed.notes, flashcards: parsed.flashcards, questions: parsed.questions, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  if (!pack.summary) throw new CampusEngineError("ENGINE_ERROR", "The study assistant returned an empty pack. Please try again.", 502);
  const stamp = new Date().toISOString(); const model = await cloudflareAiModelName();
  await turso(`INSERT INTO cinema_study_packs (id,session_id,summary,chapters,notes,flashcards,questions,model,created_by,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET summary=excluded.summary,chapters=excluded.chapters,notes=excluded.notes,flashcards=excluded.flashcards,questions=excluded.questions,model=excluded.model,created_by=excluded.created_by,updated_at=excluded.updated_at`,
    [pack.id, input.id, pack.summary, JSON.stringify(pack.chapters), JSON.stringify(pack.notes.map((text) => ({ text }))), JSON.stringify(pack.flashcards), JSON.stringify(pack.questions), model, input.studentId, stamp, stamp]);
  return readCinemaStudyPack(input.id, input.studentId);
}

/** Builds at most one consented ended-room pack per cron pass. */
export async function generatePendingCinemaStudyPack() {
  await ensureCinemaStudyTables();
  const row = rowsToObjects(await turso(
    `SELECT s.id,s.host_student_id FROM cinema_sessions s
     JOIN cinema_session_privacy p ON p.session_id=s.id AND p.ai_study_enabled=1
     LEFT JOIN cinema_study_packs pack ON pack.session_id=s.id
     WHERE s.status='ENDED' AND pack.session_id IS NULL
       AND (EXISTS (SELECT 1 FROM cinema_transcript_segments t WHERE t.session_id=s.id)
         OR EXISTS (SELECT 1 FROM cinema_bookmarks b WHERE b.session_id=s.id))
     ORDER BY s.ended_at ASC LIMIT 1`,
  ))[0];
  if (!row) return { generated: 0 };
  try {
    const pack = await generateCinemaStudyPack({ id: String(row.id), studentId: String(row.host_student_id) });
    return { generated: pack ? 1 : 0 };
  } catch {
    // A model or configuration failure is retried by a later cron without
    // stopping room retention, reminders, or any other cleanup work.
    return { generated: 0 };
  }
}
