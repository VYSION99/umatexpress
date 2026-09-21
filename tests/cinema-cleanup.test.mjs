import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

/**
 * Cinema cleanup: idle rooms end, ended rooms expire and are purged, and the
 * Durable Object is asked about presence rather than guessed about.
 *
 * The fake Turso keeps the four tables in memory. `runCinemaCleanup` takes the
 * presence reader as an argument precisely so this file can decide what the
 * object would say without a binding.
 */

process.env.TURSO_DATABASE_URL = "https://cinema-cleanup-test.turso.io";
process.env.TURSO_AUTH_TOKEN = "test-token";
delete process.env.CINEMA_ROOM_IDLE_MINUTES;
delete process.env.CINEMA_RETENTION_HOURS;

const state = { sessions: [], messages: [], participants: [], settings: new Map(), schema: new Map(), metrics: [] };

function cell(value) {
  if (value === null || value === undefined) return { type: "null" };
  if (typeof value === "number") return { type: Number.isInteger(value) ? "integer" : "real", value: String(value) };
  return { type: "text", value: String(value) };
}
const ok = (result) => ({ type: "ok", response: { result: result || {} } });
const empty = { cols: [], rows: [] };
const affected = (count) => ok({ affected_row_count: count });
const table = (columns, rows) => ({ cols: columns.map((name) => ({ name })), rows: rows.map((row) => columns.map((name) => cell(row[name]))) });

function updateSessions(match, change) {
  let count = 0;
  for (const session of state.sessions) {
    if (match(session)) { change(session); count += 1; }
  }
  return affected(count);
}

function handle(sql, args) {
  if (/^SELECT version FROM (campus_schema_meta|schema_passes)/.test(sql)) {
    const version = state.schema.get(String(args[0] || ""));
    return version ? ok(table(["version"], [{ version }])) : ok(empty);
  }
  if (/^INSERT OR REPLACE INTO (campus_schema_meta|schema_passes)/.test(sql)) {
    state.schema.set(String(args[0] || ""), String(args[1] || ""));
    return affected(1);
  }
  if (/^CREATE (TABLE|INDEX|UNIQUE INDEX)/.test(sql)) return ok(empty);

  if (/^SELECT key, value, COALESCE\(updated_by,''\) AS updated_by/.test(sql)) {
    const rows = [...state.settings.values()];
    return ok(rows.length ? table(["key", "value", "updated_by", "updated_at"], rows) : empty);
  }

  if (/^SELECT id,status,updated_at,created_at FROM cinema_sessions/.test(sql)) {
    const rows = state.sessions
      .filter((session) => ["CREATED", "LIVE"].includes(session.status) && session.updated_at <= args[0])
      .sort((left, right) => String(left.updated_at).localeCompare(String(right.updated_at)))
      .slice(0, Number((sql.match(/LIMIT (\d+)/) || [])[1] || 4));
    return ok(rows.length ? table(["id", "status", "updated_at", "created_at"], rows) : empty);
  }
  if (/^SELECT id FROM cinema_sessions/.test(sql)) {
    const rows = state.sessions
      .filter((session) => ["ENDED", "EXPIRED"].includes(session.status) && session.ended_at && session.ended_at <= args[0])
      .sort((left, right) => String(left.ended_at).localeCompare(String(right.ended_at)))
      .slice(0, Number((sql.match(/LIMIT (\d+)/) || [])[1] || 4))
      .map((session) => ({ id: session.id }));
    return ok(rows.length ? table(["id"], rows) : empty);
  }

  if (/^UPDATE cinema_sessions SET status = 'ENDED'/.test(sql)) {
    return updateSessions((session) => session.id === args[2] && ["CREATED", "LIVE"].includes(session.status), (session) => {
      session.status = "ENDED"; session.ended_at = args[0]; session.updated_at = args[1];
    });
  }
  if (/^UPDATE cinema_sessions SET updated_at = \? WHERE id = \?/.test(sql)) {
    return updateSessions((session) => session.id === args[1], (session) => { session.updated_at = args[0]; });
  }
  if (/^UPDATE cinema_sessions SET status = 'EXPIRED'/.test(sql)) {
    return updateSessions((session) => session.id === args[2] && session.status === "ENDED", (session) => {
      session.status = "EXPIRED"; session.expired_at = args[0]; session.updated_at = args[1];
    });
  }
  if (/^UPDATE cinema_sessions SET status = 'DELETED'/.test(sql)) {
    return updateSessions((session) => session.id === args[2] && session.status === "EXPIRED", (session) => {
      session.status = "DELETED"; session.deleted_at = args[0]; session.updated_at = args[1];
    });
  }

  if (/^DELETE FROM cinema_messages WHERE session_id/.test(sql)) {
    const before = state.messages.length;
    state.messages = state.messages.filter((row) => row.session_id !== args[0]);
    return affected(before - state.messages.length);
  }
  if (/^DELETE FROM cinema_participants WHERE session_id/.test(sql)) {
    const before = state.participants.length;
    state.participants = state.participants.filter((row) => row.session_id !== args[0]);
    return affected(before - state.participants.length);
  }

  if (/^INSERT INTO metrics_counters/.test(sql)) { state.metrics.push(args[0]); return ok(table(["count"], [{ count: 1 }])); }
  return ok(empty);
}

