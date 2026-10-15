import { CampusEngineError } from "@/lib/campus-engine/errors";
import { isRoomActive, readRoom } from "@/lib/cinema-engine/rooms";
import { rowsToObjects, runSchemaPass, turso } from "@/lib/turso";

const statements = [
  `CREATE TABLE IF NOT EXISTS cinema_polls (id TEXT PRIMARY KEY,session_id TEXT NOT NULL,question TEXT NOT NULL,options TEXT NOT NULL,kind TEXT NOT NULL DEFAULT 'POLL',correct_index INTEGER NOT NULL DEFAULT -1,status TEXT NOT NULL DEFAULT 'OPEN',created_by TEXT NOT NULL,created_at TEXT NOT NULL,closed_at TEXT NOT NULL DEFAULT '')`,
  `CREATE TABLE IF NOT EXISTS cinema_poll_votes (poll_id TEXT NOT NULL,student_id TEXT NOT NULL,option_index INTEGER NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(poll_id,student_id))`,
  "CREATE INDEX IF NOT EXISTS idx_cinema_polls_session ON cinema_polls(session_id,created_at DESC)",
];
let ready: Promise<void> | null = null;
export function ensureCinemaPollTables() { ready ??= runSchemaPass({ metaTable: "campus_schema_meta", id: "cinemaPolls", version: "038_cinema_polls", statements }).catch((e) => { ready = null; throw e; }); return ready; }

async function member(id: string, studentId: string) { const room = await readRoom({ id, studentId }); if (!room.isMember) throw new CampusEngineError("FORBIDDEN", "Join this room to use polls.", 403); return room; }

export type CinemaPoll = { id: string; question: string; options: string[]; kind: "POLL" | "QUIZ"; correctIndex: number; status: "OPEN" | "CLOSED"; votes: number[]; myVote: number; createdAt: string };

export async function listCinemaPolls(id: string, studentId: string): Promise<CinemaPoll[]> {
  await ensureCinemaPollTables(); await member(id, studentId);
  const rows = rowsToObjects(await turso(`SELECT p.id,p.question,p.options,p.kind,p.correct_index,p.status,p.created_at,
    COALESCE((SELECT option_index FROM cinema_poll_votes v WHERE v.poll_id=p.id AND v.student_id=?),-1) AS my_vote
    FROM cinema_polls p WHERE p.session_id=? ORDER BY p.created_at DESC LIMIT 30`, [studentId, id]));
  const counts = rowsToObjects(await turso(`SELECT v.poll_id,v.option_index,COUNT(*) AS count FROM cinema_poll_votes v
    JOIN cinema_polls p ON p.id=v.poll_id WHERE p.session_id=? GROUP BY v.poll_id,v.option_index`, [id]));
  const countsByPoll = new Map<string, Array<Record<string, unknown>>>();
  for (const count of counts) countsByPoll.set(String(count.poll_id), [...(countsByPoll.get(String(count.poll_id)) || []), count]);
  const result: CinemaPoll[] = [];
  for (const row of rows) {
    const options = JSON.parse(String(row.options || "[]")) as string[];
    const votes = options.map(() => 0);
    for (const count of countsByPoll.get(String(row.id)) || []) if (votes[Number(count.option_index)] !== undefined) votes[Number(count.option_index)] = Number(count.count || 0);
    result.push({ id: String(row.id), question: String(row.question), options, kind: row.kind === "QUIZ" ? "QUIZ" : "POLL", correctIndex: row.status === "CLOSED" ? Number(row.correct_index) : -1, status: row.status === "CLOSED" ? "CLOSED" : "OPEN", votes, myVote: Number(row.my_vote ?? -1), createdAt: String(row.created_at) });
  }
  return result;
}

export async function createCinemaPoll(input: { id: string; studentId: string; question: unknown; options: unknown; kind: unknown; correctIndex: unknown }) {
  await ensureCinemaPollTables(); const room = await member(input.id, input.studentId);
  if (!["HOST", "COHOST"].includes(room.currentRole)) throw new CampusEngineError("FORBIDDEN", "Only a host or co-host can create a poll.", 403);
  if (!isRoomActive(room.status)) throw new CampusEngineError("INVALID_STATE", "This session has ended, so it cannot open a new poll.", 409);
  const question = String(input.question || "").replace(/\s+/g, " ").trim().slice(0, 240);
  const options = Array.isArray(input.options) ? input.options.map((v) => String(v).trim().slice(0, 100)).filter(Boolean).slice(0, 6) : [];
  if (!question || options.length < 2) throw new CampusEngineError("VALIDATION_ERROR", "Add a question and at least two choices.", 400);
  const kind = String(input.kind).toUpperCase() === "QUIZ" ? "QUIZ" : "POLL";
  const correct = kind === "QUIZ" ? Math.floor(Number(input.correctIndex)) : -1;
  if (kind === "QUIZ" && (correct < 0 || correct >= options.length)) throw new CampusEngineError("VALIDATION_ERROR", "Choose the correct quiz answer.", 400);
  const id = crypto.randomUUID(), stamp = new Date().toISOString();
  await turso("INSERT INTO cinema_polls (id,session_id,question,options,kind,correct_index,status,created_by,created_at) VALUES (?,?,?,?,?,?, 'OPEN',?,?)", [id, input.id, question, JSON.stringify(options), kind, correct, input.studentId, stamp]);
  return { id };
}

export async function voteCinemaPoll(input: { id: string; studentId: string; pollId: unknown; optionIndex: unknown }) {
  await ensureCinemaPollTables(); const room = await member(input.id, input.studentId);
  if (!isRoomActive(room.status)) throw new CampusEngineError("INVALID_STATE", "This session has ended, so voting is closed.", 409);
  const pollId = String(input.pollId || ""); const index = Math.floor(Number(input.optionIndex));
  const poll = rowsToObjects(await turso("SELECT options,status FROM cinema_polls WHERE id=? AND session_id=? LIMIT 1", [pollId, input.id]))[0];
  const options = poll ? JSON.parse(String(poll.options || "[]")) as string[] : [];
  if (!poll || poll.status !== "OPEN" || index < 0 || index >= options.length) throw new CampusEngineError("INVALID_STATE", "That poll is closed or the choice is invalid.", 409);
  await turso("INSERT INTO cinema_poll_votes (poll_id,student_id,option_index,created_at) VALUES (?,?,?,?) ON CONFLICT(poll_id,student_id) DO UPDATE SET option_index=excluded.option_index,created_at=excluded.created_at", [pollId, input.studentId, index, new Date().toISOString()]);
  return { voted: true };
}

export async function closeCinemaPoll(input: { id: string; studentId: string; pollId: unknown }) {
  await ensureCinemaPollTables(); const room = await member(input.id, input.studentId);
  if (!["HOST", "COHOST"].includes(room.currentRole)) throw new CampusEngineError("FORBIDDEN", "Only a host or co-host can close a poll.", 403);
  await turso("UPDATE cinema_polls SET status='CLOSED',closed_at=? WHERE id=? AND session_id=?", [new Date().toISOString(), String(input.pollId || ""), input.id]);
  return { closed: true };
}
