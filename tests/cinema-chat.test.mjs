import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

/**
 * Cinema chat: stored before it is broadcast, replayed to a newcomer, capped
 * in length, and limited per student rather than per address.
 *
 * The engine and the Durable Object run against a fake Turso that keeps
 * `cinema_messages` in memory and refuses any statement it was not taught, so
 * a query change shows up as a failing test rather than a silent no-op.
 */

process.env.TURSO_DATABASE_URL = "https://cinema-chat-test.turso.io";
process.env.TURSO_AUTH_TOKEN = "test-token";

const state = { messages: [], schema: new Map(), windows: new Map() };

function cell(value) {
  if (value === null || value === undefined) return { type: "null" };
  if (typeof value === "number") return { type: Number.isInteger(value) ? "integer" : "real", value: String(value) };
  return { type: "text", value: String(value) };
}
const ok = (result) => ({ type: "ok", response: { result: result || {} } });
const empty = { cols: [], rows: [] };
const affected = (count) => ok({ affected_row_count: count });
const table = (columns, rows) => ({ cols: columns.map((name) => ({ name })), rows: rows.map((row) => columns.map((name) => cell(row[name]))) });

export const MESSAGE_COLUMNS = ["id", "session_id", "sender_id", "sender_name", "content", "metadata", "created_at"];

function handle(sql, args) {
  if (/^SELECT version FROM (campus_schema_meta|schema_passes)/.test(sql)) {
    const version = state.schema.get(String(args[0] || ""));
    return version ? ok(table(["version"], [{ version }])) : ok(empty);
  }
  if (/^INSERT OR REPLACE INTO (campus_schema_meta|schema_passes)/.test(sql)) {
    state.schema.set(String(args[0] || ""), String(args[1] || ""));
    return affected(1);
  }
  if (/^CREATE (TABLE|INDEX|UNIQUE INDEX)/.test(sql)) return ok(empty);

  if (/^DELETE FROM rate_limit_windows/.test(sql)) return affected(0);
  if (/^INSERT INTO rate_limit_windows/.test(sql)) {
    const [scope, subject, windowKey] = args;
    const key = `${scope}:${subject}:${windowKey}`;
    const count = (state.windows.get(key) || 0) + 1;
    state.windows.set(key, count);
    return ok(table(["count"], [{ count }]));
  }
  if (/^SELECT count FROM rate_limit_windows/.test(sql)) {
    const count = state.windows.get(`${args[0]}:${args[1]}:${args[2]}`) || 1;
    return ok(table(["count"], [{ count }]));
  }

  if (/^INSERT INTO cinema_messages/.test(sql)) {
    const [id, session_id, sender_id, sender_name, content, metadata, created_at] = args;
    state.messages.push({ id, session_id, sender_id, sender_name, content, metadata, created_at, seq: state.messages.length });
    return affected(1);
  }
  if (/^SELECT id,session_id,sender_id,sender_name,content,metadata,created_at FROM cinema_messages/.test(sql)) {
    const limit = Number((sql.match(/LIMIT (\d+)/) || [])[1] || 50);
    const rows = state.messages
      .filter((row) => row.session_id === args[0])
      .slice()
      // Same shape as SQLite's ORDER BY created_at DESC, rowid DESC.
      .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)) || right.seq - left.seq)
      .slice(0, limit);
    return ok(rows.length ? table(MESSAGE_COLUMNS, rows) : empty);
  }
  if (/^DELETE FROM cinema_messages WHERE session_id/.test(sql)) {
    const before = state.messages.length;
    state.messages = state.messages.filter((row) => row.session_id !== args[0]);
    return affected(before - state.messages.length);
  }

  if (/^INSERT INTO metrics_counters/.test(sql)) return ok(table(["count"], [{ count: 1 }]));
  return ok(empty);
}

globalThis.fetch = async (url, init) => {
  const target = String(typeof url === "string" ? url : url?.url || "");
  if (target.startsWith("https://cinema-chat-test.turso.io")) {
    const body = JSON.parse(init.body);
    const results = body.requests
      .filter((request) => request.type === "execute")
      .map(({ stmt }) => handle(stmt.sql, (stmt.args || []).map((arg) => (arg.type === "null" ? null : arg.value))));
    return { ok: true, json: async () => ({ results }) };
  }
  throw new Error(`Unhandled request to ${target}`);
};

