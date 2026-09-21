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

export type CinemaServerMessage =
  | { type: "presence"; members: CinemaPresenceMember[] }
  | { type: "pong"; at: number }
  | { type: "closed"; reason: string }
  | { type: "error"; message: string };

export type CinemaClientMessage = { type: "ping" };

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
  return null;
}
