import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

/**
 * Cinema's ICE configuration: TURN credentials are minted server-side, cached
 * briefly, and never allowed to close a room when the relay is away.
 *
 * The real value of these tests is the fallback: a deployment that never
 * creates a TURN key must still connect direct calls, and a TURN request that
 * fails must degrade to STUN rather than fail the room's join.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => vite.close());

const { CINEMA_STUN_ONLY, cinemaIceServers, resetCinemaIceCache } = await vite.ssrLoadModule("/lib/cinema-engine/turn.ts");

const originalKeyId = process.env.CLOUDFLARE_TURN_KEY_ID;
const originalToken = process.env.CLOUDFLARE_TURN_API_TOKEN;

beforeEach(() => {
  delete process.env.CLOUDFLARE_TURN_KEY_ID;
  delete process.env.CLOUDFLARE_TURN_API_TOKEN;
  resetCinemaIceCache();
});

after(() => {
  if (originalKeyId === undefined) delete process.env.CLOUDFLARE_TURN_KEY_ID; else process.env.CLOUDFLARE_TURN_KEY_ID = originalKeyId;
  if (originalToken === undefined) delete process.env.CLOUDFLARE_TURN_API_TOKEN; else process.env.CLOUDFLARE_TURN_API_TOKEN = originalToken;
});

test("a deployment with no TURN key falls back to Cloudflare's public STUN", async () => {
  const result = await cinemaIceServers({ fetchImpl: () => { throw new Error("the network must not be touched"); } });
  assert.equal(result.turn, false);
  assert.deepEqual(result.iceServers, CINEMA_STUN_ONLY);
});

test("a configured deployment mints short-lived credentials and caches them", async () => {
  process.env.CLOUDFLARE_TURN_KEY_ID = "turn-key-1";
  process.env.CLOUDFLARE_TURN_API_TOKEN = "turn-api-token-1";
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls += 1;
    assert.match(String(url), /\/v1\/turn\/keys\/turn-key-1\/credentials\/generate-ice-servers$/);
    assert.equal(init.method, "POST");
    assert.equal(init.headers.authorization, "Bearer turn-api-token-1");
    assert.deepEqual(JSON.parse(init.body), { ttl: 86_400 });
    return {
      ok: true,
      async json() {
        return {
          iceServers: {
            urls: ["stun:stun.cloudflare.com:3478", "turn:turn.cloudflare.com:3478?transport=udp", "https://ignored.example"],
            username: "user-1",
            credential: "cred-1",
          },
        };
      },
    };
  };

  const first = await cinemaIceServers({ fetchImpl, now: 1_000 });
  assert.equal(first.turn, true);
  assert.equal(calls, 1);
  assert.deepEqual(first.iceServers, [{
    urls: ["stun:stun.cloudflare.com:3478", "turn:turn.cloudflare.com:3478?transport=udp"],
    username: "user-1",
    credential: "cred-1",
  }]);

  // A minute later the cached credentials are reused; an hour and change later
  // they are minted again, well before Cloudflare's own day-long expiry.
  const cached = await cinemaIceServers({ fetchImpl: () => { throw new Error("must not be called"); }, now: 61_000 });
  assert.deepEqual(cached.iceServers, first.iceServers);
  const refreshed = await cinemaIceServers({ fetchImpl, now: 3_700_000 });
  assert.equal(calls, 2);
  assert.equal(refreshed.turn, true);
});

test("a relay that refuses degrades to STUN rather than closing the room", async () => {
  process.env.CLOUDFLARE_TURN_KEY_ID = "turn-key-1";
  process.env.CLOUDFLARE_TURN_API_TOKEN = "turn-api-token-1";
  const refused = await cinemaIceServers({ fetchImpl: async () => ({ ok: false, status: 502, async json() { return {}; } }) });
  assert.equal(refused.turn, false);
  assert.deepEqual(refused.iceServers, CINEMA_STUN_ONLY);

  const empty = await cinemaIceServers({ fetchImpl: async () => ({ ok: true, async json() { return { iceServers: { urls: [] } }; } }) });
  assert.equal(empty.turn, false);
  assert.deepEqual(empty.iceServers, CINEMA_STUN_ONLY);
});
