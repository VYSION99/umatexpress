/**
 * The playback arithmetic from §11 of the Cinema plan, as pure functions.
 *
 * The room never sends "the position now". It sends a position, an instant and
 * whether the video was playing, and every client derives the rest from its own
 * clock. That is what makes a late frame harmless, a client clock that is a few
 * seconds off irrelevant, and a page that has just loaded correct on its first
 * frame — the three things a naive "seek to 12:34" message gets wrong.
 */
import type { CinemaPlaybackState } from "@/lib/cinema-engine/protocol";

/** How far a player may drift before the client corrects it, in seconds. */
export const CINEMA_DRIFT_THRESHOLD_SECONDS = 1;

/** The host's own player may stall this far before it re-seeks the room. */
export const CINEMA_HOST_DRIFT_SECONDS = 3;

/** No video is a day long; anything past this is a client bug, not a position. */
export const CINEMA_MAX_POSITION_SECONDS = 24 * 60 * 60;

/** A position the room can store: finite, non-negative, inside the day. */
export function clampPosition(seconds: unknown) {
  const numeric = Number(seconds);
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
  return Math.min(numeric, CINEMA_MAX_POSITION_SECONDS);
}

/**
 * A time a host action may carry, or null when it cannot be one. When the room
 * knows the video's length, the position has to be inside it (with a second of
 * slack for the player's own rounding); when it does not, non-negative is all
 * that can honestly be asked.
 */
export function acceptableTime(value: unknown, durationSeconds = 0): number | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > CINEMA_MAX_POSITION_SECONDS) return null;
  if (durationSeconds > 0 && numeric > durationSeconds + 1) return null;
  return numeric;
}

/**
 * Whether the sender built its action on a state the room has already moved
 * past. A stale frame is dropped rather than applied, which is what stops a
 * reconnecting host from rewinding everyone.
 */
export function isStaleAction(stateAt: unknown, updatedAt: number): boolean {
  const numeric = Number(stateAt);
  if (!Number.isFinite(numeric) || numeric <= 0) return false;
  return numeric < updatedAt;
}

/** Where the video should be, from the room's last word and the reader's clock. */
export function expectedPosition(playback: CinemaPlaybackState, now: number): number {
  const base = clampPosition(playback.positionSeconds);
  if (!playback.isPlaying) return base;
  const elapsedSeconds = Math.max(0, now - Number(playback.updatedAt || 0)) / 1000;
  return clampPosition(base + elapsedSeconds);
}

/** Signed drift: positive means the local player is ahead of the room. */
export function driftSeconds(playerTime: number, expected: number): number {
  return Number(playerTime) - Number(expected);
}

/** What a client should do to one player to agree with the room. */
export type SyncIntent = {
  /** Jump here first, or undefined to leave the position alone. */
  seekTo?: number;
  /** Then play (true) or pause (false), or undefined to leave that alone. */
  resume?: boolean;
};

/**
 * The one decision both the member's correction loop and the initial join
 * make: given the room's state and the player's, what has to change? Buffering
 * is left alone — a player that is loading will land where it was told, and
 * seeking it mid-buffer is how clients end up in a fight they cannot win.
 */
export function reconcilePlayback(input: {
  playback: CinemaPlaybackState;
  playerTime: number;
  playerPlaying: boolean;
  playerReady: boolean;
  now: number;
  buffering?: boolean;
  threshold?: number;
}): SyncIntent {
  if (!input.playerReady || input.buffering) return {};
  const expected = expectedPosition(input.playback, input.now);
  const threshold = Number.isFinite(Number(input.threshold)) ? Number(input.threshold) : CINEMA_DRIFT_THRESHOLD_SECONDS;
  const intent: SyncIntent = {};
  if (Math.abs(driftSeconds(input.playerTime, expected)) > threshold) intent.seekTo = expected;
  if (input.playback.isPlaying && !input.playerPlaying) intent.resume = true;
  if (!input.playback.isPlaying && input.playerPlaying) intent.resume = false;
  return intent;
}
