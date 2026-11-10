import { CampusEngineError } from "@/lib/campus-engine/errors";
import { rowsToObjects, turso, tursoTransaction } from "@/lib/turso";
import { readRoom } from "./rooms";
import { ensureCinemaMessageTables } from "./messages";
import { ensureCinemaPollTables } from "./polls";
import { readCinemaTranscriptPrivacy } from "./transcripts";
import { readCinemaAssistantSources } from "./chat-evidence";
import { changeCinemaPrivateStudy, deleteCinemaPrivateStudy, requestCinemaPrivateStudy } from "./private-study";
import { isCinemaHostKind, validateCinemaHostMessage, validateCinemaHostPoll } from "./host-assistance-plan";
import type { CinemaChatMessage, CinemaHostAssistanceKind, CinemaHostDraft } from "./protocol";

async function host(roomId: string, ownerId: string) {
  await ensureCinemaMessageTables();
  const room = await readRoom({ id: roomId, studentId: ownerId });
  if (!room.isMember || !["HOST", "COHOST"].includes(room.currentRole)) throw new CampusEngineError("FORBIDDEN", "Only a current host or co-host can use host suggestions.", 403);
  return room;
}
const SELECT = "SELECT r.*,h.kind AS host_kind,h.review_status,h.result_id FROM cinema_private_study_requests r JOIN cinema_host_assistance h ON h.request_id=r.id";
function draftView(row: Record<string, unknown>): CinemaHostDraft {
  const result = row.status === "DONE" && row.answer ? JSON.parse(String(row.answer)) as Pick<CinemaHostDraft, "proposal" | "scope"> : null;
  return { id: String(row.id), kind: String(row.host_kind) as CinemaHostAssistanceKind, brief: String(row.question), status: String(row.status) as CinemaHostDraft["status"], attempts: Number(row.attempts), error: String(row.error || ""), reviewStatus: String(row.review_status) as CinemaHostDraft["reviewStatus"], resultId: String(row.result_id || ""), createdAt: String(row.created_at), expiresAt: String(row.expires_at), proposal: result?.proposal || null, scope: result?.scope, citations: JSON.parse(String(row.citations || "[]")), dependencies: JSON.parse(String(row.dependencies || "[]")) };
}
async function owned(input: { roomId: string; ownerId: string; id: string }) {
  const room = await host(input.roomId, input.ownerId);
  const row = rowsToObjects(await turso(`${SELECT} WHERE r.id=? AND r.session_id=? AND r.owner_id=? AND r.status<>'DELETED' AND r.expires_at>? LIMIT 1`, [input.id, input.roomId, input.ownerId, new Date().toISOString()]))[0];
  if (!row) throw new CampusEngineError("NOT_FOUND", "This host suggestion is unavailable.", 404);
  return { room, row, draft: draftView(row) };
}
export async function listCinemaHostAssistance(roomId: string, ownerId: string) {
  await host(roomId, ownerId);
  const privacy = await readCinemaTranscriptPrivacy(roomId, ownerId);
  const rows = rowsToObjects(await turso(`${SELECT} WHERE r.session_id=? AND r.owner_id=? AND r.status<>'DELETED' AND r.expires_at>? ORDER BY r.created_at DESC LIMIT 20`, [roomId, ownerId, new Date().toISOString()]));
  return { enabled: privacy.aiStudyEnabled, drafts: rows.map(draftView) };
}
export async function requestCinemaHostAssistance(input: { roomId: string; ownerId: string; requestId: string; kind: unknown; brief?: unknown; linkVideo?: boolean; video?: CinemaChatMessage["video"]; configured?: boolean }) {
  await host(input.roomId, input.ownerId);
  if (!isCinemaHostKind(input.kind)) throw new CampusEngineError("VALIDATION_ERROR", "Choose a poll, discussion prompt or moderation review.", 400);
  const brief = input.brief === undefined || input.brief === "" ? `Suggest ${input.kind === "POLL" ? "a poll" : input.kind === "PROMPT" ? "a discussion prompt" : "message patterns for host review"} based on the room's shared evidence.` : input.brief;
  const request = await requestCinemaPrivateStudy({ roomId: input.roomId, ownerId: input.ownerId, requestId: input.requestId, question: brief, hostKind: input.kind, linkVideo: input.kind === "MODERATION" ? false : input.linkVideo, expectedVideo: input.kind === "MODERATION" ? undefined : input.video, configured: input.configured });
  return (await owned({ ...input, id: request.id })).draft;
}
export async function changeCinemaHostAssistance(input: { roomId: string; ownerId: string; id: string; action: "RETRY" | "CANCEL" | "DISMISS"; configured?: boolean }) {
  const { room } = await owned(input);
  if (input.action === "DISMISS") return deleteCinemaPrivateStudy({ ...input, hostDraft: true });
  if (input.action === "RETRY" && !["CREATED", "LIVE"].includes(room.status)) throw new CampusEngineError("INVALID_STATE", "This room has ended.", 409);
  await changeCinemaPrivateStudy({ ...input, action: input.action, hostDraft: true });
  return { draft: (await owned(input)).draft };
}

