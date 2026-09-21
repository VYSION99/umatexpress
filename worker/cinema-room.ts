/**
 * The Cinema room Durable Object: one object per room, named by the room id.
 *
 * Sockets are hibernatable. A study room can sit open for an hour with nobody
 * typing, and a live handler would be billed for every one of those seconds;
 * with `acceptWebSocket` the object is evicted between messages and woken by
 * the next frame, while the sockets stay attached. Presence is therefore read
 * from the socket attachments — the one source that survives hibernation —
 * rather than from a map in memory that would vanish with the instance.
 *
 * Like the rate limiter, this file deliberately avoids `cloudflare:workers`
 * imports so the class can be unit-tested with plain doubles.
 */
import {
  CINEMA_FRAME_MAX_BYTES,
  CINEMA_PLAYBACK_START,
  parseClientMessage,
  type CinemaChatMessage,
  type CinemaChatMessageInput,
  type CinemaMediaStateInput,
  type CinemaPlaybackAction,
  type CinemaPlaybackState,
  type CinemaPresenceMember,
  type CinemaRecordingStateInput,
  type CinemaServerMessage,
  type CinemaSignalInput,
} from "@/lib/cinema-engine/protocol";
import type { CinemaWhiteboardView } from "@/lib/cinema-engine/whiteboard-scene";
import { CINEMA_CHAT_REPLAY_LIMIT, recentCinemaMessages, writeCinemaMessage } from "@/lib/cinema-engine/messages";
import { acceptableTime, isStaleAction } from "@/lib/cinema-engine/sync";
import { logEvent } from "@/lib/observability";
import { rateLimitSubject } from "@/lib/rate-limit";

/** What the Worker route learned from the database before it forwarded here. */
export type CinemaRoomSnapshot = {
  roomId: string;
  hostStudentId: string;
  title: string;
  sourceType: string;
  videoId: string;
};

/** What is written onto each accepted socket, and read back after a wake. */
export type CinemaSocketAttachment = {
  studentId: string;
  displayName: string;
  since: number;
  /** Media switches live on the attachment so they survive hibernation. */
  mic: boolean;
  camera: boolean;
  recording: boolean;
};

