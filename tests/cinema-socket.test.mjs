import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => vite.close());

// workerd's Response accepts a 101 carrying `webSocket`; Node's rejects any
// status outside 200-599. The double permits exactly that case — everything
// else, including Response.json, still comes from the real constructor.
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

/** A WebSocket good enough for the Durable Object: it records, it never talks back. */
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

/**
 * A Durable Object state double: sockets are attached here the way the runtime
 * attaches them, and storage is a Map that survives the object's own lifetime.
 */
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
    /** The runtime drops the socket before it calls webSocketClose. */
    remove(socket) {
      const index = sockets.indexOf(socket);
      if (index >= 0) sockets.splice(index, 1);
    },
  };
}

// The DO reads WebSocketPair from the global, exactly as it does in workerd.
const pairs = [];
globalThis.WebSocketPair = class WebSocketPair {
  constructor() {
    const client = fakeSocket();
    const server = fakeSocket();
    pairs.push({ client, server });
    return { 0: client, 1: server };
  }
};

const SNAPSHOT = { roomId: "room-1", hostStudentId: "host-1", title: "Signals", sourceType: "YOUTUBE", videoId: "dQw4w9WgXcQ" };
const identity = (studentId, displayName) => encodeURIComponent(JSON.stringify({ studentId, displayName }));
const snapshotHeader = () => encodeURIComponent(JSON.stringify(SNAPSHOT));

function upgrade(headers = {}) {
  return new Request("https://cinema-room/socket", {
    headers: {
      upgrade: "websocket",
      "x-cinema-attachment": identity("host-1", "Ama Host"),
      "x-cinema-room": snapshotHeader(),
      ...headers,
    },
  });
}

async function newRoom() {
  const { CinemaRoom } = await vite.ssrLoadModule("/worker/cinema-room.ts");
  const state = fakeState();
  const room = new CinemaRoom(state);
  return { room, state };
}

/** The last frame of one type: presence and playback travel the same wire. */
function last(socket, type) {
  return [...socket.sent].reverse().find((frame) => frame.type === type);
}

test("an authorised socket is accepted and told who is already here", async () => {
  const { room, state } = await newRoom();
  const response = await room.fetch(upgrade());

  assert.equal(response.status, 101);
  assert.equal(state.sockets.length, 1, "the socket is attached for hibernation");
  assert.equal(state.sockets[0].attachment.studentId, "host-1");
  // The snapshot is kept so an object that wakes from hibernation with no
  // memory still knows whose room this is.
  assert.deepEqual(state.stored.get("room"), SNAPSHOT);

  const [frame] = state.sockets[0].sent;
  assert.equal(frame.type, "presence");
  assert.equal(frame.members.length, 1);
  assert.equal(frame.members[0].studentId, "host-1");
  assert.equal(frame.members[0].displayName, "Ama Host");
  assert.equal(frame.members[0].isHost, true);
  assert.ok(Number.isFinite(frame.members[0].since));
});

test("the arrival of a second student is broadcast to both, host first", async () => {
  const { room, state } = await newRoom();
  await room.fetch(upgrade());
  await room.fetch(upgrade({ "x-cinema-attachment": identity("guest-2", "Kwesi Guest") }));

  const [hostSocket, guestSocket] = state.sockets;
  assert.deepEqual(last(hostSocket, "presence").members.map((member) => member.studentId), ["host-1", "guest-2"]);
  assert.deepEqual(last(guestSocket, "presence").members.map((member) => member.studentId), ["host-1", "guest-2"]);
  assert.equal(last(hostSocket, "presence").members[0].isHost, true);
  assert.equal(last(hostSocket, "presence").members[1].isHost, false);
});

test("closing a tab leaves the room, and everyone still attached sees it", async () => {
  const { room, state } = await newRoom();
  await room.fetch(upgrade());
  await room.fetch(upgrade({ "x-cinema-attachment": identity("guest-2", "Kwesi Guest") }));
  const [hostSocket, guestSocket] = state.sockets;

  // The runtime still lists the closing socket while webSocketClose runs, so
  // it is deliberately not removed here: the handler must exclude it itself.
  await room.webSocketClose(guestSocket);

  assert.deepEqual(last(hostSocket, "presence").members.map((member) => member.studentId), ["host-1"]);

  state.remove(guestSocket);
});

