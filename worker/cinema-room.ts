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
import { parseClientMessage, type CinemaPresenceMember, type CinemaServerMessage } from "@/lib/cinema-engine/protocol";

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
const CLOSE_NORMAL = 1000;
/** One frame is tiny; anything larger is not a message this room speaks. */
const MAX_MESSAGE_BYTES = 4_000;

function readAttachment(socket: CinemaRoomSocket): CinemaSocketAttachment | null {
  const raw = socket.deserializeAttachment();
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<CinemaSocketAttachment>;
  if (typeof value.studentId !== "string" || !value.studentId) return null;
  return {
    studentId: value.studentId,
    displayName: typeof value.displayName === "string" ? value.displayName.slice(0, 80) : "",
    since: Number.isFinite(Number(value.since)) ? Number(value.since) : Date.now(),
  };
}

function jsonResponse(body: unknown, status: number) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export class CinemaRoom {
  private hostStudentId = "";

  constructor(private readonly state: CinemaRoomState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/socket") return this.openSocket(request);
    if (url.pathname === "/close") return this.closeRoom();
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

    // The whole room learns about the arrival, the newcomer included: its first
    // frame is the current presence rather than an empty list.
    this.broadcast({ type: "presence", members: await this.presence() });
    return new Response(null, { status: 101, webSocket: client } as ResponseInit);
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
    // One case today. Playback actions arrive in M3, where the same switch
    // grows play, pause and seek behind the sender-is-host check.
    if (parsed.type === "ping") this.send(socket, { type: "pong", at: Date.now() });
  }

  /** A closed tab is not a message, but it changes presence just the same. */
  async webSocketClose(socket: CinemaRoomSocket): Promise<void> {
    // The runtime still lists the closing socket while this handler runs, so
    // it has to be excluded by hand or the room would keep seeing the person
    // who just left until the next arrival.
    this.broadcast({ type: "presence", members: await this.presence(socket) }, socket);
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
    };
  }

  /**
   * The host id from the last snapshot the object stored. Read once per
   * instance: an object that just woke from hibernation has the memory empty
   * but the storage full, and every later read would say the same thing.
   */
  private async hostId(): Promise<string> {
    if (!this.hostStudentId) {
      const snapshot = await this.state.storage.get<CinemaRoomSnapshot>(ROOM_KEY);
      this.hostStudentId = String(snapshot?.hostStudentId || "");
    }
    return this.hostStudentId;
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