export type CinemaRoomSocket = {
  send(message: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
};

export type CinemaRoomStorage = {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
};

export type CinemaRoomState = {
  acceptWebSocket(socket: CinemaRoomSocket): void;
  getWebSockets(): CinemaRoomSocket[];
  storage: CinemaRoomStorage;
};

type WebSocketPairConstructor = new () => { 0: CinemaRoomSocket; 1: CinemaRoomSocket };

const ROOM_KEY = "room";
const PLAYBACK_KEY = "playback";
const EMPTY_KEY = "emptySince";
const CLOSE_NORMAL = 1000;
/**
 * The frame ceiling. A handshake leg is a few kilobytes, which is why the old
 * four-kilobyte cap moved up when M8 began relaying them.
 */
const MAX_MESSAGE_BYTES = CINEMA_FRAME_MAX_BYTES;
/** A person types far slower than this; a script must not be able to flood. */
const CHAT_LIMIT = 8;
const CHAT_WINDOW_MS = 10_000;
/**
 * A handshake spends a dozen frames and then goes quiet; this bounds a peer
 * that tries to use the relay as a message bus.
 */
const SIGNAL_LIMIT = 300;
const SIGNAL_WINDOW_MS = 60_000;
/** Flipping a switch is a person's action, not a stream. */
const STATE_LIMIT = 60;
const STATE_WINDOW_MS = 10_000;

function readAttachment(socket: CinemaRoomSocket): CinemaSocketAttachment | null {
  const raw = socket.deserializeAttachment();
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<CinemaSocketAttachment>;
  if (typeof value.studentId !== "string" || !value.studentId) return null;
  return {
    studentId: value.studentId,
    displayName: typeof value.displayName === "string" ? value.displayName.slice(0, 80) : "",
    since: Number.isFinite(Number(value.since)) ? Number(value.since) : Date.now(),
    mic: value.mic === true,
    camera: value.camera === true,
    recording: value.recording === true,
  };
}

function jsonResponse(body: unknown, status: number) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export class CinemaRoom {
  private hostStudentId = "";
  private playback: CinemaPlaybackState | null = null;
  /** When the last socket left, or 0 while somebody is attached. */
  private emptySince = 0;

  constructor(private readonly state: CinemaRoomState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/socket") return this.openSocket(request);
    if (url.pathname === "/close") return this.closeRoom();
    if (url.pathname === "/purge-message") return this.purgeMessage(request);
    if (url.pathname === "/source") return this.updateSource(request);
    if (url.pathname === "/whiteboard") return this.publishWhiteboard(request);
    if (url.pathname === "/whiteboard-remove") return this.removeWhiteboard(request);
    if (url.pathname === "/presence") return this.presenceResponse();
    return new Response("Not found", { status: 404 });
  }

  /**
   * Accepts a socket the Worker route already authorised. The route strips
   * every client-supplied `x-cinema-*` header before it forwards, so these two
   * are the Worker's word and not the browser's.
   */
  private async openSocket(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return jsonResponse({ error: "Expected a WebSocket upgrade." }, 426);
    }
    const attachment = this.attachmentFromHeader(request.headers.get("x-cinema-attachment"));
    if (!attachment) return jsonResponse({ error: "The socket is missing its student." }, 400);
    const snapshot = this.snapshotFromHeader(request.headers.get("x-cinema-room"));
    if (!snapshot) return jsonResponse({ error: "The socket is missing its room." }, 400);

    // Every connection carries the room as the database described it when the
    // socket was authorised, so the object keeps the freshest snapshot it has
    // seen and a reconnect after a retitle picks the new title up for free.
    await this.state.storage.put(ROOM_KEY, snapshot);
    this.hostStudentId = snapshot.hostStudentId;

    const WebSocketPairClass = (globalThis as { WebSocketPair?: WebSocketPairConstructor }).WebSocketPair;
    if (!WebSocketPairClass) return jsonResponse({ error: "Sockets are not available here." }, 500);
    const pair = new WebSocketPairClass();
    const client = pair[0];
    const server = pair[1];
    this.state.acceptWebSocket(server);
    server.serializeAttachment(attachment);

    // Somebody is here, so the room is not idle. The marker is what the
    // cleanup job reads: the database cannot see sockets, and the object
    // cannot be polled for every room on every cron tick.
    this.emptySince = 0;
    await this.state.storage.put(EMPTY_KEY, 0);

    // The whole room learns about the arrival, the newcomer included: its first
    // frame is the current presence rather than an empty list.
    this.broadcast({ type: "presence", members: await this.presence() });
    // Only the newcomer needs the current playback: everyone else already has
    // it, and a page that just loaded is exactly what M3 has to catch up.
    this.send(server, { type: "state", playback: await this.playbackState() });
    // Chat is the one thing a newcomer cannot derive: the room's memory of the
    // conversation, oldest first, sent privately so nobody else re-renders it.
    await this.replayChat(server, snapshot.roomId);
    return new Response(null, { status: 101, webSocket: client } as ResponseInit);
  }

  /**
   * The last fifty messages, sent one frame each. A failed replay is logged and
   * dropped: a database that is briefly away must not refuse the socket that
   * was already authorised, and playback and presence still work.
   */
  private async replayChat(socket: CinemaRoomSocket, sessionId: string) {
    if (!sessionId) return;
    try {
      for (const message of await recentCinemaMessages(sessionId, CINEMA_CHAT_REPLAY_LIMIT)) {
        this.send(socket, { type: "chat", message });
      }
    } catch (error) {
      logEvent("warn", "cinema_chat_replay_failed", {
        roomId: sessionId,
        reason: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  /** What the cleanup job asks before it ends an apparently abandoned room. */
  private async presenceResponse(): Promise<Response> {
    return jsonResponse({ members: await this.presence(), emptySince: await this.emptySinceValue() }, 200);
  }

  /**
   * A moderator removed a message. The row is already gone — this only asks
   * the open screens to stop showing it, so a socket that is open now and a
   * student who reconnects see the same room.
   */
  private async purgeMessage(request: Request): Promise<Response> {
    const body = await request.json().catch(() => null) as { messageId?: unknown } | null;
    const id = String(body?.messageId || "").trim();
    if (!id) return jsonResponse({ error: "A message id is required." }, 400);
    this.broadcast({ type: "chat_removed", id });
    return jsonResponse({ ok: true, id }, 200);
  }

  /**
   * A new board from the room's AI. The Worker route built and parsed it; the
   * object only carries it to the screens that are open, so a member does not
   * have to reload to see the answer their question produced.
   */
  private async publishWhiteboard(request: Request): Promise<Response> {
    const body = await request.json().catch(() => null) as { board?: unknown } | null;
    const board = body?.board as CinemaWhiteboardView | undefined;
    if (!board || typeof board !== "object" || typeof board.id !== "string" || !Array.isArray(board.blocks)) {
      return jsonResponse({ error: "A parsed board is required." }, 400);
    }
    this.broadcast({ type: "whiteboard", board });
    return jsonResponse({ ok: true, id: board.id }, 200);
  }

  /** The host cleared a board; every open screen drops it by id. */
  private async removeWhiteboard(request: Request): Promise<Response> {
    const body = await request.json().catch(() => null) as { id?: unknown } | null;
    const id = String(body?.id || "").trim();
    if (!id) return jsonResponse({ error: "A board id is required." }, 400);
    this.broadcast({ type: "whiteboard_removed", id });
    return jsonResponse({ ok: true, id }, 200);
  }

  /**
   * The room's video finished uploading. The snapshot is replaced so a socket
   * that connects later carries the new source, and everyone attached now is
   * told to switch players without a reload.
   */
  private async updateSource(request: Request): Promise<Response> {
    const body = await request.json().catch(() => null) as { sourceType?: unknown; videoId?: unknown } | null;
    const sourceType = String(body?.sourceType || "").trim().toUpperCase();
    if (sourceType !== "UPLOAD" && sourceType !== "YOUTUBE") {
      return jsonResponse({ error: "A video source type is required." }, 400);
    }
    const videoId = String(body?.videoId || "").trim();
    const snapshot = await this.state.storage.get<CinemaRoomSnapshot>(ROOM_KEY);
    if (snapshot) await this.state.storage.put(ROOM_KEY, { ...snapshot, sourceType, videoId });
    this.broadcast({ type: "source", sourceType, videoId });
    return jsonResponse({ ok: true, sourceType, videoId }, 200);
  }

  /** The host ended the room over HTTP; the sockets should not outlive it. */
  private async closeRoom(): Promise<Response> {
    this.broadcast({ type: "closed", reason: "The host ended this room." });
    for (const socket of this.state.getWebSockets()) {
      try {
        socket.close(CLOSE_NORMAL, "The room ended");
      } catch { /* an already-closing socket is not an error worth surfacing */ }
    }
    return jsonResponse({ ok: true, closed: true }, 200);
  }

  async webSocketMessage(socket: CinemaRoomSocket, message: unknown): Promise<void> {
    const raw = typeof message === "string" ? message : "";
    if (raw.length > MAX_MESSAGE_BYTES) {
      this.send(socket, { type: "error", message: "That message is too large." });
      return;
    }
    const parsed = parseClientMessage(raw);
    if (!parsed) {
      this.send(socket, { type: "error", message: "That is not a message this room understands." });
      return;
    }
    if (parsed.type === "ping") {
      this.send(socket, { type: "pong", at: Date.now() });
      return;
    }
    if (parsed.type === "chat_message") {
      await this.applyChat(socket, parsed);
      return;
    }
    if (parsed.type === "signal") {
      await this.applySignal(socket, parsed);
      return;
    }
    if (parsed.type === "media_state") {
      await this.applyMediaState(socket, parsed);
      return;
    }
    if (parsed.type === "recording_state") {
      await this.applyRecordingState(socket, parsed);
      return;
    }
    await this.applyPlayback(socket, parsed);
  }

  /**
   * One leg of a WebRTC handshake, relayed to the named peer and nobody else.
   *
   * The payload is opaque here on purpose: the object checks the sender's
   * attachment, checks the rate limit, and stamps `from` itself, so a client
   * cannot speak as somebody else however it fills the envelope. A target that
   * has already left is a dropped frame rather than an error — a peer losing a
   * race with a close is ordinary, and the offerer's own connection timeout is
   * the honest place for it to notice.
   */
  private async applySignal(socket: CinemaRoomSocket, frame: CinemaSignalInput): Promise<void> {
    const attachment = readAttachment(socket);
    if (!attachment) {
      this.send(socket, { type: "error", message: "That socket is not attached to a student." });
      return;
    }
    const limited = await rateLimitSubject("cinema-signal", attachment.studentId, { limit: SIGNAL_LIMIT, windowMs: SIGNAL_WINDOW_MS });
    if (!limited.ok) {
      this.send(socket, { type: "error", message: "Too many connection frames. Try again in a moment." });
      return;
    }
    if (frame.to === attachment.studentId) return;
    const target = this.findSocket(frame.to);
    if (!target) return;
    this.send(target, { type: "signal", from: attachment.studentId, payload: frame.payload });
  }

  /** A member's mic and camera switches, written to their attachment. */
  private async applyMediaState(socket: CinemaRoomSocket, frame: CinemaMediaStateInput): Promise<void> {
    const attachment = readAttachment(socket);
    if (!attachment) {
      this.send(socket, { type: "error", message: "That socket is not attached to a student." });
      return;
    }
    const limited = await rateLimitSubject("cinema-media-state", attachment.studentId, { limit: STATE_LIMIT, windowMs: STATE_WINDOW_MS });
    if (!limited.ok) return;
    if (attachment.mic === frame.mic && attachment.camera === frame.camera) return;
    socket.serializeAttachment({ ...attachment, mic: frame.mic, camera: frame.camera });
    this.broadcast({ type: "presence", members: await this.presence() });
  }

  /** The recorder announcing itself; the room is told, and that is the point. */
  private async applyRecordingState(socket: CinemaRoomSocket, frame: CinemaRecordingStateInput): Promise<void> {
    const attachment = readAttachment(socket);
    if (!attachment) {
      this.send(socket, { type: "error", message: "That socket is not attached to a student." });
      return;
    }
    const limited = await rateLimitSubject("cinema-recording-state", attachment.studentId, { limit: STATE_LIMIT, windowMs: STATE_WINDOW_MS });
    if (!limited.ok) return;
    if (attachment.recording === frame.active) return;
    socket.serializeAttachment({ ...attachment, recording: frame.active });
    this.broadcast({ type: "presence", members: await this.presence() });
  }

  /** The one attached socket for a student id, or null after they left. */
  private findSocket(studentId: string): CinemaRoomSocket | null {
    for (const socket of this.state.getWebSockets()) {
      if (readAttachment(socket)?.studentId === studentId) return socket;
    }
    return null;
  }

  /**
   * A message is stored before it is broadcast, so the live wire and the
   * reconnect replay cannot disagree about what was said. The rate limit is
   * per student, not per IP: a whole campus hall shares one address, and one
   * flooder must not silence their neighbours. If the store is unreachable the
   * room still shows the message live — losing it from the replay is a smaller
   * failure than closing the conversation for everyone — but the failure is
   * logged rather than hidden.
   */
  private async applyChat(socket: CinemaRoomSocket, frame: CinemaChatMessageInput): Promise<void> {
    const attachment = readAttachment(socket);
    if (!attachment) {
      this.send(socket, { type: "error", message: "That socket is not attached to a student." });
      return;
    }
    const limited = await rateLimitSubject("cinema-chat", attachment.studentId, { limit: CHAT_LIMIT, windowMs: CHAT_WINDOW_MS });
    if (!limited.ok) {
      this.send(socket, { type: "error", message: `You are sending messages too fast. Try again in ${Math.max(1, limited.retryAfter)} seconds.` });
      return;
    }
    const sessionId = String((await this.roomSnapshot())?.roomId || "");
    if (!sessionId) {
      this.send(socket, { type: "error", message: "This room is missing its identity." });
      return;
    }
    const atSeconds = Number.isFinite(Number(frame.timestamp)) && Number(frame.timestamp) >= 0 ? Number(frame.timestamp) : null;
    let message: CinemaChatMessage;
    try {
      message = await writeCinemaMessage({
        sessionId,
        sender: { id: attachment.studentId, name: attachment.displayName },
        content: frame.message,
        atSeconds,
      });
    } catch (error) {
      logEvent("warn", "cinema_chat_store_failed", {
        roomId: sessionId,
        reason: error instanceof Error ? error.message : "unknown",
      });
      message = {
        id: crypto.randomUUID(),
        sessionId,
        senderId: attachment.studentId,
        senderName: attachment.displayName,
        content: frame.message,
        atSeconds,
        createdAt: new Date().toISOString(),
      };
    }
    this.broadcast({ type: "chat", message });
  }

  /**
   * The one place a client's word becomes the room's state, so the checks are
   * deliberately strict: the sender must be the host (the socket is the wider
   * door than the HTTP route), the position must be a position, and the action
   * must have been built on the state the room is still in. A refusal answers
   * the sender with the truth — the current state — rather than broadcasting
   * anything, because the room did not change.
   */
  private async applyPlayback(socket: CinemaRoomSocket, action: CinemaPlaybackAction): Promise<void> {
    const attachment = readAttachment(socket);
    if (!attachment || attachment.studentId !== await this.hostId()) {
      console.warn(JSON.stringify({
        ts: new Date().toISOString(),
        level: "warn",
        event: "cinema_playback_refused",
        roomId: (await this.roomSnapshot())?.roomId || "",
        reason: "not-host",
      }));
      this.send(socket, { type: "error", message: "Only the host controls playback." });
      return;
    }

    const current = await this.playbackState();
    if (isStaleAction(action.stateAt, current.updatedAt)) {
      this.send(socket, { type: "state", playback: current });
      return;
    }

    const duration = Number.isFinite(Number(action.duration)) && Number(action.duration) > current.durationSeconds
      ? Number(action.duration)
      : current.durationSeconds;
    const time = acceptableTime(action.time, duration);
    if (time === null) {
      this.send(socket, { type: "error", message: "That playback position is not one the room can take." });
      return;
    }

    const next: CinemaPlaybackState = {
      positionSeconds: time,
      isPlaying: action.type === "play" ? true : action.type === "pause" ? false : current.isPlaying,
      updatedAt: Date.now(),
      durationSeconds: duration,
    };
    this.playback = next;
    await this.state.storage.put(PLAYBACK_KEY, next);
    // Back to everyone, the sender included: its echo is how it learns the
    // instant the room accepted, which is the anchor every client derives from.
    this.broadcast({ type: "state", playback: next });
  }

  /** A closed tab is not a message, but it changes presence just the same. */
  async webSocketClose(socket: CinemaRoomSocket): Promise<void> {
    // The runtime still lists the closing socket while this handler runs, so
    // it has to be excluded by hand or the room would keep seeing the person
    // who just left until the next arrival.
    const remaining = await this.presence(socket);
    this.broadcast({ type: "presence", members: remaining }, socket);
    // The room is idle once nobody is attached. Recording the instant here —
    // rather than inferring it from stale rows later — is what lets the
    // cleanup job end an abandoned room without guessing.
    this.emptySince = remaining.length === 0 ? Date.now() : 0;
    await this.state.storage.put(EMPTY_KEY, this.emptySince);
  }

  /** The runtime closes the socket after an error, so close owns the update. */
  async webSocketError(): Promise<void> {}

  /** Who is attached right now: one entry per student, host first. */
  async presence(exclude?: CinemaRoomSocket): Promise<CinemaPresenceMember[]> {
    const hostStudentId = await this.hostId();
    const members = new Map<string, CinemaPresenceMember>();
    for (const socket of this.state.getWebSockets()) {
      if (socket === exclude) continue;
      const attachment = readAttachment(socket);
      if (!attachment) continue;
      members.set(attachment.studentId, {
        studentId: attachment.studentId,
        displayName: attachment.displayName,
        isHost: Boolean(hostStudentId) && attachment.studentId === hostStudentId,
        since: attachment.since,
        mic: attachment.mic,
        camera: attachment.camera,
        recording: attachment.recording,
      });
    }
    return [...members.values()].sort((left, right) => {
      if (left.isHost !== right.isHost) return left.isHost ? -1 : 1;
      return left.since - right.since;
    });
  }

  private send(socket: CinemaRoomSocket, message: CinemaServerMessage) {
    try {
      socket.send(JSON.stringify(message));
    } catch { /* the close handler will run; a failed send is not fatal */ }
  }

  private broadcast(message: CinemaServerMessage, except?: CinemaRoomSocket) {
    const frame = JSON.stringify(message);
    for (const socket of this.state.getWebSockets()) {
      if (socket === except) continue;
      try {
        socket.send(frame);
      } catch { /* same as send() */ }
    }
  }

  /** The snapshot header is percent-encoded JSON so any title survives headers. */
  private snapshotFromHeader(value: string | null): CinemaRoomSnapshot | null {
    const parsed = decodeHeaderJson(value);
    if (!parsed) return null;
    const roomId = String(parsed.roomId || "");
    const hostStudentId = String(parsed.hostStudentId || "");
    if (!roomId || !hostStudentId) return null;
    return {
      roomId,
      hostStudentId,
      title: String(parsed.title || "").slice(0, 120),
      sourceType: String(parsed.sourceType || "YOUTUBE"),
      videoId: String(parsed.videoId || ""),
    };
  }

  private attachmentFromHeader(value: string | null): CinemaSocketAttachment | null {
    const parsed = decodeHeaderJson(value);
    if (!parsed) return null;
    const studentId = String(parsed.studentId || "");
    if (!studentId) return null;
    return {
      studentId,
      displayName: String(parsed.displayName || "").slice(0, 80),
      since: Date.now(),
      mic: false,
      camera: false,
      recording: false,
    };
  }

  /**
   * The host id from the last snapshot the object stored. Read once per
   * instance: an object that just woke from hibernation has the memory empty
   * but the storage full, and every later read would say the same thing.
   */
  private async hostId(): Promise<string> {
    if (!this.hostStudentId) {
      this.hostStudentId = String((await this.roomSnapshot())?.hostStudentId || "");
    }
    return this.hostStudentId;
  }

  private roomSnapshot() {
    return this.state.storage.get<CinemaRoomSnapshot>(ROOM_KEY);
  }

  /** When the last socket left, from memory or from storage after a wake. */
  private async emptySinceValue(): Promise<number> {
    if (this.emptySince) return this.emptySince;
    const stored = Number(await this.state.storage.get(EMPTY_KEY));
    this.emptySince = Number.isFinite(stored) && stored > 0 ? stored : 0;
    return this.emptySince;
  }

  /** The room's playback, from memory, or from storage after a wake. */
  private async playbackState(): Promise<CinemaPlaybackState> {
    if (!this.playback) {
      const stored = await this.state.storage.get<CinemaPlaybackState>(PLAYBACK_KEY);
      this.playback = stored ? { ...CINEMA_PLAYBACK_START, ...stored } : { ...CINEMA_PLAYBACK_START };
    }
    return this.playback;
  }
}

function decodeHeaderJson(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(value));
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
