import { CampusEngineError } from "@/lib/campus-engine/errors";
import { callCloudflareAi, cloudflareAiModelName } from "@/lib/cloudflare-ai";
import { recentCinemaMessages } from "@/lib/cinema-engine/messages";
import type { CinemaBoardPolicy } from "@/lib/cinema-engine/protocol";
import { isRoomActive, readRoom } from "@/lib/cinema-engine/rooms";
import { announceCinemaWhiteboard } from "@/lib/cinema-engine/realtime";
import {
  CINEMA_WHITEBOARD_TOPICS,
  parseWhiteboardScene,
  plainTextBoard,
  type CinemaWhiteboardScene,
  type CinemaWhiteboardTopic,
  type CinemaWhiteboardView,
} from "@/lib/cinema-engine/whiteboard-scene";
import { incrementMetric, logEvent } from "@/lib/observability";
import { platformSettingEnabled, platformSettingNumber } from "@/lib/platform-settings";
import { isTursoConfiguredRuntime, rowsToObjects, runSchemaPass, turso } from "@/lib/turso";

/**
 * The room's AI whiteboard: a session-aware teaching surface.
 *
 * The board is generated from what the room already knows — its title, where
 * the video is, the last few chat lines and the board before this one — so an
 * answer lands in the conversation that asked for it rather than in a vacuum.
 * The model returns a scene, never markup: blocks of text, maths, code,
 * diagrams with nodes and edges, or simulated walkthroughs. The scene parser is
 * the guard, and the client renders only what the parser kept.
 *
 * The one topic that needs a rule is offensive security. This is a study room
 * on a university campus, and simulated lab work is legitimate coursework; a
 * chain of instructions aimed at somebody else's live system is not. The system
 * prompt draws that line and the fallback keeps a refusal useful — the model is
 * told to answer such a request with the defensive concept, the ethics and a
 * safe lab alternative, which is what the room actually needs.
 *
 * Boards are temporary like everything else in Cinema: they expire with the
 * room's retention window, are deleted when the room is, and carry the name of
 * the person who asked so a room can tell whose question a board answers.
 *
 * Who may ask is the host's: their screen sends the switch to the live room,
 * the room tells the route, and the route refuses before a model call is spent.
 * On `AUTO` nobody asks by hand — the host's screen runs the summaries and the
 * room's own answers on a cadence — and the question for that pass is written
 * here, never by a browser.
 */

export const CINEMA_WHITEBOARD_SCHEMA_VERSION = "032_cinema_whiteboards";

export const CINEMA_WHITEBOARD_MODES = ["AUTO", "DIAGRAM", "FLOWCHART", "MATH", "CODE", "SIMULATION"] as const;
export type CinemaWhiteboardMode = (typeof CINEMA_WHITEBOARD_MODES)[number];

/** How much of the room's conversation the model sees, and how long each line may be. */
const CONTEXT_MESSAGES = 16;
const CONTEXT_MESSAGE_CHARS = 240;
const MAX_QUESTION_CHARS = 500;
const MAX_BOARD_HISTORY = 20;

/**
 * What an automatic pass asks. It is fixed here rather than sent by a browser:
 * the room's own summaries are the platform's words, and a client that could
 * write this prompt could spend a deployment's model budget on anything.
 */
const AUTO_SUMMARY_QUESTION = [
  "Look at where this session is now: the video position, the room's recent chat and the board before this one.",
  "If the chat has asked something nobody has answered, answer it.",
  "Otherwise summarise what this stretch of the session has covered, and the one thing to remember.",
  "Keep the summary to two sentences.",
].join(" ");

