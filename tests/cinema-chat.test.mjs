import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { sqliteTurso } from "./helpers/sqlite-turso.mjs";

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

const database = sqliteTurso();
const originalFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  const response = await database.fetch(...args);
  const body = await response.json();
  // Hrana integer cells are strings in production, unlike node:sqlite numbers.
  return Response.json(JSON.parse(JSON.stringify(body, (key, value) => key === "value" && typeof value === "number" ? String(value) : value)));
};
function clearTable(name) {
  if (database.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name)) database.db.prepare(`DELETE FROM ${name}`).run();
}
const state = {
  get messages() {
    try { return database.db.prepare("SELECT * FROM cinema_messages").all(); } catch { return []; }
  },
  set messages(_value) { clearTable("cinema_messages"); clearTable("cinema_message_order"); },
  windows: { clear() { clearTable("rate_limit_windows"); } },
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
const identity = (studentId, displayName, role) => encodeURIComponent(JSON.stringify({ studentId, displayName, ...(role ? { role } : {}) }));

function upgrade(studentId = "host-1", displayName = "Ama Host", role) {
  return new Request("https://cinema-room/socket", {
    headers: {
      upgrade: "websocket",
      "x-cinema-attachment": identity(studentId, displayName, role),
      "x-cinema-room": encodeURIComponent(JSON.stringify(SNAPSHOT)),
    },
  });
}

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => { await vite.close(); database.db.close(); globalThis.fetch = originalFetch; });

const { writeCinemaMessage, recentCinemaMessages, purgeCinemaMessages, readCinemaMessage, cinemaMessagePage, removeCinemaMessage } = await vite.ssrLoadModule("/lib/cinema-engine/messages.ts");
const { parseClientMessage, CINEMA_CHAT_MAX_LENGTH } = await vite.ssrLoadModule("/lib/cinema-engine/protocol.ts");
const { CinemaRoom } = await vite.ssrLoadModule("/worker/cinema-room.ts");

beforeEach(() => {
  state.messages = [];
  state.windows.clear();
  process.env.TURSO_DATABASE_URL = "https://cinema-chat-test.turso.io";
  process.env.TURSO_AUTH_TOKEN = "test-token";
});

async function newRoom() {
  const { ensureCinemaTables } = await vite.ssrLoadModule("/lib/cinema-engine/rooms.ts");
  await ensureCinemaTables();
  const stamp = new Date().toISOString();
  database.db.prepare("INSERT OR IGNORE INTO cinema_sessions(id,host_student_id,title,video_id,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(SNAPSHOT.roomId, SNAPSHOT.hostStudentId, SNAPSHOT.title, SNAPSHOT.videoId, stamp, stamp);
  for (const studentId of ["host-1", "guest-2", "guest-3", "cohost-2", "presenter-3", "student-1", "flood-student"]) database.db.prepare("INSERT OR IGNORE INTO cinema_participants(session_id,student_id,joined_at) VALUES (?,?,?)").run(SNAPSHOT.roomId, studentId, stamp);
  database.db.prepare("UPDATE cinema_participants SET role='COHOST' WHERE session_id=? AND student_id='cohost-2'").run(SNAPSHOT.roomId);
  database.db.prepare("UPDATE cinema_participants SET role='PRESENTER' WHERE session_id=? AND student_id='presenter-3'").run(SNAPSHOT.roomId);
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
  assert.deepEqual(parseClientMessage(JSON.stringify({ type: "mute_all" })), { type: "mute_all" });
  assert.deepEqual(parseClientMessage(JSON.stringify({ type: "mute_all", extra: "ignored" })), { type: "mute_all" });
  assert.deepEqual(parseClientMessage(JSON.stringify({ type: "board_policy", policy: "auto" })), { type: "board_policy", policy: "AUTO" });
  assert.equal(parseClientMessage(JSON.stringify({ type: "board_policy", policy: "ANYONE" })), null);
  assert.equal(parseClientMessage(JSON.stringify({ type: "board_policy" })), null);
  assert.deepEqual(parseClientMessage(JSON.stringify({ type: "hand_state", raised: true })), { type: "hand_state", raised: true });
  assert.deepEqual(parseClientMessage(JSON.stringify({ type: "reaction", emoji: "👏" })), { type: "reaction", emoji: "👏" });
  assert.deepEqual(parseClientMessage(JSON.stringify({ type: "reaction", emoji: "🔥" })), { type: "reaction", emoji: "🔥" });
  assert.equal(parseClientMessage(JSON.stringify({ type: "reaction", emoji: "🚀" })), null);
});