test("one student with two tabs is one person in the room", async () => {
  const { room, state } = await newRoom();
  await room.fetch(upgrade());
  await room.fetch(upgrade());

  const [firstSocket, secondSocket] = state.sockets;
  assert.equal(last(secondSocket, "presence").members.length, 1);
  assert.equal(last(firstSocket, "presence").members.length, 1);
});

test("a ping is answered, and anything else is refused without touching the room", async () => {
  const { room, state } = await newRoom();
  await room.fetch(upgrade());
  const [socket] = state.sockets;

  await room.webSocketMessage(socket, JSON.stringify({ type: "ping" }));
  assert.equal(socket.sent.at(-1).type, "pong");
  assert.ok(Number.isFinite(socket.sent.at(-1).at));

  await room.webSocketMessage(socket, "not json at all");
  assert.equal(socket.sent.at(-1).type, "error");

  // A frame this version does not know is refused rather than guessed at.
  await room.webSocketMessage(socket, JSON.stringify({ type: "dance" }));
  assert.equal(socket.sent.at(-1).type, "error");

  await room.webSocketMessage(socket, JSON.stringify({ type: "ping", padding: "x".repeat(5_000) }));
  assert.equal(socket.sent.at(-1).type, "error");
});

test("closing the room tells every socket, then closes it", async () => {
  const { room, state } = await newRoom();
  await room.fetch(upgrade());
  await room.fetch(upgrade({ "x-cinema-attachment": identity("guest-2", "Kwesi Guest") }));
  const [hostSocket, guestSocket] = state.sockets;

  const response = await room.fetch(new Request("https://cinema-room/close", { method: "POST" }));
  assert.equal(response.status, 200);
  for (const socket of [hostSocket, guestSocket]) {
    assert.equal(socket.sent.at(-1).type, "closed");
    assert.deepEqual(socket.closed, { code: 1000, reason: "The room ended" });
  }
});

test("a removed message is taken off every open screen", async () => {
  const { room, state } = await newRoom();
  await room.fetch(upgrade());
  await room.fetch(upgrade({ "x-cinema-attachment": identity("guest-2", "Kwesi Guest") }));
  const [hostSocket, guestSocket] = state.sockets;

  const response = await room.fetch(new Request("https://cinema-room/purge-message", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messageId: "message-1" }),
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(await response.text()), { ok: true, id: "message-1" });
  for (const socket of [hostSocket, guestSocket]) {
    assert.deepEqual(socket.sent.at(-1), { type: "chat_removed", id: "message-1" });
  }

  // Nothing to remove is a refusal, not a broadcast of an empty id.
  const withoutId = await room.fetch(new Request("https://cinema-room/purge-message", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  }));
  assert.equal(withoutId.status, 400);
  assert.equal(hostSocket.sent.at(-1).type, "chat_removed");
});

test("a finished upload switches every open screen, and the snapshot after it", async () => {
  const { room, state } = await newRoom();
  await room.fetch(upgrade());
  await room.fetch(upgrade({ "x-cinema-attachment": identity("guest-2", "Kwesi Guest") }));
  const [hostSocket, guestSocket] = state.sockets;

  const response = await room.fetch(new Request("https://cinema-room/source", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceType: "UPLOAD", videoId: "upload-1" }),
  }));
  assert.equal(response.status, 200);
  for (const socket of [hostSocket, guestSocket]) {
    assert.deepEqual(socket.sent.at(-1), { type: "source", sourceType: "UPLOAD", videoId: "upload-1" });
  }
  // The object's own snapshot moves with the row, so a wake still knows which
  // video the room plays.
  assert.equal(state.stored.get("room").sourceType, "UPLOAD");
  assert.equal(state.stored.get("room").videoId, "upload-1");

  // A socket that connects afterwards carries the snapshot the route read from
  // the row — the upload — and the object keeps it.
  const { CinemaRoom } = await vite.ssrLoadModule("/worker/cinema-room.ts");
  const fresh = new CinemaRoom(state);
  await fresh.fetch(upgrade({
    "x-cinema-attachment": identity("guest-3", "New Guest"),
    "x-cinema-room": encodeURIComponent(JSON.stringify({ ...SNAPSHOT, sourceType: "UPLOAD", videoId: "upload-1" })),
  }));
  assert.equal(state.stored.get("room").sourceType, "UPLOAD");
  assert.equal(state.stored.get("room").videoId, "upload-1");

  const refused = await room.fetch(new Request("https://cinema-room/source", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sourceType: "PODCAST", videoId: "x" }),
  }));
  assert.equal(refused.status, 400);
  assert.equal(state.stored.get("room").sourceType, "UPLOAD", "a refused source changed nothing");
});