const CINEMA_WHITEBOARD_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS cinema_whiteboards (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    requester_id TEXT NOT NULL DEFAULT '',
    requester_name TEXT NOT NULL DEFAULT '',
    question TEXT NOT NULL DEFAULT '',
    mode TEXT NOT NULL DEFAULT 'AUTO',
    title TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    topic TEXT NOT NULL DEFAULT 'GENERAL',
    lab INTEGER NOT NULL DEFAULT 0,
    scene TEXT NOT NULL DEFAULT '{}',
    model TEXT NOT NULL DEFAULT '',
    at_seconds INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'READY',
    expires_at TEXT NOT NULL DEFAULT '',
    deleted_at TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_cinema_whiteboards_session ON cinema_whiteboards(session_id, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_cinema_whiteboards_status ON cinema_whiteboards(status, expires_at ASC)",
];

let whiteboardTablesReady: Promise<void> | null = null;

/** Memoised per isolate, like every other schema pass. */
export function ensureCinemaWhiteboardTables() {
  whiteboardTablesReady ??= runSchemaPass({
    metaTable: "campus_schema_meta",
    id: "cinemaWhiteboards",
    version: CINEMA_WHITEBOARD_SCHEMA_VERSION,
    statements: CINEMA_WHITEBOARD_STATEMENTS,
  }).catch((error: unknown) => {
    whiteboardTablesReady = null;
    throw error;
  });
  return whiteboardTablesReady;
}

const WHITEBOARD_COLUMNS = `id,session_id,requester_id,requester_name,question,COALESCE(mode,'AUTO') AS mode,
  COALESCE(title,'') AS title,COALESCE(summary,'') AS summary,COALESCE(topic,'GENERAL') AS topic,
  COALESCE(lab,0) AS lab,COALESCE(scene,'{}') AS scene,COALESCE(model,'') AS model,
  COALESCE(at_seconds,0) AS at_seconds,COALESCE(status,'READY') AS status,
  COALESCE(expires_at,'') AS expires_at,COALESCE(deleted_at,'') AS deleted_at,created_at,updated_at`;

export type CinemaWhiteboardRow = {
  id: string;
  sessionId: string;
  requesterId: string;
  requesterName: string;
  question: string;
  mode: string;
  view: CinemaWhiteboardView;
  model: string;
  status: string;
  expiresAt: string;
  deletedAt: string;
  createdAt: string;
};

/** The scene column is JSON; a row whose scene cannot be read is not served. */
function sceneOf(raw: unknown, fallbackTitle: string): CinemaWhiteboardScene | null {
  try {
    const parsed = JSON.parse(String(raw || "{}")) as CinemaWhiteboardScene;
    if (!parsed || !Array.isArray(parsed.blocks) || !parsed.blocks.length) return null;
    return {
      title: String(parsed.title || fallbackTitle || "Whiteboard"),
      summary: String(parsed.summary || ""),
      topic: (CINEMA_WHITEBOARD_TOPICS as readonly string[]).includes(String(parsed.topic))
        ? parsed.topic as CinemaWhiteboardTopic
        : "GENERAL",
      lab: parsed.lab === true,
      blocks: parsed.blocks,
      ...(parsed.unparsed ? { unparsed: true } : {}),
    };
  } catch {
    return null;
  }
}

function whiteboardView(row: Record<string, unknown>): CinemaWhiteboardRow | null {
  const id = String(row.id || "");
  const scene = sceneOf(row.scene, String(row.title || ""));
  if (!id || !scene) return null;
  return {
    id,
    sessionId: String(row.session_id || ""),
    requesterId: String(row.requester_id || ""),
    requesterName: String(row.requester_name || ""),
    question: String(row.question || ""),
    mode: String(row.mode || "AUTO"),
    model: String(row.model || ""),
    status: String(row.status || "READY"),
    expiresAt: String(row.expires_at || ""),
    deletedAt: String(row.deleted_at || ""),
    createdAt: String(row.created_at || ""),
    view: {
      ...scene,
      id,
      roomId: String(row.session_id || ""),
      requesterId: String(row.requester_id || ""),
      requesterName: String(row.requester_name || ""),
      atSeconds: Number(row.at_seconds || 0),
      createdAt: String(row.created_at || ""),
    },
  };
}

async function requireTurso() {
  if (await isTursoConfiguredRuntime()) return;
  throw new CampusEngineError("CONFIG_REQUIRED", "Cinema needs the database to be configured.", 503);
}

/** The public limits, so the panel can disable its own button before a request. */
export async function cinemaWhiteboardLimits() {
  return {
    enabled: await platformSettingEnabled("cinema_whiteboard_enabled"),
    generationsPerHour: Math.max(1, Math.floor(await platformSettingNumber("cinema_whiteboard_generations_per_hour"))),
    modes: [...CINEMA_WHITEBOARD_MODES],
    maxQuestionChars: MAX_QUESTION_CHARS,
    /** How often an automatic room asks for its next summary, in minutes. */
    autoMinutes: Math.min(60, Math.max(5, Math.floor(await platformSettingNumber("cinema_board_auto_minutes")))),
  };
}

export function whiteboardMode(value: unknown): CinemaWhiteboardMode {
  const mode = String(value || "").toUpperCase() as CinemaWhiteboardMode;
  return (CINEMA_WHITEBOARD_MODES as readonly string[]).includes(mode) ? mode : "AUTO";
}

/**
 * The system prompt. It is long on purpose: the schema has to be exact or the
 * reply is wasted, and the safety rule has to be stated once, plainly, rather
 * than hoped for.
 */
export function whiteboardSystemPrompt() {
  return [
    "You are the study-room whiteboard for UMaT students. You are given the room's context and one question.",
    "Answer with a single JSON object and nothing else. No prose before or after, no code fences.",
    "",
    "Schema:",
    '{"title":"short title","summary":"one or two sentences","topic":"GENERAL|DIAGRAM|FLOWCHART|MATH|CODE|SIMULATION|SCIENCE|HUMANITIES","blocks":[ ... ]}',
    "Block kinds:",
    '- {"kind":"text","text":"..."}',
    '- {"kind":"math","latex":"...","caption":"optional"}',
    '- {"kind":"code","language":"python","code":"...","caption":"optional"}',
    '- {"kind":"diagram","title":"optional","nodes":[{"id":"a","label":"...","shape":"box|round|diamond|cylinder|hex","tone":"default|accent|warn|good","column":0,"row":0}],"edges":[{"from":"a","to":"b","label":"optional","arrow":"forward|both|none","dashed":false}]}',
    '- {"kind":"steps","title":"optional","lab":true,"steps":[{"title":"...","detail":"...","tag":"LAB|DEFENSE|CHECK"}]}',
    '- {"kind":"callout","tone":"info|warn|lab","text":"..."}',
    '- {"kind":"chart","chart":"bar|line|scatter|pie","title":"optional","xLabel":"optional","yLabel":"optional","series":[{"name":"optional","x":[1,2,3],"y":[4,5,6]}]}',
    '- {"kind":"geo","title":"optional","caption":"optional","commands":["f(x)=x^2","Derivative(f)","A=(1,2)","Intersect(f,x=1)"]}',
    "",
    "Rules:",
    "1. Prefer a diagram or a flowchart when the question is about how something works or how a process flows; prefer maths blocks for equations; use at most 12 blocks.",
    "2. Node and edge ids are short and unique. Every edge must name nodes that exist. Put the main flow left to right with `column`.",
    "3. Maths goes in a math block as LaTeX with only these commands: \\frac, \\sqrt, Greek names, \\times, \\cdot, \\le, \\ge, \\ne, \\approx, \\to, \\infty, \\sum, \\int. No other macros, no HTML.",
    "4. Code must be short, illustrative and safe. Never include real credentials, tokens, or a chain aimed at a live third-party system.",
    "5. Security topics are allowed as education. For anything offensive — penetration testing, exploitation, malware — teach the concept, the defence and the ethics, and frame the exercise as a simulated lab on systems the student owns or is authorised to test. Set \"lab\": true on those step blocks and add a callout with tone \"lab\". Never provide instructions that target a real third party, and never provide working exploit payloads for live systems. If the question asks for that, answer with the defensive explanation and the safe lab alternative instead.",
    "6. Be concrete and correct. If the room's context is not enough, teach the general concept and say what is missing in the summary.",
    "7. Write for a student who is watching a video and cannot pause you.",
    "8. Use a chart block when the answer is data — at most four series, two hundred points each, and at most six slices when the chart is a pie. Use a geo block when the answer is a function or a construction the room should explore. A geo command must define a function (f(x)=…), a point (A=(1,2)) or a slider (a=3), or call one of Derivative, Integral, Solve, Intersect, Tangent, Segment, Midpoint, PerpendicularLine, Line, Circle, Angle, Root, Extremum, Limit, Sum, Sequence, Vector, Polygon, Function, If, Distance or Length. At most twelve commands.",
    "9. Never put JavaScript, a URL, a colour name, a semicolon or any command outside rule 8 in a geo block, and never put plotting-library options in a chart block: the parser drops anything it does not recognise, and it is right to.",
  ].join("\n");
}

export type CinemaWhiteboardContext = {
  roomTitle: string;
  sourceType: string;
  atSeconds: number;
  memberCount: number;
  mode: CinemaWhiteboardMode;
  question: string;
  chat: string[];
  previous?: { title: string; summary: string } | null;
};

/** The user prompt: everything the room knows, bounded. */
export function whiteboardUserPrompt(context: CinemaWhiteboardContext) {
  const lines = [
    `Room: ${context.roomTitle || "Study room"}`,
    `Video: ${context.sourceType || "YOUTUBE"}${context.atSeconds > 0 ? ` at ${formatClock(context.atSeconds)}` : " (no position)"}`,
    `Members present: ${context.memberCount}`,
    `Requested format: ${context.mode}`,
    "",
    "Recent room chat (oldest first):",
    ...(context.chat.length ? context.chat.map((line) => `- ${line}`) : ["- (no chat yet)"]),
  ];
  if (context.previous) {
    lines.push("", `The previous board was "${context.previous.title}": ${context.previous.summary}`.trim());
  }
  lines.push("", `Question: ${context.question}`, "", "Return the JSON object now.");
  return lines.join("\n");
}

function formatClock(seconds: number) {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

/**
 * Asks the model and stores what came back. `generate` is injectable so the
 * transport can be tested without a model; production passes nothing and gets
 * `callCloudflareAi`.
 */
export async function askCinemaWhiteboard(input: {
  roomId: string;
  student: { id: string; name?: string };
  question: unknown;
  mode?: unknown;
  atSeconds?: unknown;
  /** The room's asking rule, as the live room reports it; null when unknown. */
  policy?: CinemaBoardPolicy | null;
  /** True for the automatic pass a host's screen runs; the question is fixed. */
  auto?: boolean;
  generate?: (system: string, user: string) => Promise<string>;
  now?: number;
}): Promise<CinemaWhiteboardRow> {
  await requireTurso();
  await ensureCinemaWhiteboardTables();
  if (!await platformSettingEnabled("cinema_whiteboard_enabled")) {
    throw new CampusEngineError("INVALID_STATE", "The AI whiteboard is switched off on this deployment.", 409);
  }
  const asked = String(input.question ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_QUESTION_CHARS);
  // An automatic pass carries the fixed instruction, not whatever a browser
  // sent: `auto` is the route's word, and the route only passes it for a host.
  const question = input.auto ? AUTO_SUMMARY_QUESTION : asked;
  if (!question) throw new CampusEngineError("VALIDATION_ERROR", "Ask the whiteboard a question first.", 400);
  const mode = whiteboardMode(input.mode);
  const atSeconds = Math.max(0, Math.floor(Number(input.atSeconds) || 0));

  const room = await readRoom({ id: input.roomId, studentId: input.student.id });
  if (!isRoomActive(room.status)) throw new CampusEngineError("INVALID_STATE", "This room has ended.", 409);
  if (!room.isMember) {
    throw new CampusEngineError("FORBIDDEN", room.joinLocked ? "The host has locked this room." : "Join the room before asking the whiteboard.", 403);
  }
  // Who may ask is the host's switch, and the live room is the only thing that
  // knows it. An unknown policy means the room could not be reached, and the
  // rule it has always had — everyone in the room may ask — is the honest
  // fallback rather than a refusal the room never made.
  const policy = input.policy ?? "MEMBERS";
  if (input.auto) {
    if (!room.isHost) throw new CampusEngineError("FORBIDDEN", "Only the host can ask the room to summarise itself.", 403);
    if (policy !== "AUTO") throw new CampusEngineError("INVALID_STATE", "This room's board is not on automatic.", 409);
  } else if (policy === "AUTO") {
    throw new CampusEngineError("INVALID_STATE", "This room's board answers on its own; the host has it on automatic.", 409);
  } else if (policy === "HOST" && !room.isHost) {
    throw new CampusEngineError("FORBIDDEN", "The host keeps the questions in this room.", 403);
  }

  const chat = (await recentCinemaMessages(room.id, CONTEXT_MESSAGES))
    .map((message) => `${message.senderName || "Member"}: ${message.content.replace(/\s+/g, " ").slice(0, CONTEXT_MESSAGE_CHARS)}`);
  const previous = await latestCinemaWhiteboard(room.id);
  const generate = input.generate ?? ((system: string, user: string) => callCloudflareAi(system, user));
  const system = whiteboardSystemPrompt();
  const user = whiteboardUserPrompt({
    roomTitle: room.title,
    sourceType: room.sourceType,
    atSeconds: atSeconds || 0,
    memberCount: room.participants.length,
    mode,
    question,
    chat,
    previous: previous ? { title: previous.view.title, summary: previous.view.summary } : null,
  });

  let reply = "";
  let scene: CinemaWhiteboardScene | null = null;
  try {
    reply = await generate(system, user);
    scene = parseWhiteboardScene(reply);
    if (!scene) {
      // One repair attempt, because a model that ignored the schema usually
      // obeys a shorter instruction; after that the prose is still an answer.
      const repaired = await generate(system, `${user}\n\nYour previous reply could not be read as the JSON object. Reply with only that JSON object, and keep it small: at most four blocks and at most six nodes.`);
      scene = parseWhiteboardScene(repaired);
    }
  } catch (error) {
    logEvent("warn", "cinema_whiteboard_generation_failed", {
      roomId: room.id,
      reason: error instanceof Error ? error.message : "unknown",
    });
    throw new CampusEngineError("ENGINE_ERROR", "The whiteboard model is unavailable right now. Try again shortly.", 502);
  }
  const resolved = scene ?? plainTextBoard(reply, question);
  const model = await cloudflareAiModelName();

  const now = input.now ?? Date.now();
  const retentionHours = Math.max(1, Math.floor(await platformSettingNumber("cinema_retention_hours")));
  const stamp = new Date(now).toISOString();
  const id = crypto.randomUUID();
  await turso(
    `INSERT INTO cinema_whiteboards (id,session_id,requester_id,requester_name,question,mode,title,summary,topic,lab,scene,model,at_seconds,status,expires_at,deleted_at,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'READY',?,'',?,?)`,
    [id, room.id, String(input.student.id), String(input.student.name || "").slice(0, 80), question, mode,
      resolved.title, resolved.summary, resolved.topic, resolved.lab ? 1 : 0, JSON.stringify(resolved), model, atSeconds,
      new Date(now + retentionHours * 3_600_000).toISOString(), stamp, stamp],
  );
  logEvent("info", "cinema_whiteboard_ready", {
    roomId: room.id, boardId: id, topic: resolved.topic, blocks: resolved.blocks.length, parsed: !resolved.unparsed,
  });
  await incrementMetric("cinema_whiteboards_created");
  const row = await readCinemaWhiteboardRow(id);
  if (!row) throw new CampusEngineError("ENGINE_ERROR", "The board was stored but could not be read back.", 500);
  await announceCinemaWhiteboard(room.id, row.view);
  return row;
}

async function readCinemaWhiteboardRow(id: string) {
  const row = rowsToObjects(await turso(
    `SELECT ${WHITEBOARD_COLUMNS} FROM cinema_whiteboards WHERE id = ? AND status <> 'DELETED' LIMIT 1`,
    [String(id)],
  ))[0];
  return row ? whiteboardView(row) : null;
}

/** One board, for any member of its room. */
export async function cinemaWhiteboardById(input: { boardId: string; roomId: string }) {
  await requireTurso();
  await ensureCinemaWhiteboardTables();
  const row = rowsToObjects(await turso(
    `SELECT ${WHITEBOARD_COLUMNS} FROM cinema_whiteboards WHERE id = ? AND session_id = ? AND status <> 'DELETED' LIMIT 1`,
    [String(input.boardId), String(input.roomId)],
  ))[0];
  if (!row) throw new CampusEngineError("NOT_FOUND", "That board does not exist.", 404);
  const view = whiteboardView(row);
  if (!view) throw new CampusEngineError("NOT_FOUND", "That board has no readable scene.", 404);
  return view;
}

/** A room's boards, newest first. */
export async function listCinemaWhiteboards(input: { roomId: string; limit?: number }): Promise<CinemaWhiteboardRow[]> {
  await requireTurso();
  await ensureCinemaWhiteboardTables();
  const limit = Math.min(Math.max(Math.floor(Number(input.limit) || MAX_BOARD_HISTORY), 1), 50);
  const rows = rowsToObjects(await turso(
    `SELECT ${WHITEBOARD_COLUMNS} FROM cinema_whiteboards
      WHERE session_id = ? AND status <> 'DELETED'
      ORDER BY created_at DESC, rowid DESC LIMIT ${limit}`,
    [String(input.roomId)],
  ));
  return rows.reduce<CinemaWhiteboardRow[]>((boards, row) => {
    const view = whiteboardView(row);
    if (view) boards.push(view);
    return boards;
  }, []);
}

/** The board a newcomer sees, and the context the next question builds on. */
export async function latestCinemaWhiteboard(roomId: string): Promise<CinemaWhiteboardRow | null> {
  const boards = await listCinemaWhiteboards({ roomId, limit: 1 });
  return boards[0] ?? null;
}

/**
 * The host clears a board, or the person who asked takes theirs back. The row
 * is marked deleted rather than removed, so the room's socket can be told
 * exactly which board left the screen.
 */
export async function deleteCinemaWhiteboard(input: {
  boardId: string;
  roomId: string;
  actor: { id: string; isHost: boolean };
  now?: number;
}): Promise<{ deleted: boolean; id: string }> {
  await requireTurso();
  await ensureCinemaWhiteboardTables();
  const row = rowsToObjects(await turso(
    `SELECT ${WHITEBOARD_COLUMNS} FROM cinema_whiteboards WHERE id = ? AND session_id = ? AND status <> 'DELETED' LIMIT 1`,
    [String(input.boardId), String(input.roomId)],
  ))[0];
  if (!row) throw new CampusEngineError("NOT_FOUND", "That board does not exist.", 404);
  const requesterId = String(row.requester_id || "");
  if (requesterId !== String(input.actor.id) && !input.actor.isHost) {
    throw new CampusEngineError("FORBIDDEN", "Only the host or the person who asked can clear this board.", 403);
  }
  const stamp = new Date(input.now ?? Date.now()).toISOString();
  await turso(
    "UPDATE cinema_whiteboards SET status = 'DELETED', deleted_at = ?, updated_at = ? WHERE id = ? AND status <> 'DELETED'",
    [stamp, stamp, String(input.boardId)],
  );
  logEvent("info", "cinema_whiteboard_deleted", { roomId: String(input.roomId), boardId: String(input.boardId) });
  await incrementMetric("cinema_whiteboards_deleted");
  return { deleted: true, id: String(input.boardId) };
}

/**
 * Retention for boards whose room still exists. A board is kept for the same
 * window as the room's chat; the cleanup job deletes the row and a failure is
 * retried on the next tick.
 */
export async function purgeExpiredCinemaWhiteboards(options: { limit?: number; now?: number } = {}) {
  await requireTurso();
  await ensureCinemaWhiteboardTables();
  const limit = Math.min(Math.max(Math.floor(Number(options.limit) || 20), 1), 100);
  const now = options.now ?? Date.now();
  const rows = rowsToObjects(await turso(
    `SELECT id FROM cinema_whiteboards WHERE status <> 'DELETED' AND expires_at <> '' AND expires_at <= ?
      ORDER BY expires_at ASC LIMIT ${limit}`,
    [new Date(now).toISOString()],
  ));
  if (!rows.length) return { deleted: 0 };
  const stamp = new Date(now).toISOString();
  const ids = rows.map((row) => String(row.id || "")).filter(Boolean);
  let deleted = 0;
  for (const id of ids) {
    const result = await turso(
      "UPDATE cinema_whiteboards SET status = 'DELETED', deleted_at = ?, updated_at = ? WHERE id = ? AND status <> 'DELETED'",
      [stamp, stamp, id],
    );
    deleted += Number(result.affected_row_count || 0);
  }
  if (deleted) {
    logEvent("info", "cinema_whiteboards_expired", { deleted });
    await incrementMetric("cinema_whiteboards_deleted", deleted);
  }
  return { deleted };
}

/** The room-deletion step: every board in a room goes with it. */
export async function purgeCinemaWhiteboardsForRoom(sessionId: string, options: { now?: number } = {}) {
  await requireTurso();
  await ensureCinemaWhiteboardTables();
  const stamp = new Date(options.now ?? Date.now()).toISOString();
  const result = await turso(
    "UPDATE cinema_whiteboards SET status = 'DELETED', deleted_at = ?, updated_at = ? WHERE session_id = ? AND status <> 'DELETED'",
    [stamp, stamp, String(sessionId)],
  );
  const deleted = Number(result.affected_row_count || 0);
  if (deleted) {
    logEvent("info", "cinema_whiteboards_room_purged", { roomId: String(sessionId), deleted });
    await incrementMetric("cinema_whiteboards_deleted", deleted);
  }
  return { deleted };
}
