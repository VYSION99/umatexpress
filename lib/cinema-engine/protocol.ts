import type { CinemaWhiteboardView } from "@/lib/cinema-engine/whiteboard-scene";

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
  /** Microphone on. The socket attachment is the record, never the sender's frame. */
  mic: boolean;
  /** Camera on. Off by default: a study room should not open with a camera prompt. */
  camera: boolean;
  /** Recording, announced so the room always knows when one is running. */
  recording: boolean;
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

/**
 * The largest frame the socket speaks. A chat line is a few hundred bytes; an
 * SDP offer with its candidates is a few kilobytes, so the old four-kilobyte
 * ceiling would have dropped the handshake that M8 exists to carry.
 */
export const CINEMA_FRAME_MAX_BYTES = 16_384;
/** One signal payload, bounded separately so a frame cannot be all padding. */
export const CINEMA_SIGNAL_MAX_BYTES = 12_000;
/** Long enough for a peer id, short enough that it cannot be a payload. */
const CINEMA_PEER_ID_MAX_LENGTH = 80;

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
  | { type: "source"; sourceType: string; videoId: string }
  | { type: "signal"; from: string; payload: CinemaSignalPayload }
  /** A new AI board for the room; the scene is already parsed and bounded. */
  | { type: "whiteboard"; board: CinemaWhiteboardView }
  | { type: "whiteboard_removed"; id: string }
  /** The host asked everyone to mute; each client turns its own mic off. */
  | { type: "mute_all"; by: string }
  /** Who may ask the room's whiteboard, as the host last set it. */
  | { type: "board_policy"; policy: CinemaBoardPolicy }
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

/**
 * One leg of a WebRTC handshake, relayed blind. The room never inspects the
 * SDP: it checks that the sender is attached and that the target is a member,
 * rewrites `from` from the attachment, and hands the payload to that one peer.
 */
export type CinemaSignalPayload =
  | { kind: "offer" | "answer"; sdp: string }
  | { kind: "candidate"; candidate: string; sdpMid?: string; sdpMLineIndex?: number };

export type CinemaSignalInput = {
  type: "signal";
  /** The student id this leg is for, as the presence list spelled it. */
  to: string;
  payload: CinemaSignalPayload;
};

/** A member's own microphone and camera switches, echoed to the room. */
export type CinemaMediaStateInput = {
  type: "media_state";
  mic: boolean;
  camera: boolean;
};

/**
 * A recorder announcing itself. The room does not keep the file — it is the
 * recorder's, uploaded privately — but a person whose voice may be in it has
 * the right to see that it is running.
 */
export type CinemaRecordingStateInput = {
  type: "recording_state";
  active: boolean;
};

/**
 * The host asking the room to mute. The object checks that the sender is the
 * host, then broadcasts; the microphone itself lives in each member's browser,
 * so the request is the most a room can honestly do.
 */
export type CinemaMuteAllInput = {
  type: "mute_all";
};

/**
 * Who may ask the whiteboard.
 *
 * `HOST` keeps the questions with the host, `MEMBERS` releases them to
 * everyone in the room, and `AUTO` takes them away from everybody: the room's
 * own screen runs the summaries and answers the chat on a cadence, and a manual
 * ask is refused. The list is one constant so the wire, the object and the
 * route cannot disagree about what a policy is.
 */
export const CINEMA_BOARD_POLICIES = ["HOST", "MEMBERS", "AUTO"] as const;
export type CinemaBoardPolicy = (typeof CINEMA_BOARD_POLICIES)[number];

/** The host changing who may ask. The object checks the sender; the wire does not. */
export type CinemaBoardPolicyInput = {
  type: "board_policy";
  policy: CinemaBoardPolicy;
};

export type CinemaClientMessage =
  | { type: "ping" }
  | CinemaChatMessageInput
  | CinemaPlaybackAction
  | CinemaSignalInput
  | CinemaMediaStateInput
  | CinemaRecordingStateInput
  | CinemaMuteAllInput
  | CinemaBoardPolicyInput;

const PLAYBACK_TYPES = new Set<CinemaPlaybackActionType>(["play", "pause", "seek"]);
const SIGNAL_KINDS = new Set<CinemaSignalPayload["kind"]>(["offer", "answer", "candidate"]);

/** One signaling payload, or null when it is not one this version relays. */
function parseSignalPayload(value: unknown): CinemaSignalPayload | null {
  if (!value || typeof value !== "object") return null;
  const source = value as { kind?: unknown; sdp?: unknown; candidate?: unknown; sdpMid?: unknown; sdpMLineIndex?: unknown };
  const kind = String(source.kind || "") as CinemaSignalPayload["kind"];
  if (!SIGNAL_KINDS.has(kind)) return null;
  if (kind === "offer" || kind === "answer") {
    const sdp = typeof source.sdp === "string" ? source.sdp.trim() : "";
    if (!sdp || sdp.length > CINEMA_SIGNAL_MAX_BYTES) return null;
    return { kind, sdp };
  }
  const candidate = typeof source.candidate === "string" ? source.candidate.trim() : "";
  if (!candidate || candidate.length > 2_000) return null;
  const sdpMid = typeof source.sdpMid === "string" ? source.sdpMid.trim().slice(0, 64) : "";
  const rawLine = Math.floor(Number(source.sdpMLineIndex));
  const sdpMLineIndex = Number.isFinite(rawLine) && rawLine >= 0 && rawLine <= 255 ? rawLine : undefined;
  return { kind: "candidate", candidate, ...(sdpMid ? { sdpMid } : {}), ...(sdpMLineIndex === undefined ? {} : { sdpMLineIndex }) };
}

/**
 * A frame from the wire, or null when it is not one this version understands.
 * Sockets are open to anything with a session cookie, so the parse is a guard
 * rather than a formality: an unknown `type` is dropped, never forwarded.
 */
export function parseClientMessage(raw: unknown): CinemaClientMessage | null {
  if (typeof raw !== "string" || raw.length > CINEMA_FRAME_MAX_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const type = (value as { type?: unknown }).type;
  if (type === "ping") return { type };
  if (type === "mute_all") return { type: "mute_all" };
  if (type === "board_policy") {
    const policy = String((value as { policy?: unknown }).policy || "").toUpperCase();
    return (CINEMA_BOARD_POLICIES as readonly string[]).includes(policy)
      ? { type: "board_policy", policy: policy as CinemaBoardPolicy }
      : null;
  }
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
  if (type === "signal") {
    const source = value as { to?: unknown; payload?: unknown };
    const to = String(source.to || "").trim();
    if (!to || to.length > CINEMA_PEER_ID_MAX_LENGTH) return null;
    const payload = parseSignalPayload(source.payload);
    if (!payload) return null;
    return { type: "signal", to, payload };
  }
  if (type === "media_state") {
    const source = value as { mic?: unknown; camera?: unknown };
    if (typeof source.mic !== "boolean" || typeof source.camera !== "boolean") return null;
    return { type: "media_state", mic: source.mic, camera: source.camera };
  }
  if (type === "recording_state") {
    const source = value as { active?: unknown };
    if (typeof source.active !== "boolean") return null;
    return { type: "recording_state", active: source.active };
  }
  return null;
}
