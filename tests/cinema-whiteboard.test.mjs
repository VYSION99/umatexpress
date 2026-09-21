import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

/**
 * Cinema whiteboards: the model proposes a scene, the parser decides what a
 * screen will ever draw.
 *
 * The two halves of M9 are tested together because they are one promise: the
 * scene module bounds and escapes, and the engine stores, lists, clears and
 * expires what the module accepted. The fake Turso keeps rooms, membership,
 * chat and board rows and refuses what it was not taught, so a query change
 * fails loudly rather than quietly returning an empty board.
 */

process.env.TURSO_DATABASE_URL = "https://cinema-whiteboard-test.turso.io";
process.env.TURSO_AUTH_TOKEN = "test-token";
process.env.STUDENT_SESSION_SECRET = "test-student-session-secret-at-least-32-chars";

const state = { rooms: [], members: [], messages: [], whiteboards: [], metrics: new Map(), settings: new Map() };

function cell(value) {
  if (value === null || value === undefined) return { type: "null" };
  if (typeof value === "number") return { type: Number.isInteger(value) ? "integer" : "real", value: String(value) };
  return { type: "text", value: String(value) };
}
const ok = (result) => ({ type: "ok", response: { result: result || {} } });
const empty = { cols: [], rows: [] };
const affected = (count) => ok({ affected_row_count: count });
const table = (columns, rows) => ({ cols: columns.map((name) => ({ name })), rows: rows.map((row) => columns.map((name) => cell(row[name]))) });

const ROOM_COLUMNS = ["id", "host_student_id", "title", "video_source_type", "video_id", "status", "join_locked", "visibility", "starts_at", "ends_at", "duration_minutes", "started_at", "ended_at", "created_at", "updated_at"];
const MEMBER_COLUMNS = ["session_id", "student_id", "display_name", "joined_at", "last_seen_at", "left_at"];
const MESSAGE_COLUMNS = ["id", "session_id", "sender_id", "sender_name", "content", "metadata", "created_at"];
/** The aliases the engine's SELECT produces, not the table's column names. */
const BOARD_COLUMNS = ["id", "session_id", "requester_id", "requester_name", "question", "mode", "title", "summary", "topic", "lab", "scene", "model", "at_seconds", "status", "expires_at", "deleted_at", "created_at", "updated_at"];

const normalize = (sql) => sql.replace(/\s+/g, " ").trim();
const likeRoom = (room, args, query) => {
  if (/status <> 'DELETED'/.test(query) && room.status === "DELETED") return false;
  return room.id === args[0];
};

