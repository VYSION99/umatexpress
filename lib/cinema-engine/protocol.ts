/**
 * The Cinema socket protocol.
 *
 * One connection carries presence now and playback in M3, so both sides of the
 * wire agree on the envelope here rather than in two files that drift. Frames
 * are small JSON objects with a `type`; the Durable Object stamps anything
 * authoritative, and a client never sends a fact about itself that the server
 * cannot check against the socket attachment it wrote at connect time.
 */

export type CinemaPresenceMember = {
  studentId: string;
  displayName: string;
  isHost: boolean;
  /** Epoch milliseconds of this connection, not of the first time they joined. */
  since: number;
};

/**
 * The room's playback as the Durable Object last accepted it. `updatedAt` is
 * the object's clock at the moment it said yes, never the sender's.
 */
export type CinemaPlaybackState = {
  positionSeconds: number;
  isPlaying: boolean;
  updatedAt: number;
  /** The video's length, or 0 while no player has reported it. */
  durationSeconds: number;
};

/**
 * One chat message as the room stored it. `atSeconds` is the video position the
 * sender attached, or null when they attached none; it travels in the row's
 * `metadata` so the room can render a seek chip without parsing prose.
 */
export type CinemaChatMessage = {
  id: string;
  sessionId: string;
  senderId: string;
  senderName: string;
  content: string;
  atSeconds: number | null;
  createdAt: string;
};

/** Long enough for a study question, short enough that a socket cannot flood. */
export const CINEMA_CHAT_MAX_LENGTH = 500;

/** A room nobody has pressed play in yet. */
export const CINEMA_PLAYBACK_START: CinemaPlaybackState = {
  positionSeconds: 0,
  isPlaying: false,
  updatedAt: 0,
  durationSeconds: 0,
};

export type CinemaServerMessage =
  | { type: "presence"; members: CinemaPresenceMember[] }
  | { type: "state"; playback: CinemaPlaybackState }
  | { type: "chat"; message: CinemaChatMessage }
  | { type: "chat_removed"; id: string }
  | { type: "pong"; at: number }
  | { type: "closed"; reason: string }
  | { type: "error"; message: string };

export type CinemaPlaybackActionType = "play" | "pause" | "seek";

/**
 * A host's playback action. `stateAt` is the `updatedAt` the sender last saw,
 * so the object can drop a frame built on a state it has already left behind.
 */
export type CinemaPlaybackAction = {
  type: CinemaPlaybackActionType;
  time: number;
  duration?: number;
  stateAt?: number;
};

export type CinemaChatMessageInput = {
  type: "chat_message";
  message: string;
  /** The video position the sender wants the chip to seek to. */
  timestamp?: number;
};

export type CinemaClientMessage = { type: "ping" } | CinemaChatMessageInput | CinemaPlaybackAction;

const PLAYBACK_TYPES = new Set<CinemaPlaybackActionType>(["play", "pause", "seek"]);

/**
 * A frame from the wire, or null when it is not one this version understands.
 * Sockets are open to anything with a session cookie, so the parse is a guard
 * rather than a formality: an unknown `type` is dropped, never forwarded.
 */
export function parseClientMessage(raw: unknown): CinemaClientMessage | null {
  if (typeof raw !== "string" || raw.length > 4_000) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const type = (value as { type?: unknown }).type;
  if (type === "ping") return { type };
  if (type === "chat_message") {
    const source = value as { message?: unknown; content?: unknown; timestamp?: unknown; atSeconds?: unknown };
    const content = String(source.message ?? source.content ?? "").trim();
    if (!content || content.length > CINEMA_CHAT_MAX_LENGTH) return null;
    const rawTimestamp = Number(source.timestamp ?? source.atSeconds);
    return {
      type: "chat_message",
      message: content,
      ...(Number.isFinite(rawTimestamp) && rawTimestamp >= 0 ? { timestamp: rawTimestamp } : {}),
    };
  }
  if (typeof type === "string" && PLAYBACK_TYPES.has(type as CinemaPlaybackActionType)) {
    const source = value as { time?: unknown; duration?: unknown; stateAt?: unknown };
    const time = Number(source.time);
    if (!Number.isFinite(time)) return null;
    const duration = Number(source.duration);
    const stateAt = Number(source.stateAt);
    return {
      type: type as CinemaPlaybackActionType,
      time,
      ...(Number.isFinite(duration) && duration > 0 ? { duration } : {}),
      ...(Number.isFinite(stateAt) && stateAt > 0 ? { stateAt } : {}),
    };
  }
  return null;
}
