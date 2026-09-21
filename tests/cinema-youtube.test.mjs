import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

/**
 * The lobby's YouTube search: the key stays on the server, the query is rate
 * limited, and the tray carries only rows a room would accept.
 *
 * The route runs against a fake Turso (accounts and rate-limit windows) and a
 * fake YouTube, so a changed request — the wrong endpoint, a missing
 * `videoEmbeddable`, the key missing from the call — fails here rather than in
 * production, and the mapper's refusals are asserted on their own.
 */

process.env.TURSO_DATABASE_URL = "https://cinema-youtube-test.turso.io";
process.env.TURSO_AUTH_TOKEN = "test-token";
process.env.STUDENT_SESSION_SECRET = "test-student-session-secret-at-least-32-chars";

const ACCOUNT = { id: "student-searcher", email: "ama@st.umat.edu.gh", name: "Ama Searcher", active: 1 };

function cell(value) {
  if (value === null || value === undefined) return { type: "null" };
  if (typeof value === "number") return { type: Number.isInteger(value) ? "integer" : "real", value: String(value) };
  return { type: "text", value: String(value) };
}
function table(columns, rows) {
  return { cols: columns.map((name) => ({ name })), rows: rows.map((row) => columns.map((name) => cell(row[name]))) };
}
const empty = { cols: [], rows: [] };
const ok = (result) => ({ type: "ok", response: { result: result || {} } });
const affected = (count) => ok({ affected_row_count: count });

function handle(sql, args) {
  if (/^SELECT version FROM (campus_schema_meta|schema_passes)/.test(sql)) return ok(empty);
  if (/^INSERT OR REPLACE INTO (campus_schema_meta|schema_passes)/.test(sql)) return affected(1);
  if (/^CREATE (TABLE|INDEX|UNIQUE INDEX)/.test(sql)) return ok(empty);
  if (/^ALTER TABLE/.test(sql)) return ok(empty);

  // The Turso rate-limit store, which the route uses when no Durable Object is bound.
  if (/^DELETE FROM rate_limit_windows/.test(sql)) return affected(0);
  if (/^INSERT INTO rate_limit_windows/.test(sql)) return ok(table(["count"], [{ count: 1 }]));
  if (/^SELECT count FROM rate_limit_windows/.test(sql)) return ok(table(["count"], [{ count: 1 }]));

  // The account behind the session cookie.
  if (/^PRAGMA table_info\(student_accounts\)/.test(sql)) {
    return ok(table(["name"], ["id", "email", "name", "phone", "password_hash", "password_salt", "password_iterations", "token_version", "email_verified", "active", "created_at", "updated_at", "last_login_at"].map((name) => ({ name }))));
  }
  if (/^SELECT COALESCE\(token_version,0\) AS token_version FROM student_accounts/.test(sql)) {
    return ok(args[0] === ACCOUNT.id ? table(["token_version"], [{ token_version: 0 }]) : empty);
  }
  if (/FROM student_accounts WHERE id = \? LIMIT 1/.test(sql)) {
    return ok(args[0] === ACCOUNT.id ? table(
      ["id", "email", "name", "phone", "created_at", "last_login_at", "token_version", "active"],
      [{ ...ACCOUNT, phone: "", created_at: "2026-09-01T00:00:00.000Z", last_login_at: "", token_version: 0 }],
    ) : empty);
  }

  throw new Error(`Unhandled SQL in the YouTube test: ${sql}`);
}

/** The fake YouTube: the request is kept so its query string can be asserted. */
const youtube = { status: 200, payload: { items: [] }, url: "" };

globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url.startsWith("https://www.googleapis.com/youtube/v3/search")) {
    youtube.url = url;
    if (youtube.status !== 200) return { ok: false, status: youtube.status, json: async () => ({ error: { message: "quota" } }) };
    return { ok: true, status: 200, json: async () => youtube.payload };
  }
  const body = JSON.parse(init.body);
  const results = body.requests
    .filter((request) => request.type === "execute")
    .map(({ stmt }) => handle(stmt.sql, (stmt.args || []).map((arg) => (arg.type === "null" ? null : arg.value))));
  results.push({ type: "ok" });
  return { ok: true, json: async () => ({ results }) };
};

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => vite.close());