function handle(sql, args) {
  const query = normalize(sql);
  if (/^SELECT version FROM (campus_schema_meta|schema_passes)/.test(query)) return ok(empty);
  if (/^INSERT OR REPLACE INTO (campus_schema_meta|schema_passes)/.test(query)) return affected(1);
  if (/^CREATE (TABLE|INDEX|UNIQUE INDEX)/.test(query)) return ok(empty);
  if (/^ALTER TABLE/.test(query)) return ok(empty);
  if (/^SELECT key, value, COALESCE\(updated_by,''\) AS updated_by/.test(query)) {
    const rows = [...state.settings].map(([key, value]) => ({ key, value, updated_by: "", updated_at: "" }));
    return ok(rows.length ? table(["key", "value", "updated_by", "updated_at"], rows) : empty);
  }
  if (/^INSERT INTO metrics_counters/.test(query)) {
    const [name, day, amount] = args;
    const key = `${name}:${day}`;
    state.metrics.set(key, (state.metrics.get(key) || 0) + Number(amount));
    return ok(table(["count"], [{ count: state.metrics.get(key) }]));
  }
  if (/^SELECT id,host_student_id,title,video_source_type,video_id,status,join_locked,visibility,starts_at,ends_at,duration_minutes,started_at,ended_at,created_at,updated_at FROM cinema_sessions WHERE id = \? LIMIT 1$/.test(query)) {
    const room = state.rooms.find((row) => likeRoom(row, args, query));
    return ok(room ? table(ROOM_COLUMNS, [room]) : empty);
  }
  if (/^SELECT session_id,student_id,display_name,joined_at,last_seen_at,left_at FROM cinema_participants WHERE session_id IN/.test(query)) {
    const rows = state.members.filter((row) => args.includes(row.session_id));
    return ok(rows.length ? table(MEMBER_COLUMNS, rows) : empty);
  }
  if (/^SELECT id,session_id,sender_id,sender_name,content,metadata,created_at FROM cinema_messages WHERE session_id = \? ORDER BY created_at DESC, rowid DESC LIMIT/.test(query)) {
    const rows = state.messages.filter((row) => row.session_id === args[0]);
    return ok(rows.length ? table(MESSAGE_COLUMNS, rows) : empty);
  }
  if (/^INSERT INTO cinema_whiteboards/.test(query)) {
    const [id, sessionId, requesterId, requesterName, question, mode, title, summary, topic, lab, scene, model, atSeconds, expiresAt, createdAt, updatedAt] = args;
    state.whiteboards.push({
      id, session_id: sessionId, requester_id: requesterId, requester_name: requesterName, question, mode,
      title, summary, topic, lab, scene, model, at_seconds: atSeconds, status: "READY",
      expires_at: expiresAt, deleted_at: "", created_at: createdAt, updated_at: updatedAt,
    });
    return affected(1);
  }
  if (/^SELECT id,session_id,requester_id,requester_name,question,COALESCE\(mode/.test(query)) {
    const live = () => state.whiteboards.filter((row) => row.status !== "DELETED");
    const found = () => {
      if (/WHERE id = \? AND session_id = \? AND status <> 'DELETED' LIMIT 1$/.test(query)) {
        return live().filter((row) => row.id === args[0] && row.session_id === args[1]);
      }
      if (/WHERE session_id = \? AND status <> 'DELETED' ORDER BY created_at DESC, rowid DESC LIMIT/.test(query)) {
        return live().filter((row) => row.session_id === args[0]).sort((left, right) => right.created_at.localeCompare(left.created_at));
      }
      if (/WHERE id = \? AND status <> 'DELETED' LIMIT 1$/.test(query)) {
        return live().filter((row) => row.id === args[0]);
      }
      return [];
    };
    const rows = found();
    return ok(rows.length ? table(BOARD_COLUMNS, rows) : empty);
  }
  if (/^SELECT id FROM cinema_whiteboards WHERE status <> 'DELETED' AND expires_at <> '' AND expires_at <= \?/.test(query)) {
    const rows = state.whiteboards
      .filter((row) => row.status !== "DELETED" && row.expires_at && row.expires_at <= args[0])
      .sort((left, right) => left.expires_at.localeCompare(right.expires_at))
      .map((row) => ({ id: row.id }));
    return ok(rows.length ? table(["id"], rows) : empty);
  }
  if (/^UPDATE cinema_whiteboards SET status = 'DELETED', deleted_at = \?, updated_at = \? WHERE id = \? AND status <> 'DELETED'$/.test(query)) {
    const row = state.whiteboards.find((entry) => entry.id === args[2] && entry.status !== "DELETED");
    if (!row) return affected(0);
    Object.assign(row, { status: "DELETED", deleted_at: args[0], updated_at: args[1] });
    return affected(1);
  }
  if (/^UPDATE cinema_whiteboards SET status = 'DELETED', deleted_at = \?, updated_at = \? WHERE session_id = \? AND status <> 'DELETED'$/.test(query)) {
    const rows = state.whiteboards.filter((entry) => entry.session_id === args[2] && entry.status !== "DELETED");
    for (const row of rows) Object.assign(row, { status: "DELETED", deleted_at: args[0], updated_at: args[1] });
    return affected(rows.length);
  }
  return ok(empty);
}

globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  const results = body.requests
    .filter((request) => request.type === "execute")
    .map(({ stmt }) => handle(stmt.sql, (stmt.args || []).map((arg) => (arg.type === "null" ? null : arg.value))));
  return { ok: true, json: async () => ({ results }) };
};

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => vite.close());