globalThis.fetch = async (url, init) => {
  const target = String(typeof url === "string" ? url : url?.url || "");
  if (target.startsWith("https://cinema-cleanup-test.turso.io")) {
    const body = JSON.parse(init.body);
    const results = body.requests
      .filter((request) => request.type === "execute")
      .map(({ stmt }) => handle(stmt.sql, (stmt.args || []).map((arg) => (arg.type === "null" ? null : arg.value))));
    return { ok: true, json: async () => ({ results }) };
  }
  throw new Error(`Unhandled request to ${target}`);
};

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => vite.close());

const { runCinemaCleanup } = await vite.ssrLoadModule("/lib/cinema-engine/cleanup.ts");
const { resetPlatformSettingsCache, platformSettingNumber } = await vite.ssrLoadModule("/lib/platform-settings.ts");

const NOW = Date.parse("2026-09-21T12:00:00.000Z");
const minutesAgo = (minutes) => new Date(NOW - minutes * 60_000).toISOString();
const hoursAgo = (hours) => minutesAgo(hours * 60);

function session(overrides = {}) {
  return {
    id: "room-1",
    status: "LIVE",
    updated_at: minutesAgo(60),
    created_at: minutesAgo(120),
    ended_at: "",
    expired_at: "",
    deleted_at: "",
    ...overrides,
  };
}

beforeEach(() => {
  process.env.TURSO_DATABASE_URL = "https://cinema-cleanup-test.turso.io";
  process.env.TURSO_AUTH_TOKEN = "test-token";
  state.sessions = [];
  state.messages = [];
  state.participants = [];
  state.settings.clear();
  state.metrics = [];
  delete process.env.CINEMA_ROOM_IDLE_MINUTES;
  delete process.env.CINEMA_RETENTION_HOURS;
  resetPlatformSettingsCache();
});

const attached = (emptySince) => async () => ({ memberCount: 0, emptySince });

test("a room created and never opened ends after the idle window", async () => {
  state.sessions = [session({ id: "never-opened", status: "CREATED", updated_at: minutesAgo(45), created_at: minutesAgo(45) })];
  const result = await runCinemaCleanup({ now: NOW, presence: attached(0) });
  assert.equal(result.idleEnded, 1);
  assert.equal(state.sessions[0].status, "ENDED");
  assert.ok(state.sessions[0].ended_at, "the tombstone records when it ended");
});

