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

  // The ceiling moved up for WebRTC handshakes, so a padded frame has to be
  // past the new 16 KB limit before the object refuses it.
  await room.webSocketMessage(socket, JSON.stringify({ type: "ping", padding: "x".repeat(20_000) }));
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

test("a removed guest is closed and dropped from presence, and never the host", async () => {
  const { room, state } = await newRoom();
  await room.fetch(upgrade());
  await room.fetch(upgrade({ "x-cinema-attachment": identity("guest-2", "Kwesi Guest") }));
  const [hostSocket, guestSocket] = state.sockets;

  const noGuest = await room.fetch(new Request("https://cinema-room/remove-member", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  }));
  assert.equal(noGuest.status, 400, "a removal has to name the guest");

  const host = await room.fetch(new Request("https://cinema-room/remove-member", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ studentId: "host-1" }),
  }));
  assert.equal(host.status, 400, "the host is not a guest of their own room");

  const response = await room.fetch(new Request("https://cinema-room/remove-member", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ studentId: "guest-2" }),
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(await response.text()), { ok: true, closed: 1 });
  assert.deepEqual(guestSocket.sent.at(-1), { type: "closed", reason: "The host removed you from this room." });
  assert.deepEqual(guestSocket.closed, { code: 1000, reason: "The host removed you from this room" });
  assert.deepEqual(last(hostSocket, "presence").members.map((member) => member.studentId), ["host-1"], "the room stops listing the removed guest");
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

// --- M8: microphone, camera and the recorder's announcement ---------------

test("a handshake leg reaches its one target and carries the room's word for the sender", async () => {
  const { room, state } = await newRoom();
  await room.fetch(upgrade());
  await room.fetch(upgrade({ "x-cinema-attachment": identity("guest-2", "Kwesi Guest") }));
  const [hostSocket, guestSocket] = state.sockets;

  await room.webSocketMessage(hostSocket, JSON.stringify({ type: "signal", to: "guest-2", payload: { kind: "offer", sdp: "v=0\r\nid:offer-1" } }));

  const delivered = last(guestSocket, "signal");
  assert.equal(delivered.from, "host-1", "the object stamps the sender, never the payload");
  assert.deepEqual(delivered.payload, { kind: "offer", sdp: "v=0\r\nid:offer-1" });
  assert.equal(last(hostSocket, "signal"), undefined, "the sender does not receive its own leg");
  assert.equal(last(hostSocket, "error"), undefined);
});

test("a signal for somebody who already left is dropped, not answered", async () => {
  const { room, state } = await newRoom();
  await room.fetch(upgrade());
  const hostSocket = state.sockets[0];
  const before = hostSocket.sent.length;

  await room.webSocketMessage(hostSocket, JSON.stringify({ type: "signal", to: "ghost-9", payload: { kind: "candidate", candidate: "candidate:1" } }));

  assert.equal(hostSocket.sent.length, before, "a peer race is ordinary; an error would be noise");
});

test("an SDP offer larger than the old chat cap still crosses the room", async () => {
  const { room, state } = await newRoom();
  await room.fetch(upgrade());
  await room.fetch(upgrade({ "x-cinema-attachment": identity("guest-2", "Kwesi Guest") }));
  const [hostSocket, guestSocket] = state.sockets;
  const sdp = `v=0\r\n${"a=candidate:".padEnd(6_000, "x")}`;

  await room.webSocketMessage(hostSocket, JSON.stringify({ type: "signal", to: "guest-2", payload: { kind: "answer", sdp } }));
  assert.equal(last(guestSocket, "signal").payload.sdp, sdp);
});

test("a frame past the socket's ceiling is refused before it is parsed", async () => {
  const { room, state } = await newRoom();
  await room.fetch(upgrade());
  const hostSocket = state.sockets[0];

  await room.webSocketMessage(hostSocket, JSON.stringify({ type: "signal", to: "guest-2", payload: { kind: "offer", sdp: "x".repeat(20_000) } }));
  assert.equal(last(hostSocket, "error").message, "That message is too large.");
  assert.equal(state.sockets.length, 1);
});

test("a payload that overflows the signal allowance is refused, not relayed", async () => {
  const { room, state } = await newRoom();
  await room.fetch(upgrade());
  await room.fetch(upgrade({ "x-cinema-attachment": identity("guest-2", "Kwesi Guest") }));
  const [hostSocket, guestSocket] = state.sockets;

  await room.webSocketMessage(hostSocket, JSON.stringify({ type: "signal", to: "guest-2", payload: { kind: "offer", sdp: "x".repeat(13_000) } }));
  assert.equal(last(guestSocket, "signal"), undefined);
  assert.equal(last(hostSocket, "error").message, "That is not a message this room understands.");
});