const {
  extractJsonObject, geoCommandAllowed, layoutWhiteboardDiagram, parseWhiteboardScene, plainTextBoard, renderMathHtml,
} = await vite.ssrLoadModule("/lib/cinema-engine/whiteboard-scene.ts");
const {
  askCinemaWhiteboard, cinemaWhiteboardById, cinemaWhiteboardLimits, deleteCinemaWhiteboard,
  listCinemaWhiteboards, purgeCinemaWhiteboardsForRoom, purgeExpiredCinemaWhiteboards, whiteboardMode,
} = await vite.ssrLoadModule("/lib/cinema-engine/whiteboard.ts");
const { resetPlatformSettingsCache } = await vite.ssrLoadModule("/lib/platform-settings.ts");

beforeEach(() => {
  state.rooms = [{
    id: "room-1", host_student_id: "student-a", title: "Operating Systems", video_source_type: "YOUTUBE",
    video_id: "dQw4w9WgXcQ", status: "LIVE", join_locked: 0, started_at: "", ended_at: "",
    visibility: "PUBLIC",
    created_at: "2026-09-21T08:00:00.000Z", updated_at: "2026-09-21T08:00:00.000Z",
  }];
  state.members = [
    { session_id: "room-1", student_id: "student-a", display_name: "Ama", joined_at: "2026-09-21T08:00:00.000Z", last_seen_at: "", left_at: "" },
    { session_id: "room-1", student_id: "student-b", display_name: "Kofi", joined_at: "2026-09-21T08:01:00.000Z", last_seen_at: "", left_at: "" },
  ];
  state.messages = [];
  state.whiteboards = [];
  state.metrics.clear();
  state.settings.clear();
  resetPlatformSettingsCache();
});

const sceneReply = (overrides = {}) => JSON.stringify({
  title: "How a page fault is handled",
  summary: "The CPU traps, the kernel finds or makes the page, and the instruction runs again.",
  topic: "DIAGRAM",
  blocks: [
    { kind: "text", text: "A page fault is a trap, not an error." },
    { kind: "diagram", title: "Fault path", nodes: [{ id: "trap", label: "CPU traps" }, { id: "find", label: "Kernel finds the page" }, { id: "retry", label: "Instruction runs again" }], edges: [{ from: "trap", to: "find" }, { from: "find", to: "retry" }] },
  ],
  ...overrides,
});

const ask = (input = {}) => askCinemaWhiteboard({
  roomId: "room-1",
  student: { id: "student-a", name: "Ama" },
  question: "How does a page fault work?",
  generate: async () => sceneReply(),
  ...input,
});

test("a fenced scene parses and every array is bounded", () => {
  const scene = parseWhiteboardScene(`Here you go:\n\`\`\`json\n${sceneReply()}\n\`\`\``);
  assert.equal(scene.title, "How a page fault is handled");
  assert.equal(scene.topic, "DIAGRAM");
  assert.equal(scene.blocks.length, 2);
  assert.equal(scene.blocks[1].nodes.length, 3);

  const crowded = parseWhiteboardScene(JSON.stringify({
    title: "x".repeat(400),
    blocks: Array.from({ length: 20 }, (_, index) => ({ kind: "text", text: `point ${index} `.repeat(400) })),
  }));
  assert.equal(crowded.blocks.length, 12, "no more than twelve blocks survive");
  assert.ok(crowded.blocks[0].text.length <= 1_200, "text is cut to its bound");
  assert.ok(crowded.title.length <= 160);
});