test("the object answers whether the room is empty, and since when", async () => {
  const { room, state } = await newRoom();
  await room.fetch(upgrade());
  const [socket] = state.sockets;

  const before = await (await room.fetch(new Request("https://cinema-room/presence"))).json();
  assert.equal(before.members.length, 1);
  assert.equal(before.emptySince, 0, "an attached room is not idle");

  await room.webSocketClose(socket);
  state.remove(socket);
  const after = await (await room.fetch(new Request("https://cinema-room/presence"))).json();
  assert.equal(after.members.length, 0);
  assert.ok(after.emptySince > 0, "the instant the last socket left is recorded for the cleanup job");

  await room.fetch(upgrade());
  const refilled = await (await room.fetch(new Request("https://cinema-room/presence"))).json();
  assert.equal(refilled.members.length, 1);
  assert.equal(refilled.emptySince, 0, "a new arrival clears the idle marker");
});

test("a socket that is not an authorised upgrade never becomes one", async () => {
  const { room, state } = await newRoom();

  assert.equal((await room.fetch(new Request("https://cinema-room/socket"))).status, 426, "plain HTTP is refused");
  assert.equal((await room.fetch(upgrade({ "x-cinema-attachment": "" }))).status, 400, "no student, no socket");
  assert.equal((await room.fetch(upgrade({ "x-cinema-room": "" }))).status, 400, "no room, no socket");
  assert.equal((await room.fetch(upgrade({ "x-cinema-attachment": "%E0%A4%A" }))).status, 400, "malformed header is a refusal, not a crash");
  assert.equal((await room.fetch(new Request("https://cinema-room/other"))).status, 404);
  assert.equal(state.sockets.length, 0, "none of the refusals attached anything");
});

test("the room tells every newcomer where the video is", async () => {
  const { room, state } = await newRoom();
  await room.fetch(upgrade());
  const [hostSocket] = state.sockets;

  const initial = hostSocket.sent.find((frame) => frame.type === "state");
  assert.deepEqual(initial.playback, { positionSeconds: 0, isPlaying: false, updatedAt: 0, durationSeconds: 0 });

  await room.fetch(upgrade({ "x-cinema-attachment": identity("guest-2", "Kwesi Guest") }));
  const [, guestSocket] = state.sockets;
  assert.equal(guestSocket.sent.filter((frame) => frame.type === "state").length, 1, "the newcomer is told");
  assert.equal(hostSocket.sent.filter((frame) => frame.type === "state").length, 1, "and nobody else is");
});

test("the host's play lands on every socket with the object's own instant", async () => {
  const { room, state } = await newRoom();
  await room.fetch(upgrade());
  await room.fetch(upgrade({ "x-cinema-attachment": identity("guest-2", "Kwesi Guest") }));
  const [hostSocket, guestSocket] = state.sockets;

  await room.webSocketMessage(hostSocket, JSON.stringify({ type: "play", time: 42.5, duration: 300 }));

  const hostEcho = hostSocket.sent.at(-1);
  const guestCopy = guestSocket.sent.at(-1);
  assert.equal(hostEcho.type, "state");
  assert.equal(hostEcho.playback.positionSeconds, 42.5);
  assert.equal(hostEcho.playback.isPlaying, true);
  assert.equal(hostEcho.playback.durationSeconds, 300);
  assert.ok(hostEcho.playback.updatedAt > 0, "the instant is the object's, not the sender's");
  assert.deepEqual(guestCopy, hostEcho);
  // The anchor is what advanced; the position itself is not rewritten.
  assert.equal(state.stored.get("playback").positionSeconds, 42.5);
});