test("hands update presence and reactions are stamped by the room", async () => {
  const { room, state: roomState } = await newRoom();
  await room.fetch(upgrade());
  await room.fetch(upgrade("guest-2", "Kwesi Guest", "VIEWER"));
  const [hostSocket, guestSocket] = roomState.sockets;

  await room.webSocketMessage(guestSocket, JSON.stringify({ type: "hand_state", raised: true }));
  const presence = hostSocket.sent.at(-1);
  assert.equal(presence.type, "presence");
  assert.equal(presence.members.find((member) => member.studentId === "guest-2").handRaised, true);

  await room.webSocketMessage(guestSocket, JSON.stringify({ type: "reaction", emoji: "💡" }));
  const reaction = hostSocket.sent.at(-1);
  assert.equal(reaction.type, "reaction");
  assert.equal(reaction.from, "guest-2");
  assert.equal(reaction.name, "Kwesi Guest");
  assert.equal(reaction.emoji, "💡");
  assert.ok(reaction.id);
});

test("co-hosts moderate and presenters control playback without receiving host identity", async () => {
  const { room, state: roomState } = await newRoom();
  await room.fetch(upgrade());
  await room.fetch(upgrade("cohost-2", "Esi Co-host", "COHOST"));
  await room.fetch(upgrade("presenter-3", "Kojo Presenter", "PRESENTER"));
  const [, cohostSocket, presenterSocket] = roomState.sockets;

  await room.webSocketMessage(cohostSocket, JSON.stringify({ type: "mute_all" }));
  assert.equal(cohostSocket.sent.at(-1).type, "mute_all");
  await room.webSocketMessage(presenterSocket, JSON.stringify({ type: "play", time: 3, duration: 60, stateAt: 0 }));
  assert.equal(presenterSocket.sent.at(-1).type, "state");
  const members = await room.presence();
  assert.equal(members.find((member) => member.studentId === "cohost-2").role, "COHOST");
  assert.equal(members.find((member) => member.studentId === "presenter-3").isHost, false);
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

test("only the host can mute the room, and the ask lands on every socket", async () => {
  const { room, state: roomState } = await newRoom();
  await room.fetch(upgrade());
  await room.fetch(upgrade("guest-2", "Kwesi Guest"));
  const [hostSocket, guestSocket] = roomState.sockets;

  await room.webSocketMessage(guestSocket, JSON.stringify({ type: "mute_all" }));
  assert.equal(guestSocket.sent.at(-1).type, "error");
  assert.match(guestSocket.sent.at(-1).message, /host/i);
  assert.equal(hostSocket.sent.filter((frame) => frame.type === "mute_all").length, 0, "a guest's ask never reaches the room");

  await room.webSocketMessage(hostSocket, JSON.stringify({ type: "mute_all" }));
  const frame = hostSocket.sent.at(-1);
  assert.equal(frame.type, "mute_all");
  assert.equal(frame.by, "host-1");
  assert.deepEqual(guestSocket.sent.at(-1), frame, "the host and the room hear the same ask");
});

test("only the host sets who may ask the board, and the room remembers it", async () => {
  const { room, state: roomState } = await newRoom();
  await room.fetch(upgrade());
  await room.fetch(upgrade("guest-2", "Kwesi Guest"));
  const [hostSocket, guestSocket] = roomState.sockets;

  await room.webSocketMessage(guestSocket, JSON.stringify({ type: "board_policy", policy: "AUTO" }));
  assert.equal(guestSocket.sent.at(-1).type, "error");
  assert.match(guestSocket.sent.at(-1).message, /host/i);
  assert.equal(hostSocket.sent.filter((frame) => frame.type === "board_policy").length, 1, "a guest's change never reaches the room");

  await room.webSocketMessage(hostSocket, JSON.stringify({ type: "board_policy", policy: "AUTO" }));
  assert.deepEqual(hostSocket.sent.at(-1), { type: "board_policy", policy: "AUTO" });
  assert.deepEqual(guestSocket.sent.at(-1), { type: "board_policy", policy: "AUTO" }, "the room renders the new rule at once");
  assert.equal(roomState.stored.get("boardPolicy"), "AUTO", "the rule outlives the sockets that set it");

  const response = await room.fetch(new Request("https://cinema-room/policy"));
  assert.deepEqual(await response.json(), { policy: "AUTO" }, "the route can read the rule before it spends a model call");

  await room.fetch(upgrade("guest-3", "Esi"));
  const newcomer = roomState.sockets[2];
  assert.deepEqual(newcomer.sent.find((frame) => frame.type === "board_policy"), { type: "board_policy", policy: "AUTO" }, "a screen that joins later is told the same rule");
});

test("chat retry IDs are deduplicated per room and authenticated sender", async () => {
  const input = { sessionId: "retry-room", sender: { id: "student-1" }, content: "Keep my question", requestId: "retry-message-123" };
  const first = await writeCinemaMessage(input);
  const retry = await writeCinemaMessage(input);
  assert.equal(first.id, retry.id);
  assert.equal(state.messages.length, 1);
  const other = await writeCinemaMessage({ ...input, sender: { id: "student-2" } });
  assert.notEqual(other.id, first.id);
  assert.equal(state.messages.length, 2);
});

test("socket confirms persisted messages, and retries do not add a second row", async () => {
  const { room, state: roomState } = await newRoom();
  await room.fetch(upgrade("student-1", "Ama"));
  const [socket] = roomState.sockets;
  const frame = JSON.stringify({ type: "chat_message", message: "Question", requestId: "delivery-12345" });
  await room.webSocketMessage(socket, frame);
  await room.webSocketMessage(socket, frame);
  assert.equal(state.messages.length, 1);
  const acknowledgements = socket.sent.filter(frame => frame.type === "chat_ack");
  assert.equal(acknowledgements.length, 2);
  assert.equal(acknowledgements[0].message.id, acknowledgements[1].message.id);
});

test("a storage outage is reported instead of pretending the message was delivered", async () => {
  const { room, state: roomState } = await newRoom();
  await room.fetch(upgrade("student-1", "Ama"));
  const [socket] = roomState.sockets;
  socket.sent.length = 0;
  delete process.env.TURSO_DATABASE_URL;
  await room.webSocketMessage(socket, JSON.stringify({ type: "chat_message", message: "Keep this draft", requestId: "failed-delivery-123" }));
  assert.equal(socket.sent.filter(frame => frame.type === "chat_ack" || frame.type === "chat").length, 0);
  assert.equal(socket.closed.code, 1013, "access cannot be assumed while membership storage is unavailable");
});

test("replies preserve their immediate parent and root thread in the same room", async () => {
  const root = await writeCinemaMessage({ sessionId: "thread-room", sender: { id: "s-1" }, content: "Root" });
  const reply = await writeCinemaMessage({ sessionId: "thread-room", sender: { id: "s-2" }, content: "Reply", parentMessageId: root.id });
  const nested = await writeCinemaMessage({ sessionId: "thread-room", sender: { id: "s-3" }, content: "Nested", parentMessageId: reply.id });
  assert.equal(reply.parentMessageId, root.id); assert.equal(nested.parentMessageId, reply.id);
  assert.equal(reply.threadId, root.id); assert.equal(nested.threadId, root.id);
  const page = await cinemaMessagePage({ sessionId: "thread-room", threadId: root.id });
  assert.deepEqual(page.messages.map(message => message.id), [root.id, reply.id, nested.id]);
  await assert.rejects(writeCinemaMessage({ sessionId: "other-room", sender: { id: "s-1" }, content: "Cross room", parentMessageId: root.id }), error => error.status === 404);
});

test("removed parent text is absent from history and reply previews while structure survives", async () => {
  const root = await writeCinemaMessage({ sessionId: "remove-room", sender: { id: "s-1", name: "Ama" }, content: "Remove this text" });
  const reply = await writeCinemaMessage({ sessionId: "remove-room", sender: { id: "s-2" }, content: "A reply", parentMessageId: root.id });
  await removeCinemaMessage(root.id, "remove-room");
  const page = await cinemaMessagePage({ sessionId: "remove-room", threadId: root.id, limit: 1 });
  assert.equal(page.messages[0].id, reply.id);
  assert.equal(page.context[0].id, root.id); assert.equal(page.context[0].removed, true);
  assert.equal(page.context[0].content, ""); assert.equal(page.context[0].senderName, "");
  assert.equal(JSON.stringify(page).includes("Remove this text"), false);
  await assert.rejects(writeCinemaMessage({ sessionId: "remove-room", sender: { id: "s-1" }, content: "Reply", parentMessageId: root.id }), error => error.status === 404);
});

test("monotonic pagination covers timestamp ties, offline gaps and deleted messages", async () => {
  for (let index = 0; index < 125; index++) await writeCinemaMessage({ sessionId: "page-room", sender: { id: "s-1" }, content: `Message ${index}` });
  database.db.prepare("UPDATE cinema_messages SET created_at='2026-11-09T00:00:00.000Z' WHERE session_id=?").run("page-room");
  const latest = await cinemaMessagePage({ sessionId: "page-room" });
  assert.equal(latest.messages.length, 50); assert.equal(latest.hasMore, true);
  const older = await cinemaMessagePage({ sessionId: "page-room", before: latest.before });
  const oldest = await cinemaMessagePage({ sessionId: "page-room", before: older.before });
  assert.equal(oldest.messages.length, 25); assert.equal(oldest.hasMore, false);
  assert.equal(new Set([...oldest.messages, ...older.messages, ...latest.messages].map(message => message.id)).size, 125);
  const removed = latest.messages.at(-1); await removeCinemaMessage(removed.id, "page-room");
  const newMessage = await writeCinemaMessage({ sessionId: "page-room", sender: { id: "s-1" }, content: "After deletion" });
  assert.ok(newMessage.sequence > removed.sequence);
  let after = oldest.before - 1, through, collected = [];
  do {
    const page = await cinemaMessagePage({ sessionId: "page-room", after, through });
    through ??= page.through; collected.push(...page.messages); after = page.after;
    if (!page.hasMore) break;
  } while (true);
  assert.equal(collected.length, 126); assert.equal(collected.find(message => message.id === removed.id).removed, true);
});

test("video references remain immutable through playlist changes and acknowledgement retries", async () => {
  const original = { sourceType: "UPLOAD", videoId: "first-file" }, current = { sourceType: "UPLOAD", videoId: "second-file" };
  const input = { sessionId: "video-room", sender: { id: "s-1" }, content: "This step", atSeconds: 0, requestId: "video-reference-123", video: original, expectedVideo: original };
  const first = await writeCinemaMessage(input);
  assert.equal(first.atSeconds, 0); assert.deepEqual(first.video, original);
  const retry = await writeCinemaMessage({ ...input, video: current });
  assert.equal(retry.id, first.id); assert.deepEqual(retry.video, original);
  await assert.rejects(writeCinemaMessage({ ...input, requestId: "new-reference-123", video: current }), error => error.status === 409);
  assert.deepEqual((await readCinemaMessage(first.id)).video, original);
});

test("thread and source context are validated on the wire and stamped by the room", async () => {
  assert.equal(parseClientMessage(JSON.stringify({ type: "chat_message", message: "Hi", parentMessageId: "../other" })), null);
  assert.equal(parseClientMessage(JSON.stringify({ type: "chat_message", message: "Hi", video: { sourceType: "UPLOAD", videoId: "../object" } })), null);
  const { room, state: roomState } = await newRoom(); await room.fetch(upgrade());
  const [socket] = roomState.sockets;
  await room.webSocketMessage(socket, JSON.stringify({ type: "chat_message", message: "Root", timestamp: 5, requestId: "root-wire-12345" }));
  const root = socket.sent.filter(frame => frame.type === "chat").at(-1).message;
  assert.deepEqual(root.video, { sourceType: "YOUTUBE", videoId: SNAPSHOT.videoId });
  await room.webSocketMessage(socket, JSON.stringify({ type: "chat_message", message: "Reply", parentMessageId: root.id, timestamp: 6, requestId: "reply-wire-1234" }));
  const reply = socket.sent.filter(frame => frame.type === "chat").at(-1).message;
  assert.equal(reply.parentMessageId, root.id); assert.equal(reply.threadId, root.id);
});

test("legacy messages migrate in their original order and keep unbound timestamps static", async () => {
  await writeCinemaMessage({ sessionId: "initialize", sender: { id: "s-1" }, content: "Initialize schema" });
  const insert = database.db.prepare("INSERT INTO cinema_messages(id,session_id,sender_id,sender_name,content,metadata,created_at) VALUES (?,?,?,?,?,?,?)");
  insert.run("legacy-z", "legacy-room", "s-1", "Ama", "First", '{"atSeconds":320}', "2026-11-09T00:00:00.000Z");
  insert.run("legacy-a", "legacy-room", "s-1", "Ama", "Second", "", "2026-11-09T00:00:00.000Z");
  const { readFileSync } = await import("node:fs");
  database.db.exec(readFileSync(new URL("../sql/051_cinema_chat_threads.sql", import.meta.url), "utf8"));
  const page = await cinemaMessagePage({ sessionId: "legacy-room" });
  assert.deepEqual(page.messages.map(message => message.id), ["legacy-z", "legacy-a"]);
  assert.equal(page.messages[0].atSeconds, 320); assert.equal(page.messages[0].video, undefined);
  assert.equal(page.messages[0].removed, false);
});

test("a failure to persist ordering rolls back message content", async () => {
  await writeCinemaMessage({ sessionId: "initialize", sender: { id: "s-1" }, content: "Initialize schema" });
  database.db.exec("CREATE TRIGGER refuse_chat_order BEFORE INSERT ON cinema_message_order WHEN NEW.session_id='fail-room' BEGIN SELECT RAISE(ABORT,'Ordering storage failed'); END");
  try {
    await assert.rejects(writeCinemaMessage({ sessionId: "fail-room", sender: { id: "s-1" }, content: "Must not remain stored" }), /Ordering storage failed/);
    assert.equal(database.db.prepare("SELECT COUNT(*) AS n FROM cinema_messages WHERE session_id='fail-room'").get().n, 0);
  } finally { database.db.exec("DROP TRIGGER refuse_chat_order"); }
});

test("simultaneous acknowledgement retries persist one message and one ordering record", async () => {
  const input = { sessionId: "concurrent-room", sender: { id: "s-1" }, content: "One message", requestId: "simultaneous-retry-1234" };
  const messages = await Promise.all(Array.from({ length: 5 }, () => writeCinemaMessage(input)));
  assert.equal(new Set(messages.map(message => message.id)).size, 1);
  assert.equal(database.db.prepare("SELECT COUNT(*) AS n FROM cinema_messages WHERE session_id='concurrent-room'").get().n, 1);
  assert.equal(database.db.prepare("SELECT COUNT(*) AS n FROM cinema_message_order WHERE session_id='concurrent-room'").get().n, 1);
});

test("a room-wide overview stays unlinked through the real socket delivery path", async () => {
  const { room, state: roomState } = await newRoom(); await room.fetch(upgrade());
  const [socket] = roomState.sockets;
  await writeCinemaMessage({ sessionId: SNAPSHOT.roomId, sender: { id: "host-1" }, content: "Discussion of the first video", atSeconds: 10, video: { sourceType: "YOUTUBE", videoId: SNAPSHOT.videoId } });
  await writeCinemaMessage({ sessionId: SNAPSHOT.roomId, sender: { id: "host-1" }, content: "Discussion of an earlier video", atSeconds: 12, video: { sourceType: "UPLOAD", videoId: "another-upload" } });
  await room.webSocketMessage(socket, JSON.stringify({ type: "chat_message", message: "@Cinema catch up on the recent conversation", requestId: "room-wide-overview-123", timestamp: null }));
  const frame = socket.sent.at(-1);
  assert.equal(frame.type, "chat"); assert.equal(frame.message.atSeconds, null); assert.equal(frame.message.video, undefined);
  const { readCinemaOverviewContext } = await vite.ssrLoadModule("/lib/cinema-engine/chat-overviews.ts");
  const context = await readCinemaOverviewContext(frame.message, "CATCH_UP");
  assert.equal(context.sources.length, 2); assert.equal(context.scope.video, undefined);
});