// The DO reads WebSocketPair from the global, exactly as it does in workerd.
function fakeSocket() {
  return {
    sent: [],
    closed: null,
    attachment: undefined,
    send(frame) { this.sent.push(JSON.parse(frame)); },
    close(code, reason) { this.closed = { code, reason }; },
    serializeAttachment(value) { this.attachment = value; },
    deserializeAttachment() { return this.attachment; },
  };
}

function fakeState() {
  const sockets = [];
  const stored = new Map();
  return {
    sockets,
    stored,
    storage: {
      async get(key) { return stored.get(key); },
      async put(key, value) { stored.set(key, value); },
    },
    acceptWebSocket(socket) { sockets.push(socket); },
    getWebSockets() { return [...sockets]; },
  };
}

globalThis.WebSocketPair = class WebSocketPair {
  constructor() {
    const client = fakeSocket();
    const server = fakeSocket();
    return { 0: client, 1: server };
  }
};

const NodeResponse = globalThis.Response;
class UpgradeableResponse extends NodeResponse {
  constructor(body, init) {
    if (init && init.status === 101) {
      super(null, { status: 200, headers: init.headers });
      Object.defineProperty(this, "status", { value: 101, enumerable: true });
      this.webSocket = init.webSocket;
      return;
    }
    super(body, init);
  }
}
globalThis.Response = UpgradeableResponse;

const SNAPSHOT = { roomId: "room-chat", hostStudentId: "host-1", title: "Signals", sourceType: "YOUTUBE", videoId: "M7lc1UVf-VE" };
const identity = (studentId, displayName) => encodeURIComponent(JSON.stringify({ studentId, displayName }));

function upgrade(studentId = "host-1", displayName = "Ama Host") {
  return new Request("https://cinema-room/socket", {
    headers: {
      upgrade: "websocket",
      "x-cinema-attachment": identity(studentId, displayName),
      "x-cinema-room": encodeURIComponent(JSON.stringify(SNAPSHOT)),
    },
  });
}

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => vite.close());

const { writeCinemaMessage, recentCinemaMessages, purgeCinemaMessages } = await vite.ssrLoadModule("/lib/cinema-engine/messages.ts");
const { parseClientMessage, CINEMA_CHAT_MAX_LENGTH } = await vite.ssrLoadModule("/lib/cinema-engine/protocol.ts");
const { CinemaRoom } = await vite.ssrLoadModule("/worker/cinema-room.ts");

beforeEach(() => {
  state.messages = [];
  state.windows.clear();
  process.env.TURSO_DATABASE_URL = "https://cinema-chat-test.turso.io";
  process.env.TURSO_AUTH_TOKEN = "test-token";
});

async function newRoom() {
  const stateDouble = fakeState();
  return { room: new CinemaRoom(stateDouble), state: stateDouble };
}

test("a message is stored with its timestamp and read back oldest first", async () => {
  await writeCinemaMessage({ sessionId: "room-1", sender: { id: "s-1", name: "Ama" }, content: "  Pause at 05:20  ", atSeconds: 320 });
  await writeCinemaMessage({ sessionId: "room-1", sender: { id: "s-2", name: "Kwesi" }, content: "Got it", atSeconds: 322 });
  await writeCinemaMessage({ sessionId: "room-1", sender: { id: "s-1", name: "Ama" }, content: "No timestamp" });

  const messages = await recentCinemaMessages("room-1");
  assert.equal(messages.length, 3);
  assert.equal(messages[0].content, "Pause at 05:20", "outer whitespace never reaches the room");
  assert.equal(messages[0].atSeconds, 320);
  assert.equal(messages[0].senderName, "Ama");
  assert.equal(messages[2].atSeconds, null, "a message without a position carries no chip");
  assert.ok(messages[0].createdAt <= messages[1].createdAt, "the replay is chronological");
});

test("empty, oversized and malformed messages are refused before storage", async () => {
  await assert.rejects(() => writeCinemaMessage({ sessionId: "room-1", sender: { id: "s-1" }, content: "   " }), (error) => error?.code === "VALIDATION_ERROR");
  await assert.rejects(
    () => writeCinemaMessage({ sessionId: "room-1", sender: { id: "s-1" }, content: "x".repeat(CINEMA_CHAT_MAX_LENGTH + 1) }),
    (error) => error?.code === "VALIDATION_ERROR",
  );
  await assert.rejects(() => writeCinemaMessage({ sessionId: "", sender: { id: "s-1" }, content: "hello" }), (error) => error?.code === "VALIDATION_ERROR");
  assert.equal(state.messages.length, 0);
});