test("an edge that names a node the diagram does not have is dropped whole", () => {
  const scene = parseWhiteboardScene(JSON.stringify({
    title: "Broken",
    blocks: [{
      kind: "diagram",
      nodes: [{ id: "a", label: "One" }, { id: "b", label: "Two" }],
      edges: [{ from: "a", to: "b" }, { from: "a", to: "ghost" }, { from: "b", to: "b" }],
    }],
  }));
  assert.equal(scene.blocks[0].edges.length, 1, "only the edge between real, distinct nodes survives");
  assert.deepEqual(scene.blocks[0].edges[0], { from: "a", to: "b", dashed: false, arrow: "forward" });
});

test("a chart block keeps numbers and labels, and drops points that are neither", () => {
  const scene = parseWhiteboardScene(JSON.stringify({
    title: "Enrolment by year",
    blocks: [{
      kind: "chart",
      chart: "bar",
      title: "Enrolment",
      xLabel: "Year",
      yLabel: "Students",
      series: [{ name: "Civil", x: [2024, 2025, "2026"], y: [120, "140", 160] }],
    }],
  }));
  const chart = scene.blocks[0];
  assert.equal(chart.kind, "chart");
  assert.equal(chart.chart, "bar");
  assert.equal(chart.xLabel, "Year");
  assert.deepEqual(chart.series[0].x, [2024, 2025, "2026"], "labels may be numbers or strings");
  assert.deepEqual(chart.series[0].y, [120, 140, 160], "numeric strings arrive as numbers");

  const cleaned = parseWhiteboardScene(JSON.stringify({
    blocks: [{
      kind: "chart",
      chart: "line",
      series: Array.from({ length: 6 }, (_, index) => ({
        name: `s${index}`,
        x: [1, 2, 3, 4],
        y: index === 0 ? [1, "nope", null, true] : [1, 2, 3, 4],
      })),
    }],
  }));
  assert.equal(cleaned.blocks[0].series.length, 4, "at most four series survive");
  assert.deepEqual(cleaned.blocks[0].series[0].y, [1], "only a real number is a point");

  const pie = parseWhiteboardScene(JSON.stringify({
    blocks: [{ kind: "chart", chart: "pie", series: [
      { x: ["a", "b", "c", "d", "e", "f", "g", "h"], y: [1, 2, 3, 4, 5, 6, 7, 8] },
      { x: ["other"], y: [9] },
    ] }],
  }));
  assert.equal(pie.blocks[0].series.length, 1, "a pie is one ring");
  assert.equal(pie.blocks[0].series[0].x.length, 6, "six slices at most");

  assert.equal(parseWhiteboardScene(JSON.stringify({
    blocks: [{ kind: "chart", chart: "radar", series: [{ x: [1], y: [1] }] }],
  })), null, "a chart kind the renderer does not know leaves nothing behind");
  const uneven = parseWhiteboardScene(JSON.stringify({
    blocks: [{ kind: "chart", chart: "bar", series: [{ x: [1, 2], y: [1] }] }],
  }));
  assert.deepEqual(uneven.blocks[0].series[0].x, [1], "a point must have both an x and a y to be plotted");
});