/** One reviewed action per draft, committed atomically with its review record. */
export async function applyCinemaHostAssistance(input: { roomId: string; ownerId: string; displayName: string; id: string; question?: unknown; options?: unknown; text?: unknown; itemIndex?: unknown }) {
  const { room, draft } = await owned(input);
  const result = () => ({ resultId: draft.resultId, kind: draft.kind === "POLL" ? "POLL" as const : "MESSAGE" as const });
  if (draft.reviewStatus === "APPLIED") return result();
  if (!draft.proposal || draft.status !== "DONE" || draft.reviewStatus !== "REVIEW") throw new CampusEngineError("INVALID_STATE", "Choose a completed suggestion with evidence to review.", 409);
  if (!["CREATED", "LIVE"].includes(room.status)) throw new CampusEngineError("INVALID_STATE", "This room has ended.", 409);
  const privacy = await readCinemaTranscriptPrivacy(input.roomId, input.ownerId);
  if (!privacy.aiStudyEnabled) throw new CampusEngineError("FORBIDDEN", "AI study and chat has been disabled.", 403);
  let poll: { question: string; options: string[] } | undefined, message: string | undefined;
  try {
    if (draft.kind === "POLL") poll = validateCinemaHostPoll(input);
    else {
      if (draft.proposal.kind === "MODERATION" && (!Number.isInteger(input.itemIndex) || Number(input.itemIndex) < 0 || Number(input.itemIndex) >= draft.proposal.items.length)) throw new Error("Choose a reminder from this review.");
      message = validateCinemaHostMessage(input.text);
    }
  } catch (error) { throw new CampusEngineError("VALIDATION_ERROR", error instanceof Error ? error.message : "Review the suggestion fields.", 400); }
  const evidence = rowsToObjects(await turso("SELECT kind,source_id,digest FROM cinema_private_study_evidence WHERE request_id=?", [input.id]));
  if (!evidence.length) throw new CampusEngineError("CONFLICT", "The suggestion has no available evidence.", 409);
  if (evidence.some(source => source.kind === "TRANSCRIPT") && !privacy.transcriptEnabled) throw new CampusEngineError("FORBIDDEN", "Transcript access is switched off.", 403);
  const sources = await readCinemaAssistantSources(input.roomId, evidence.map((source, index) => ({ key: `E${index}`, kind: String(source.kind) as "MESSAGE" | "TRANSCRIPT", id: String(source.source_id) })));
  const current = new Map(sources.map(source => [`${source.kind}:${source.id}`, source.digest]));
  if (evidence.some(source => current.get(`${source.kind}:${source.source_id}`) !== source.digest)) throw new CampusEngineError("CONFLICT", "The room sources changed. Request a current suggestion.", 409);
  await ensureCinemaPollTables();
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(["host-publish", input.roomId, input.id, draft.createdAt])));
  const publicId = [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  const resultId = `${poll ? "hostpoll" : "hostmsg"}-${publicId}`, stamp = new Date().toISOString();
  const checks = ["r.id=? AND r.owner_id=? AND r.session_id=? AND r.status='DONE' AND r.expires_at>? AND h.review_status='REVIEW'",
    "EXISTS(SELECT 1 FROM cinema_sessions s WHERE s.id=r.session_id AND s.status IN ('CREATED','LIVE') AND (s.host_student_id=? OR EXISTS(SELECT 1 FROM cinema_participants p WHERE p.session_id=s.id AND p.student_id=? AND p.role IN ('HOST','COHOST'))))",
    "EXISTS(SELECT 1 FROM cinema_session_privacy p WHERE p.session_id=r.session_id AND p.ai_study_enabled=1)",
    ...(sources.some(source => source.kind === "TRANSCRIPT") ? ["EXISTS(SELECT 1 FROM cinema_session_privacy p WHERE p.session_id=r.session_id AND p.transcript_enabled=1)"] : []),
    ...sources.map(source => source.kind === "MESSAGE" ? "EXISTS(SELECT 1 FROM cinema_messages m WHERE m.id=? AND m.session_id=r.session_id)" : "EXISTS(SELECT 1 FROM cinema_transcript_segments t WHERE t.id=? AND t.session_id=r.session_id AND (t.expires_at='' OR t.expires_at>?))"),
  ];
  const fenceArgs: Array<string | number> = [input.id, input.ownerId, input.roomId, stamp, input.ownerId, input.ownerId];
  for (const source of sources) { fenceArgs.push(source.id); if (source.kind === "TRANSCRIPT") fenceArgs.push(stamp); }
  const from = `FROM cinema_private_study_requests r JOIN cinema_host_assistance h ON h.request_id=r.id WHERE ${checks.join(" AND ")}`;
  const artifact = poll ? { sql: `INSERT OR IGNORE INTO cinema_polls(id,session_id,question,options,kind,correct_index,status,created_by,created_at) SELECT ?,?,?,?,'POLL',-1,'OPEN',?,? ${from}`, args: [resultId, input.roomId, poll.question, JSON.stringify(poll.options), input.ownerId, stamp, ...fenceArgs] }
    : { sql: `INSERT OR IGNORE INTO cinema_messages(id,session_id,sender_id,sender_name,content,metadata,created_at) SELECT ?,?,?,?,?,?,? ${from}`, args: [resultId, input.roomId, input.ownerId, input.displayName.slice(0, 80), message!, JSON.stringify({ aiAssisted: true }), stamp, ...fenceArgs] };
  await tursoTransaction([
    artifact,
    ...(!poll ? [{ sql: "INSERT OR IGNORE INTO cinema_message_order(message_id,session_id,thread_id) SELECT id,session_id,id FROM cinema_messages WHERE id=? AND session_id=?", args: [resultId, input.roomId] }] : []),
    { sql: `UPDATE cinema_host_assistance SET review_status='APPLIED',result_id=?,reviewed_by=?,reviewed_at=? WHERE request_id=? AND review_status='REVIEW' AND EXISTS(SELECT 1 FROM ${poll ? "cinema_polls" : "cinema_messages"} WHERE id=? AND session_id=?)`, args: [resultId, input.ownerId, stamp, input.id, resultId, input.roomId] },
  ]);
  const final = (await owned(input)).draft;
  if (final.reviewStatus !== "APPLIED") throw new CampusEngineError("CONFLICT", "The room, permission or sources changed before this action was applied.", 409);
  // All retries acknowledge the same committed artifact, even with later edits.
  return { resultId: final.resultId, kind: final.kind === "POLL" ? "POLL" as const : "MESSAGE" as const };
}