const { youTubeResults } = await vite.ssrLoadModule("/lib/cinema-engine/youtube.ts");
const { studentSessionCookie } = await vite.ssrLoadModule("/lib/student-auth.ts");
const route = await vite.ssrLoadModule("/app/api/cinema/youtube/route.ts");

const origin = "https://umatexpress.test";
async function search(query, { cookie = true } = {}) {
  const headers = cookie ? { cookie: await studentSessionCookie(ACCOUNT.id, new Request(`${origin}/`)) } : {};
  return route.GET(new Request(`${origin}/api/cinema/youtube?q=${encodeURIComponent(query)}`, { headers }));
}

/** One item shaped like YouTube's; the mapper's own cases overwrite fields. */
function item(videoId, title = "A lecture", channel = "UMaT Lectures") {
  return {
    id: { videoId },
    snippet: { title, channelTitle: channel, thumbnails: { medium: { url: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg` } } },
  };
}

test("the tray keeps only rows a room would accept", () => {
  const rows = youTubeResults({ items: [
    item("dQw4w9WgXcQ", "Integration by parts", "SkemiCity Academy"),
    item("short"),                                        // not an eleven-character id
    item("dQw4w9WgXcQ", "The same video again"),          // duplicate
    { id: { videoId: "abcdefghijk" }, snippet: { title: "  " , thumbnails: { medium: { url: "https://evil.example/x.jpg" } } } },
  ] });
  assert.deepEqual(rows.map((row) => row.videoId), ["dQw4w9WgXcQ", "abcdefghijk"]);
  assert.equal(rows[0].title, "Integration by parts");
  assert.equal(rows[0].channel, "SkemiCity Academy");
  assert.match(rows[0].thumbnail, /^https:\/\/i\.ytimg\.com\//);
  assert.equal(rows[1].title, "Untitled video", "an empty title is named, not printed");
  assert.equal(rows[1].thumbnail, "", "a thumbnail from anywhere but YouTube is dropped");
  assert.deepEqual(youTubeResults({ nope: true }), [], "a payload with no items is an empty tray");
});

test("search needs an account, real words and a configured key", async () => {
  delete process.env.YOUTUBE_API_KEY;
  const anonymous = await search("physics", { cookie: false });
  assert.equal(anonymous.status, 401);

  const short = await search("p");
  assert.equal(short.status, 400);
  assert.match((await short.json()).error, /two letters/);

  const unconfigured = await search("physics");
  assert.equal(unconfigured.status, 503);
  assert.match((await unconfigured.json()).error, /not switched on/i);
});

test("a configured search asks YouTube for embeddable videos and returns the tray", async () => {
  process.env.YOUTUBE_API_KEY = "test-youtube-key";
  youtube.status = 200;
  youtube.payload = { items: [item("dQw4w9WgXcQ", "Naive Gaussian Elimination", "SkemiCity Academy")] };
  const response = await search("gaussian elimination");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.results.map((row) => row.title), ["Naive Gaussian Elimination"]);

  const url = new URL(youtube.url);
  assert.equal(url.origin + url.pathname, "https://www.googleapis.com/youtube/v3/search");
  assert.equal(url.searchParams.get("part"), "snippet");
  assert.equal(url.searchParams.get("type"), "video");
  assert.equal(url.searchParams.get("videoEmbeddable"), "true", "only videos a room can embed");
  assert.equal(url.searchParams.get("safeSearch"), "strict");
  assert.equal(url.searchParams.get("maxResults"), "8");
  assert.equal(url.searchParams.get("q"), "gaussian elimination");
  assert.equal(url.searchParams.get("key"), "test-youtube-key");
  delete process.env.YOUTUBE_API_KEY;
});

test("a refused upstream is a friendly refusal, not a stack trace", async () => {
  process.env.YOUTUBE_API_KEY = "test-youtube-key";
  youtube.status = 500;
  const response = await search("physics");
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /YouTube would not answer/);
  youtube.status = 200;
  delete process.env.YOUTUBE_API_KEY;
});