test("a geo block runs only the commands on the allow-list", () => {
  assert.equal(geoCommandAllowed("f(x)=x^2"), true);
  assert.equal(geoCommandAllowed("y=sin(x)"), true);
  assert.equal(geoCommandAllowed("A=(1,2)"), true);
  assert.equal(geoCommandAllowed("a=3"), true);
  assert.equal(geoCommandAllowed("Derivative(f)"), true);
  assert.equal(geoCommandAllowed("Intersect(f, g)"), true);
  assert.equal(geoCommandAllowed('RunClickScript("alert(1)")'), false, "a page command is not a graph");
  assert.equal(geoCommandAllowed('SetColor(A, "red")'), false);
  assert.equal(geoCommandAllowed("Delete(A)"), false);
  assert.equal(geoCommandAllowed("f(x)=x; Delete(A)"), false, "a second statement never gets through");
  assert.equal(geoCommandAllowed("f(x)=x^2 `"), false);
  assert.equal(geoCommandAllowed("x".repeat(201)), false, "a command is bounded");
  assert.equal(geoCommandAllowed(""), false);

  const scene = parseWhiteboardScene(JSON.stringify({
    title: "The parabola",
    blocks: [{
      kind: "geo",
      title: "y = x²",
      commands: ["f(x)=x^2", "A=(1,1)", 'RunClickScript("alert(1)")', "Derivative(f)", "Delete(A)"],
    }],
  }));
  assert.equal(scene.blocks[0].kind, "geo");
  assert.deepEqual(scene.blocks[0].commands, ["f(x)=x^2", "A=(1,1)", "Derivative(f)"], "the off-list commands are dropped");

  const script = parseWhiteboardScene(JSON.stringify({
    blocks: [{ kind: "script", script: "f(x)=x^2\nDerivative(f)\nDelete(A)" }],
  }));
  assert.deepEqual(script.blocks[0].commands, ["f(x)=x^2", "Derivative(f)"]);

  const multiline = parseWhiteboardScene(JSON.stringify({
    blocks: [{ kind: "geo", commands: ["f(x)=x^2\nDerivative(f)"] }],
  }));
  assert.deepEqual(multiline.blocks[0].commands, ["f(x)=x^2", "Derivative(f)"], "a newline is a line boundary in an array too");
});

test("prose is not a scene, and becomes a plain-text board instead of an error", () => {
  assert.equal(parseWhiteboardScene("A page fault happens when the page is not in memory."), null);
  assert.equal(parseWhiteboardScene(JSON.stringify({ title: "Empty", blocks: [] })), null);
  const board = plainTextBoard("A page fault happens when the page is not in memory.", "What is a page fault?");
  assert.equal(board.unparsed, true);
  assert.equal(board.blocks.length, 1);
  assert.equal(board.blocks[0].kind, "text");
  assert.match(board.title, /page fault/);
});

test("a scene that was cut off is explained, not dumped as a wall of JSON", () => {
  const truncated = '{"title":"Page fault","blocks":[{"kind":"diagram","nodes":[{"id":"a","label":"Trap"';
  assert.equal(parseWhiteboardScene(truncated), null);
  const board = plainTextBoard(truncated, "Draw a page fault");
  assert.equal(board.unparsed, true);
  assert.equal(board.blocks[0].kind, "text");
  assert.match(board.blocks[0].text, /cut off/);
  assert.equal(board.blocks[0].text.includes('"kind"'), false, "raw JSON never reaches the board");
  // Prose is still shown as prose, not as an apology.
  assert.match(plainTextBoard("A fault is a trap.", "q").blocks[0].text, /A fault is a trap\./);
});

test("extractJsonObject reads the first balanced object and tolerates braces in strings", () => {
  assert.deepEqual(extractJsonObject('Sure! {"a":1,"b":"{not a brace}"} hope that helps'), { a: 1, b: "{not a brace}" });
  assert.equal(extractJsonObject("no object here"), null);
  assert.equal(extractJsonObject('{"broken": '), null);
});

test("the layout layers left to right, honours explicit columns, and survives a cycle", () => {
  const nodes = [{ id: "a", label: "A", shape: "box", tone: "default" }, { id: "b", label: "B", shape: "box", tone: "default" }, { id: "c", label: "C", shape: "box", tone: "default" }];
  const edges = [{ from: "a", to: "b", dashed: false, arrow: "forward" }, { from: "b", to: "c", dashed: false, arrow: "forward" }];
  const layout = layoutWhiteboardDiagram(nodes, edges);
  const at = (id) => layout.nodes.find((node) => node.id === id);
  assert.ok(at("a").x < at("b").x && at("b").x < at("c").x, "each layer is further right");
  assert.equal(layout.edges.length, 2);
  assert.equal(layout.width > at("c").x, true);

  const pinned = layoutWhiteboardDiagram(nodes, []).nodes.find((node) => node.id === "c");
  const explicit = layoutWhiteboardDiagram([{ ...nodes[2], column: 0, row: 2 }, nodes[0]], edges.slice(0, 1)).nodes;
  assert.equal(explicit.find((node) => node.id === "c").y > explicit.find((node) => node.id === "a").y, true);
  assert.equal(pinned.column, undefined);

  const cycle = layoutWhiteboardDiagram([nodes[0], nodes[1]], [{ from: "a", to: "b", dashed: false, arrow: "forward" }, { from: "b", to: "a", dashed: false, arrow: "forward" }]);
  assert.equal(cycle.nodes.length, 2, "a cycle lays out rather than hanging");
});