test("a live room with someone attached is left alone", async () => {
  state.sessions = [session({ id: "watched" })];
  const result = await runCinemaCleanup({ now: NOW, presence: async () => ({ memberCount: 2, emptySince: 0 }) });
  assert.equal(result.idleEnded, 0);
  assert.equal(state.sessions[0].status, "LIVE");
});

test("a live room whose last socket left too long ago ends", async () => {
  state.sessions = [session({ id: "abandoned" })];
  const result = await runCinemaCleanup({ now: NOW, presence: attached(NOW - 31 * 60_000) });
  assert.equal(result.idleEnded, 1);
  assert.equal(state.sessions[0].status, "ENDED");
});

test("a live room whose object cannot be reached is not ended on a guess", async () => {
  state.sessions = [session({ id: "unreachable" })];
  const result = await runCinemaCleanup({ now: NOW, presence: async () => null });
  assert.equal(result.idleEnded, 0);
  assert.equal(result.presenceUnavailable, true);
  assert.equal(state.sessions[0].status, "LIVE");
});

test("the idle window follows the console setting, not a constant", async () => {
  assert.equal(await platformSettingNumber("cinema_room_idle_minutes"), 30, "the documented default");
  state.settings.set("cinema_room_idle_minutes", { key: "cinema_room_idle_minutes", value: "10", updated_by: "admin", updated_at: new Date(NOW).toISOString() });
  resetPlatformSettingsCache();
  state.sessions = [session({ id: "shorter-window", updated_at: minutesAgo(20) })];
  const result = await runCinemaCleanup({ now: NOW, presence: attached(0) });
  assert.equal(result.idleEnded, 1, "ten minutes of emptiness is the override, so twenty is overdue");
});

test("an ended room inside its retention window keeps its chat", async () => {
  state.sessions = [session({ id: "fresh", status: "ENDED", ended_at: minutesAgo(30) })];
  state.messages = [{ id: "m-1", session_id: "fresh" }];
  state.participants = [{ session_id: "fresh", student_id: "s-1" }];
  const result = await runCinemaCleanup({ now: NOW, presence: async () => null });
  assert.equal(result.deleted, 0);
  assert.equal(state.messages.length, 1);
  assert.equal(state.participants.length, 1);
});

test("an ended room past retention is purged and left as a tombstone", async () => {
  state.sessions = [session({ id: "gone", status: "ENDED", ended_at: hoursAgo(5) })];
  state.messages = [{ id: "m-1", session_id: "gone" }, { id: "m-2", session_id: "gone" }];
  state.participants = [{ session_id: "gone", student_id: "s-1" }, { session_id: "gone", student_id: "s-2" }];
  const result = await runCinemaCleanup({ now: NOW, presence: async () => null });
  assert.equal(result.deleted, 1);
  const tombstone = state.sessions[0];
  assert.equal(tombstone.status, "DELETED");
  assert.equal(tombstone.id, "gone", "the row stays so the audit trail does not lie");
  assert.ok(tombstone.expired_at);
  assert.ok(tombstone.deleted_at);
  assert.equal(state.messages.length, 0);
  assert.equal(state.participants.length, 0);
});

test("the retention window follows the console setting", async () => {
  state.settings.set("cinema_retention_hours", { key: "cinema_retention_hours", value: "1", updated_by: "admin", updated_at: new Date(NOW).toISOString() });
  resetPlatformSettingsCache();
  state.sessions = [session({ id: "short", status: "ENDED", ended_at: minutesAgo(90) })];
  const result = await runCinemaCleanup({ now: NOW, presence: async () => null });
  assert.equal(result.deleted, 1, "ninety minutes is past a one-hour retention");
});

test("a run with no database configured changes nothing and says so", async () => {
  delete process.env.TURSO_DATABASE_URL;
  state.sessions = [session({ id: "untouched" })];
  const result = await runCinemaCleanup({ now: NOW, presence: attached(0) });
  assert.equal(result.configured, false);
  assert.equal(state.sessions[0].status, "LIVE");
});