test("mic and camera switches are written to the attachment and shown in presence", async () => {
  const { room, state } = await newRoom();
  await room.fetch(upgrade());
  await room.fetch(upgrade({ "x-cinema-attachment": identity("guest-2", "Kwesi Guest") }));
  const [hostSocket, guestSocket] = state.sockets;

  await room.webSocketMessage(guestSocket, JSON.stringify({ type: "media_state", mic: true, camera: false }));
  const seen = last(hostSocket, "presence").members.find((member) => member.studentId === "guest-2");
  assert.equal(seen.mic, true);
  assert.equal(seen.camera, false);
  // The attachment is the record: presence reads it back after a hibernation.
  assert.equal(state.sockets[1].attachment.mic, true);
  assert.equal(state.sockets[1].attachment.camera, false);
});

test("a recording announcement is broadcast while it runs and cleared when it stops", async () => {
  const { room, state } = await newRoom();
  await room.fetch(upgrade());
  await room.fetch(upgrade({ "x-cinema-attachment": identity("guest-2", "Kwesi Guest") }));
  const [hostSocket, guestSocket] = state.sockets;

  await room.webSocketMessage(guestSocket, JSON.stringify({ type: "recording_state", active: true }));
  assert.equal(last(hostSocket, "presence").members.find((member) => member.studentId === "guest-2").recording, true);

  await room.webSocketMessage(guestSocket, JSON.stringify({ type: "recording_state", active: false }));
  assert.equal(last(hostSocket, "presence").members.find((member) => member.studentId === "guest-2").recording, false);
});

test("a sender cannot claim another member's identity in a signal frame", async () => {
  const { room, state } = await newRoom();
  await room.fetch(upgrade());
  await room.fetch(upgrade({ "x-cinema-attachment": identity("guest-2", "Kwesi Guest") }));
  const [, guestSocket] = state.sockets;          // guest-2
  const [, secondSocket] = state.sockets;
  await room.fetch(upgrade({ "x-cinema-attachment": identity("guest-3", "Third") }));

  await room.webSocketMessage(secondSocket, JSON.stringify({
    type: "signal",
    from: "host-1",
    to: "guest-3",
    payload: { kind: "offer", sdp: "v=0\r\nspoof" },
  }));
  const delivered = last(state.sockets[2], "signal");
  assert.equal(delivered.from, "guest-2", "the attachment decides who spoke");
  assert.equal(last(guestSocket, "signal"), undefined);
});

test("a malformed media or recording switch is dropped rather than half-applied", async () => {
  const { room, state } = await newRoom();
  await room.fetch(upgrade());
  const hostSocket = state.sockets[0];

  await room.webSocketMessage(hostSocket, JSON.stringify({ type: "media_state", mic: "yes", camera: false }));
  await room.webSocketMessage(hostSocket, JSON.stringify({ type: "recording_state", active: "on" }));

  assert.equal(state.sockets[0].attachment.mic, false);
  assert.equal(state.sockets[0].attachment.recording, false);
  assert.equal(last(hostSocket, "presence").members[0].mic, false);
});

test("an AI board reaches every open screen, and a cleared one leaves by id", async () => {
  const { room, state } = await newRoom();
  await room.fetch(upgrade());
  await room.fetch(upgrade({ "x-cinema-attachment": identity("guest-2", "Kwesi Guest") }));
  const [hostSocket, guestSocket] = state.sockets;

  const board = {
    id: "board-1", roomId: "room-1", requesterId: "guest-2", requesterName: "Kwesi Guest",
    title: "TCP handshake", summary: "SYN, SYN-ACK, ACK.", topic: "FLOWCHART", lab: false,
    blocks: [{ kind: "text", text: "Sequence numbers are agreed first." }], atSeconds: 12,
    createdAt: "2026-09-21T09:00:00.000Z",
  };
  const published = await room.fetch(new Request("https://cinema-room/whiteboard", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ board }),
  }));
  assert.equal(published.status, 200);
  assert.deepEqual(last(hostSocket, "whiteboard").board, board);
  assert.deepEqual(last(guestSocket, "whiteboard").board, board);

  // The route must never broadcast something it could not render: an object
  // without an id or a block list is refused before it reaches a screen.
  const refused = await room.fetch(new Request("https://cinema-room/whiteboard", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ board: { id: 7, blocks: "no" } }),
  }));
  assert.equal(refused.status, 400);
  assert.equal(last(hostSocket, "whiteboard").board.id, "board-1", "the bad payload did not replace the good one");

  const removed = await room.fetch(new Request("https://cinema-room/whiteboard-remove", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "board-1" }),
  }));
  assert.equal(removed.status, 200);
  assert.equal(last(hostSocket, "whiteboard_removed").id, "board-1");
  assert.equal(last(guestSocket, "whiteboard_removed").id, "board-1");
  assert.equal((await room.fetch(new Request("https://cinema-room/whiteboard-remove", { method: "POST" }))).status, 400);
});
