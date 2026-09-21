import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => vite.close());

const {
  CINEMA_DRIFT_THRESHOLD_SECONDS,
  CINEMA_MAX_POSITION_SECONDS,
  acceptableTime,
  driftSeconds,
  expectedPosition,
  isStaleAction,
  reconcilePlayback,
} = await vite.ssrLoadModule("/lib/cinema-engine/sync.ts");

const T0 = Date.UTC(2026, 8, 21, 12, 0, 0);
const playback = (overrides = {}) => ({ positionSeconds: 0, isPlaying: false, updatedAt: T0, durationSeconds: 0, ...overrides });

test("a paused room's position is where it was left", async () => {
  assert.equal(expectedPosition(playback({ positionSeconds: 120.5 }), T0 + 60_000), 120.5);
});

test("a playing room's position advances with the reader's clock, not the sender's", async () => {
  // The anchor is the instant the object accepted, so a frame that took three
  // seconds to arrive still reads correctly on a client that just received it.
  assert.equal(expectedPosition(playback({ positionSeconds: 30, isPlaying: true }), T0 + 3_000), 33);
  assert.ok(Math.abs(expectedPosition(playback({ positionSeconds: 30, isPlaying: true }), T0 + 7_500) - 37.5) < 0.001);
});

test("an anchor in the future never rewinds the video past its base", async () => {
  assert.equal(expectedPosition(playback({ positionSeconds: 10, isPlaying: true }), T0 - 5_000), 10);
});

test("positions are clamped to something a day cannot exceed", async () => {
  assert.equal(expectedPosition(playback({ positionSeconds: CINEMA_MAX_POSITION_SECONDS, isPlaying: true }), T0 + 10_000), CINEMA_MAX_POSITION_SECONDS);
});

test("a host's time must be a real position, inside the video when its length is known", async () => {
  assert.equal(acceptableTime(0), 0);
  assert.equal(acceptableTime(124.5, 300), 124.5);
  assert.equal(acceptableTime(300.5, 300), 300.5, "a second of slack for the player's own rounding");
  assert.equal(acceptableTime(302, 300), null);
  assert.equal(acceptableTime(-1), null);
  assert.equal(acceptableTime("not a number"), null);
  assert.equal(acceptableTime(CINEMA_MAX_POSITION_SECONDS + 1), null);
  assert.equal(acceptableTime(500), 500, "with no known duration, non-negative is all that can be asked");
});

test("an action built on a state the room has left behind is stale", async () => {
  assert.equal(isStaleAction(undefined, T0), false, "an action that carries no anchor is judged on its merits");
  assert.equal(isStaleAction(0, T0), false);
  assert.equal(isStaleAction(T0 - 1_000, T0), true);
  assert.equal(isStaleAction(T0, T0), false);
  assert.equal(isStaleAction(T0 + 1, T0), false);
});

test("a member's player is nudged toward the room rather than argued with", async () => {
  const playing = playback({ positionSeconds: 100, isPlaying: true });

  // Exactly where it should be: nothing to do.
  assert.deepEqual(reconcilePlayback({ playback: playing, playerTime: 100, playerPlaying: true, playerReady: true, now: T0 }), {});

  // Half a second late is inside the threshold, so the next tick has a chance.
  const near = reconcilePlayback({ playback: playing, playerTime: 100 + CINEMA_DRIFT_THRESHOLD_SECONDS * 0.5, playerPlaying: true, playerReady: true, now: T0 });
  assert.deepEqual(near, {});

  // Past the threshold, the player seeks to the derived position.
  const late = reconcilePlayback({ playback: playing, playerTime: 90, playerPlaying: true, playerReady: true, now: T0 + 5_000 });
  assert.ok(Math.abs(late.seekTo - 105) < 0.001);
});

test("paused rooms ask a playing player to pause, and vice versa", async () => {
  const paused = playback({ positionSeconds: 40, isPlaying: false });
  assert.deepEqual(reconcilePlayback({ playback: paused, playerTime: 40, playerPlaying: true, playerReady: true, now: T0 }), { resume: false });

  const playing = playback({ positionSeconds: 40, isPlaying: true });
  assert.deepEqual(reconcilePlayback({ playback: playing, playerTime: 40, playerPlaying: false, playerReady: true, now: T0 }), { resume: true });
});

test("a buffering player and an unready one are left alone", async () => {
  const playing = playback({ positionSeconds: 10, isPlaying: true });
  assert.deepEqual(reconcilePlayback({ playback: playing, playerTime: 0, playerPlaying: false, playerReady: true, now: T0, buffering: true }), {});
  assert.deepEqual(reconcilePlayback({ playback: playing, playerTime: 0, playerPlaying: false, playerReady: false, now: T0 }), {});
});

test("drift is signed: the player being ahead reads positive", async () => {
  assert.equal(driftSeconds(105, 100), 5);
  assert.equal(driftSeconds(95, 100), -5);
});
