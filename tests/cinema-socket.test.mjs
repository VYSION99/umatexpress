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
  assert.deepEqual(hostSocket.sent.at(-1).members.map((member) => member.studentId), ["host-1", "guest-2"]);
  assert.deepEqual(guestSocket.sent.at(-1).members.map((member) => member.studentId), ["host-1", "guest-2"]);
  assert.equal(hostSocket.sent.at(-1).members[0].isHost, true);
  assert.equal(hostSocket.sent.at(-1).members[1].isHost, false);
});

test("closing a tab leaves the room, and everyone still attached sees it", async () => {
  const { room, state } = await newRoom();
  await room.fetch(upgrade());
  await room.fetch(upgrade({ "x-cinema-attachment": identity("guest-2", "Kwesi Guest") }));
  const [hostSocket, guestSocket] = state.sockets;

  // The runtime still lists the closing socket while webSocketClose runs, so
  // it is deliberately not removed here: the handler must exclude it itself.
  await room.webSocketClose(guestSocket);

  assert.deepEqual(hostSocket.sent.at(-1).members.map((member) => member.studentId), ["host-1"]);
  assert.equal(hostSocket.sent.at(-1).type, "presence");

  state.remove(guestSocket);
});

test("one student with two tabs is one person in the room", async () => {
  const { room, state } = await newRoom();
  await room.fetch(upgrade());
  await room.fetch(upgrade());

  const [firstSocket, secondSocket] = state.sockets;
  assert.equal(secondSocket.sent.at(-1).members.length, 1);
  assert.equal(firstSocket.sent.at(-1).members.length, 1);
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

  // A playback action is M3's to accept; until then it is dropped, not queued.
  await room.webSocketMessage(socket, JSON.stringify({ type: "seek", time: 120 }));
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

test("a socket that is not an authorised upgrade never becomes one", async () => {
  const { room, state } = await newRoom();

  assert.equal((await room.fetch(new Request("https://cinema-room/socket"))).status, 426, "plain HTTP is refused");
  assert.equal((await room.fetch(upgrade({ "x-cinema-attachment": "" }))).status, 400, "no student, no socket");
  assert.equal((await room.fetch(upgrade({ "x-cinema-room": "" }))).status, 400, "no room, no socket");
  assert.equal((await room.fetch(upgrade({ "x-cinema-attachment": "%E0%A4%A" }))).status, 400, "malformed header is a refusal, not a crash");
  assert.equal((await room.fetch(new Request("https://cinema-room/other"))).status, 404);
  assert.equal(state.sockets.length, 0, "none of the refusals attached anything");
});