test("maths renders a small LaTeX subset and escapes everything else", () => {
  const fraction = renderMathHtml("\\frac{1}{2}");
  assert.match(fraction, /cinema-math-frac/);
  assert.match(fraction, /cinema-math-num">1</);
  const powers = renderMathHtml("x^2 + y_1");
  assert.match(powers, /x<sup>2<\/sup>/);
  assert.match(powers, /y<sub>1<\/sub>/);
  assert.match(renderMathHtml("\\alpha \\le \\infty"), /α ≤ ∞/);
  assert.match(renderMathHtml("\\sqrt{x+1}"), /cinema-math-radicand/);
  const escaped = renderMathHtml("<script>alert(1)</script>");
  assert.equal(escaped.includes("<script>"), false);
  assert.match(escaped, /&lt;script&gt;/);
  assert.equal(renderMathHtml("\\notacommand").includes("notacommand"), true, "an unknown macro is written, not evaluated");
});

test("a member's question stores a board with the room's context and its own retention", async () => {
  state.messages = [{ id: "m1", session_id: "room-1", sender_id: "student-b", sender_name: "Kofi", content: "Wait, what does the MMU do here?", metadata: "{}", created_at: "2026-09-21T08:02:00.000Z" }];
  let seen = null;
  const now = Date.parse("2026-09-21T09:00:00.000Z");
  const board = await ask({
    now,
    atSeconds: 320,
    generate: async (system, user) => { seen = { system, user }; return sceneReply(); },
  });

  assert.equal(board.status, "READY");
  assert.equal(board.view.requesterId, "student-a");
  assert.equal(board.view.requesterName, "Ama");
  assert.equal(board.view.roomId, "room-1");
  assert.equal(board.view.atSeconds, 320);
  assert.equal(board.view.topic, "DIAGRAM");
  assert.equal(board.view.blocks.length, 2);
  assert.equal(state.whiteboards[0].status, "READY");
  assert.match(state.whiteboards[0].model, /@cf\//, "the row names the model that answered");
  assert.equal(state.whiteboards[0].expires_at, new Date(now + 2 * 3_600_000).toISOString(), "the room's retention window, not a constant");
  assert.match(seen.system, /Security topics are allowed as education/);
  assert.match(seen.system, /"kind":"chart"/, "the chart schema is in the prompt");
  assert.match(seen.system, /"kind":"geo"/, "the graphing schema is in the prompt");
  assert.match(seen.system, /Derivative, Integral, Solve/, "the allow-list the parser enforces is the one the model is told");
  assert.match(seen.user, /Operating Systems/, "the room's title is in the context");
  assert.match(seen.user, /Kofi: Wait, what does the MMU do here\?/, "the last chat is in the context");
  assert.match(seen.user, /5:20/, "the playhead is in the context");
});

test("a new board builds on the previous one", async () => {
  const prompts = [];
  const generate = async (_system, user) => { prompts.push(user); return sceneReply(); };
  await ask({ generate });
  await ask({ question: "And the second chance algorithm?", generate });
  assert.match(prompts[1], /previous board was "How a page fault is handled"/);
});

test("a board with a chart and a graph is stored and read back as they were bounded", async () => {
  const reply = JSON.stringify({
    title: "Projectile motion",
    summary: "Height over time, and the function the room can explore.",
    topic: "SCIENCE",
    blocks: [
      { kind: "chart", chart: "line", title: "Height", series: [{ name: "h(t)", x: [0, 1, 2], y: [0, 4.9, 9.8] }] },
      { kind: "geo", title: "h(t)", commands: ["f(x)=x^2", "Derivative(f)", "Delete(f)"] },
    ],
  });
  const board = await ask({ generate: async () => reply });
  assert.deepEqual(board.view.blocks.map((block) => block.kind), ["chart", "geo"]);
  assert.deepEqual(board.view.blocks[1].commands, ["f(x)=x^2", "Derivative(f)"]);
  const [stored] = await listCinemaWhiteboards({ roomId: "room-1" });
  assert.deepEqual(stored.view.blocks.map((block) => block.kind), ["chart", "geo"]);
  assert.equal(stored.view.blocks[0].series[0].y[2], 9.8);
});

test("a reply that ignored the schema gets one repair attempt, then plain text", async () => {
  const repair = { calls: 0 };
  const fixed = await ask({ generate: async () => (repair.calls += 1) === 1 ? "I would answer with a diagram." : sceneReply() });
  assert.equal(repair.calls, 2);
  assert.equal(fixed.view.unparsed, undefined);

  const prose = { calls: 0 };
  const kept = await ask({ generate: async () => { prose.calls += 1; return "A page fault is a trap the kernel handles."; } });
  assert.equal(prose.calls, 2);
  assert.equal(kept.view.unparsed, true);
  assert.equal(kept.view.blocks[0].kind, "text");
  assert.match(kept.view.blocks[0].text, /trap the kernel handles/);
});

test("a model that is down is a 502, not a stored board", async () => {
  await assert.rejects(
    () => ask({ generate: async () => { throw new Error("the model refused"); } }),
    /unavailable right now/,
  );
  assert.equal(state.whiteboards.length, 0);
});

test("a switched-off deployment refuses before the model is called", async () => {
  state.settings.set("cinema_whiteboard_enabled", "0");
  resetPlatformSettingsCache();
  let calls = 0;
  await assert.rejects(() => ask({ generate: async () => { calls += 1; return sceneReply(); } }), /switched off/);
  assert.equal(calls, 0);
  assert.equal((await cinemaWhiteboardLimits()).enabled, false);
  assert.equal(state.whiteboards.length, 0);
});

test("asking requires membership and an open room", async () => {
  await assert.rejects(() => ask({ student: { id: "student-c", name: "Esi" } }), /Join the room before asking/);
  state.rooms[0].status = "ENDED";
  await assert.rejects(() => ask(), /This room has ended/);
  await assert.rejects(() => ask({ roomId: "room-9" }), /does not exist/);
});

test("the host's policy decides who may ask, and an automatic room takes questions from nobody", async () => {
  let calls = 0;
  const generate = async () => { calls += 1; return sceneReply(); };

  // Host only: a member is refused before the model is called.
  await assert.rejects(
    () => ask({ policy: "HOST", student: { id: "student-b", name: "Kofi" }, generate }),
    /host keeps the questions/,
  );
  assert.equal(calls, 0, "a refused question never reaches the model");
  const hosted = await ask({ policy: "HOST", generate });
  assert.equal(hosted.view.requesterId, "student-a", "the host asks in their own room");

  // Automatic: nobody asks by hand, and the automatic pass is the host's.
  await assert.rejects(() => ask({ policy: "AUTO", generate }), /answers on its own/);
  await assert.rejects(
    () => ask({ policy: "AUTO", auto: true, student: { id: "student-b", name: "Kofi" }, generate }),
    /Only the host/,
  );
  await assert.rejects(() => ask({ policy: "MEMBERS", auto: true, generate }), /not on automatic/);

  // The automatic pass carries the engine's question, never the browser's.
  let seen = "";
  const auto = await ask({
    policy: "AUTO",
    auto: true,
    atSeconds: 640,
    generate: async (_system, user) => { seen = user; return sceneReply({ title: "Summary at 10:40" }); },
  });
  assert.equal(auto.view.title, "Summary at 10:40");
  assert.match(seen, /summarise what this stretch of the session/i, "the engine writes the automatic question");
  assert.match(seen, /10:40/, "the automatic pass says where the room is");
  const stored = state.whiteboards.find((row) => row.id === auto.id);
  assert.equal(stored.question.includes("How does a page fault work?"), false, "a client's text never becomes the automatic prompt");
});

test("the automatic cadence is a console setting with a floor", async () => {
  assert.equal((await cinemaWhiteboardLimits()).autoMinutes, 10, "the shipped cadence");
  state.settings.set("cinema_board_auto_minutes", "20");
  resetPlatformSettingsCache();
  assert.equal((await cinemaWhiteboardLimits()).autoMinutes, 20);
  state.settings.set("cinema_board_auto_minutes", "1");
  resetPlatformSettingsCache();
  assert.equal((await cinemaWhiteboardLimits()).autoMinutes, 5, "a pace below the floor is the floor");
});

test("boards list newest first, read by id, and validate their mode", async () => {
  let tick = 0;
  await ask({ now: Date.parse("2026-09-21T09:00:00.000Z"), generate: async () => sceneReply({ title: `Board ${tick += 1}` }) });
  await ask({ now: Date.parse("2026-09-21T09:01:00.000Z"), generate: async () => sceneReply({ title: `Board ${tick += 1}` }) });
  const boards = await listCinemaWhiteboards({ roomId: "room-1" });
  assert.deepEqual(boards.map((board) => board.view.title), ["Board 2", "Board 1"]);
  const one = await cinemaWhiteboardById({ boardId: boards[1].id, roomId: "room-1" });
  assert.equal(one.view.title, "Board 1");
  await assert.rejects(() => cinemaWhiteboardById({ boardId: boards[1].id, roomId: "room-2" }), /does not exist/);
  assert.equal(whiteboardMode("math"), "MATH");
  assert.equal(whiteboardMode("unknown"), "AUTO");
});

test("clearing is the host's, or the asker taking their own board back", async () => {
  const board = await ask();
  await assert.rejects(
    () => deleteCinemaWhiteboard({ boardId: board.id, roomId: "room-1", actor: { id: "student-b", isHost: false } }),
    /Only the host or the person who asked/,
  );
  const cleared = await deleteCinemaWhiteboard({ boardId: board.id, roomId: "room-1", actor: { id: "student-a", isHost: false } });
  assert.equal(cleared.deleted, true);
  assert.equal(state.whiteboards[0].status, "DELETED");
  assert.equal((await listCinemaWhiteboards({ roomId: "room-1" })).length, 0);

  const second = await ask();
  const host = await deleteCinemaWhiteboard({ boardId: second.id, roomId: "room-1", actor: { id: "student-z", isHost: true } });
  assert.equal(host.deleted, true);
});

test("retention expires boards by the room's window, and room deletion clears the rest", async () => {
  const now = Date.parse("2026-09-21T09:00:00.000Z");
  await ask({ now });
  assert.deepEqual(await purgeExpiredCinemaWhiteboards({ now: now + 3_600_000 }), { deleted: 0 });
  assert.deepEqual(await purgeExpiredCinemaWhiteboards({ now: now + 3 * 3_600_000 }), { deleted: 1 });
  assert.equal(state.whiteboards[0].status, "DELETED");

  await ask({ now });
  await ask({ now });
  assert.deepEqual(await purgeCinemaWhiteboardsForRoom("room-1"), { deleted: 2 });
  assert.equal(state.whiteboards.filter((row) => row.status !== "DELETED").length, 0);
});

test("a stored board whose scene cannot be read is not served", async () => {
  const board = await ask();
  state.whiteboards[0].scene = "{ not json";
  assert.deepEqual(await listCinemaWhiteboards({ roomId: "room-1" }), []);
  await assert.rejects(() => cinemaWhiteboardById({ boardId: board.id, roomId: "room-1" }), /no readable scene/);
});