test("a wire frame must be a real message, and a timestamp must be a position", () => {
  assert.deepEqual(parseClientMessage(JSON.stringify({ type: "chat_message", message: " hello ", timestamp: 12.5 })), {
    type: "chat_message",
    message: "hello",
    timestamp: 12.5,
  });
  assert.equal(parseClientMessage(JSON.stringify({ type: "chat_message", message: "   " })), null);
  assert.equal(parseClientMessage(JSON.stringify({ type: "chat_message", message: "x".repeat(CINEMA_CHAT_MAX_LENGTH + 1) })), null);
  assert.deepEqual(parseClientMessage(JSON.stringify({ type: "chat_message", message: "no position" })), { type: "chat_message", message: "no position" });
  assert.equal(parseClientMessage(JSON.stringify({ type: "chat_message", message: "bad", timestamp: -3 }))?.timestamp, undefined);
});

test("the replay window is the newest fifty, in the order they were said", async () => {
  for (let index = 1; index <= 55; index += 1) {
    await writeCinemaMessage({ sessionId: "room-2", sender: { id: "s-1", name: "Ama" }, content: `message ${index}` });
  }
  const messages = await recentCinemaMessages("room-2", 50);
  assert.equal(messages.length, 50);
  assert.equal(messages[0].content, "message 6", "the newest fifty, not the oldest");
  assert.equal(messages[49].content, "message 55");
});

test("purging a room removes its chat and nothing else", async () => {
  await writeCinemaMessage({ sessionId: "room-3", sender: { id: "s-1" }, content: "keep me" });
  await writeCinemaMessage({ sessionId: "room-4", sender: { id: "s-1" }, content: "delete me" });
  assert.equal(await purgeCinemaMessages("room-4"), 1);
  assert.deepEqual((await recentCinemaMessages("room-4")).length, 0);
  assert.deepEqual((await recentCinemaMessages("room-3")).map((message) => message.content), ["keep me"]);
});

test("a chat frame is stored once and lands on every socket", async () => {
  const { room, state: roomState } = await newRoom();
  await room.fetch(upgrade());
  await room.fetch(upgrade("guest-2", "Kwesi Guest"));
  const [hostSocket, guestSocket] = roomState.sockets;

  await room.webSocketMessage(guestSocket, JSON.stringify({ type: "chat_message", message: "What did she say?", timestamp: 42 }));

  const frame = guestSocket.sent.at(-1);
  assert.equal(frame.type, "chat");
  assert.equal(frame.message.content, "What did she say?");
  assert.equal(frame.message.atSeconds, 42);
  assert.equal(frame.message.senderName, "Kwesi Guest");
  assert.deepEqual(hostSocket.sent.at(-1), frame, "the sender and the room see the same row");
  assert.equal(state.messages.length, 1, "stored exactly once");
});

test("a newcomer is replayed the conversation without retelling it to the room", async () => {
  const { room, state: roomState } = await newRoom();
  await room.fetch(upgrade());
  const [hostSocket] = roomState.sockets;
  await room.webSocketMessage(hostSocket, JSON.stringify({ type: "chat_message", message: "first" }));
  await room.webSocketMessage(hostSocket, JSON.stringify({ type: "chat_message", message: "second" }));

  await room.fetch(upgrade("guest-2", "Kwesi Guest"));
  const [, guestSocket] = roomState.sockets;
  const replayed = guestSocket.sent.filter((frame) => frame.type === "chat").map((frame) => frame.message.content);
  assert.deepEqual(replayed, ["first", "second"]);
  assert.equal(hostSocket.sent.filter((frame) => frame.type === "chat").length, 2, "the room was not retold its own history");
});

test("a flood of chat frames is limited per student, not per address", async () => {
  delete process.env.TURSO_DATABASE_URL;
  const { room, state: roomState } = await newRoom();
  await room.fetch(upgrade("flood-student", "Flooder"));
  const [socket] = roomState.sockets;

  for (let index = 0; index < 8; index += 1) {
    await room.webSocketMessage(socket, JSON.stringify({ type: "chat_message", message: `burst ${index}` }));
  }
  assert.equal(socket.sent.filter((frame) => frame.type === "chat").length, 8);
  assert.equal(socket.sent.at(-1).type, "chat");

  await room.webSocketMessage(socket, JSON.stringify({ type: "chat_message", message: "one too many" }));
  assert.equal(socket.sent.at(-1).type, "error");
  assert.match(socket.sent.at(-1).message, /too fast/i);
  assert.equal(socket.sent.filter((frame) => frame.type === "chat").length, 8, "the ninth message was refused, not broadcast");
});