test("a seek keeps the room's play state, and a pause keeps its position", async () => {
  const { room, state } = await newRoom();
  await room.fetch(upgrade());
  const [socket] = state.sockets;

  await room.webSocketMessage(socket, JSON.stringify({ type: "play", time: 10, duration: 300 }));
  await room.webSocketMessage(socket, JSON.stringify({ type: "seek", time: 120, duration: 300 }));
  assert.equal(socket.sent.at(-1).playback.positionSeconds, 120);
  assert.equal(socket.sent.at(-1).playback.isPlaying, true, "a seek mid-playback does not stop the video");

  await room.webSocketMessage(socket, JSON.stringify({ type: "pause", time: 121.5 }));
  assert.equal(socket.sent.at(-1).playback.isPlaying, false);
  assert.equal(socket.sent.at(-1).playback.positionSeconds, 121.5);
});

test("a member's action is refused, and the room does not move", async () => {
  const { room, state } = await newRoom();
  await room.fetch(upgrade());
  await room.fetch(upgrade({ "x-cinema-attachment": identity("guest-2", "Kwesi Guest") }));
  const [hostSocket, guestSocket] = state.sockets;

  await room.webSocketMessage(guestSocket, JSON.stringify({ type: "play", time: 50 }));

  assert.equal(guestSocket.sent.at(-1).type, "error");
  assert.match(guestSocket.sent.at(-1).message, /host/i);
  assert.equal(hostSocket.sent.some((frame) => frame.type === "state" && frame.playback.positionSeconds === 50), false, "nothing reached the room");
});

test("an action built on an old state is answered with the current one, not applied", async () => {
  const { room, state } = await newRoom();
  await room.fetch(upgrade());
  const [socket] = state.sockets;

  await room.webSocketMessage(socket, JSON.stringify({ type: "play", time: 10, duration: 300 }));
  const accepted = socket.sent.at(-1).playback;
  await room.webSocketMessage(socket, JSON.stringify({ type: "seek", time: 200, stateAt: accepted.updatedAt - 5_000 }));

  const answer = socket.sent.at(-1);
  assert.equal(answer.type, "state");
  assert.equal(answer.playback.positionSeconds, 10, "the stale action was dropped, not applied");
  assert.equal(answer.playback.updatedAt, accepted.updatedAt);
});

test("a position outside the video is refused when the room knows its length", async () => {
  const { room, state } = await newRoom();
  await room.fetch(upgrade());
  const [socket] = state.sockets;

  await room.webSocketMessage(socket, JSON.stringify({ type: "play", time: 10, duration: 300 }));
  await room.webSocketMessage(socket, JSON.stringify({ type: "seek", time: 400, duration: 300 }));
  assert.equal(socket.sent.at(-1).type, "error");
  assert.equal(state.stored.get("playback").positionSeconds, 10);

  await room.webSocketMessage(socket, JSON.stringify({ type: "seek", time: -3 }));
  assert.equal(socket.sent.at(-1).type, "error");
  assert.equal(state.stored.get("playback").positionSeconds, 10);
});

test("a room that woke from hibernation still knows where the video is", async () => {
  const { room, state } = await newRoom();
  await room.fetch(upgrade());
  await room.webSocketMessage(state.sockets[0], JSON.stringify({ type: "play", time: 77, duration: 900 }));
  const accepted = state.stored.get("playback");

  // A new instance over the same storage is what a wake looks like: no memory,
  // all of the disk. The next socket must still be told the right position.
  const { CinemaRoom } = await vite.ssrLoadModule("/worker/cinema-room.ts");
  const woken = new CinemaRoom(state);
  await woken.fetch(upgrade({ "x-cinema-attachment": identity("guest-3", "New Guest") }));
  const newcomer = state.sockets.at(-1);
  assert.deepEqual(newcomer.sent.find((frame) => frame.type === "state").playback, accepted);
});
