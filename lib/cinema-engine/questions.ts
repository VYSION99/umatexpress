import { CampusEngineError } from "@/lib/campus-engine/errors";
import { readRoom } from "@/lib/cinema-engine/rooms";
import { rowsToObjects, runSchemaPass, turso } from "@/lib/turso";

export type CinemaDiscussionQuestion = {
  id: string; studentId: string; displayName: string; text: string;
  status: "PENDING" | "APPROVED" | "ANSWERED" | "DISMISSED"; createdAt: string;
};

let ready: Promise<void> | null = null;
function ensureQuestionsTable() {
  ready ??= runSchemaPass({ metaTable: "campus_schema_meta", id: "cinemaDiscussionQuestions", version: "040_cinema_discussion_questions", statements: [
    `CREATE TABLE IF NOT EXISTS cinema_discussion_questions (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, student_id TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '', question TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`,
    "CREATE INDEX IF NOT EXISTS idx_cinema_discussion_questions_queue ON cinema_discussion_questions(session_id,status,created_at)",
  ] }).catch((error) => { ready = null; throw error; });
  return ready;
}

function view(row: Record<string, unknown>): CinemaDiscussionQuestion {
  return { id: String(row.id || ""), studentId: String(row.student_id || ""), displayName: String(row.display_name || "Audience member"), text: String(row.question || ""), status: String(row.status || "PENDING") as CinemaDiscussionQuestion["status"], createdAt: String(row.created_at || "") };
}

async function requireDiscussion(id: string, studentId: string) {
  const room = await readRoom({ id, studentId });
  if (!room.discussionMode) throw new CampusEngineError("INVALID_STATE", "This room is not a discussion.", 409);
  if (!room.isMember) throw new CampusEngineError("FORBIDDEN", "Join the discussion to participate.", 403);
  return room;
}

export async function listDiscussionQuestions(id: string, studentId: string) {
  const room = await requireDiscussion(id, studentId);
  await ensureQuestionsTable();
  const moderator = ["HOST", "COHOST"].includes(room.currentRole);
  const rows = rowsToObjects(await turso(`SELECT id,student_id,display_name,question,status,created_at FROM cinema_discussion_questions
    WHERE session_id=? AND (status IN ('APPROVED','ANSWERED') OR student_id=? OR ?=1)
    ORDER BY CASE status WHEN 'APPROVED' THEN 0 WHEN 'PENDING' THEN 1 WHEN 'ANSWERED' THEN 2 ELSE 3 END,created_at ASC LIMIT 100`, [id, studentId, moderator ? 1 : 0]));
  return rows.map(view);
}

export async function submitDiscussionQuestion(input: { id: string; studentId: string; displayName: string; text: unknown }) {
  const room = await requireDiscussion(input.id, input.studentId);
  if (room.status === "ENDED" || room.status === "EXPIRED") throw new CampusEngineError("INVALID_STATE", "This discussion has ended.", 409);
  const question = String(input.text || "").replace(/\s+/g, " ").trim();
  if (question.length < 5 || question.length > 400) throw new CampusEngineError("VALIDATION_ERROR", "Write a question between 5 and 400 characters.", 400);
  await ensureQuestionsTable();
  const pending = rowsToObjects(await turso("SELECT COUNT(*) AS count FROM cinema_discussion_questions WHERE session_id=? AND student_id=? AND status='PENDING'", [input.id, input.studentId]))[0];
  if (Number(pending?.count || 0) >= 2) throw new CampusEngineError("CONFLICT", "You already have two questions waiting for review.", 409);
  const id = crypto.randomUUID(); const stamp = new Date().toISOString();
  await turso("INSERT INTO cinema_discussion_questions(id,session_id,student_id,display_name,question,status,created_at,updated_at) VALUES(?,?,?,?,?,'PENDING',?,?)", [id, input.id, input.studentId, input.displayName.slice(0, 80), question, stamp, stamp]);
  return { id, studentId: input.studentId, displayName: input.displayName.slice(0, 80), text: question, status: "PENDING" as const, createdAt: stamp };
}

export async function moderateDiscussionQuestion(input: { id: string; studentId: string; questionId: unknown; status: unknown }) {
  const room = await requireDiscussion(input.id, input.studentId);
  if (!["HOST", "COHOST"].includes(room.currentRole)) throw new CampusEngineError("FORBIDDEN", "Only a host or co-host can moderate questions.", 403);
  const status = String(input.status || "").toUpperCase();
  if (!["APPROVED", "ANSWERED", "DISMISSED"].includes(status)) throw new CampusEngineError("VALIDATION_ERROR", "Choose a valid question decision.", 400);
  await ensureQuestionsTable();
  const result = await turso("UPDATE cinema_discussion_questions SET status=?,updated_at=? WHERE id=? AND session_id=? AND status<>'DISMISSED'", [status, new Date().toISOString(), String(input.questionId || ""), input.id]);
  if (Number(result.affected_row_count || 0) !== 1) throw new CampusEngineError("NOT_FOUND", "That question is no longer in the queue.", 404);
  return { updated: true };
}
