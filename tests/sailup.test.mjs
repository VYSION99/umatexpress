import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

/**
 * The SMS channel's provider surface. Sailup is billed by the segment, so these
 * hold the two things that cost money — who a text may be sent to, and how long
 * it is allowed to get — as well as the shape of the request the account is
 * charged for. Nothing here needs a key or a network.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => vite.close());

const {
  SAILUP_ENDPOINT, sailupReady, normalizeGhanaPhone, looksLikePhone,
  smsSegments, buildSmsRequest, sendSms,
} = await vite.ssrLoadModule("/lib/sailup.ts");
const { smsBody, NOTIFICATION_CHANNELS } = await vite.ssrLoadModule("/lib/notifications.ts");

const config = { apiKey: "sailup_live_key", senderId: "UMaTeXPRESS" };

test("Sailup needs a key and a registered sender ID", () => {
  assert.equal(sailupReady(config), true);
  assert.equal(sailupReady({ apiKey: "sailup_live_key" }), false);
  assert.equal(sailupReady({ senderId: "UMaTeXPRESS" }), false);
  assert.equal(sailupReady({ apiKey: "  ", senderId: "  " }), false);
});

test("the three ways a Ghanaian number is written become one recipient", () => {
  assert.equal(normalizeGhanaPhone("0201234567"), "+233201234567");
  assert.equal(normalizeGhanaPhone("233201234567"), "+233201234567");
  assert.equal(normalizeGhanaPhone("+233201234567"), "+233201234567");
  assert.equal(normalizeGhanaPhone("+233 20 123 4567"), "+233201234567");
  assert.equal(normalizeGhanaPhone("00233201234567"), "+233201234567");
  assert.equal(normalizeGhanaPhone("201234567"), "+233201234567");
});

test("an address, a landline or a truncated number is refused before it costs anything", () => {
  // Rows queued by the retired SMS providers stored whatever the caller had.
  assert.equal(looksLikePhone("ama@st.umat.edu.gh"), false);
  assert.equal(looksLikePhone(""), false);
  assert.equal(looksLikePhone("12345"), false);
  assert.equal(looksLikePhone("020123456"), false);
  assert.equal(looksLikePhone("0123456789"), false);
  assert.equal(looksLikePhone("+1 202 555 0143"), false);
  assert.equal(normalizeGhanaPhone("+1 202 555 0143"), "");
});

test("the request is a bearer-authenticated JSON text to the documented endpoint", () => {
  const request = buildSmsRequest({ config, to: "0201234567", text: "Your campusRide driver has arrived." });
  assert.equal(request.url, SAILUP_ENDPOINT);
  assert.equal(request.headers.authorization, "Bearer sailup_live_key");
  assert.equal(request.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(request.body), {
    from: "UMaTeXPRESS",
    to: ["+233201234567"],
    body: "Your campusRide driver has arrived.",
  });
});

test("a base URL override sends a staging project to its own endpoint", () => {
  const request = buildSmsRequest({ config: { ...config, baseUrl: "https://api.sailup.io/v1/sms/staging/" }, to: "0201234567", text: "t" });
  assert.equal(request.url, "https://api.sailup.io/v1/sms/staging/");
});

test("cost is counted in segments, which is what Sailup bills", () => {
  assert.equal(smsSegments(""), 0);
  assert.equal(smsSegments("a".repeat(160)), 1);
  assert.equal(smsSegments("a".repeat(161)), 2);
  assert.equal(smsSegments("a".repeat(480)), 3);
});

test("the text carries the link bare and stops at three segments", () => {
  assert.equal(smsBody("Driver arrived.", ""), "Driver arrived.");
  assert.equal(smsBody("Driver arrived.", "https://umx.app/t/CR-9"), "Driver arrived.\nhttps://umx.app/t/CR-9");
  const capped = smsBody("a".repeat(600), "https://umx.app/t/CR-9");
  assert.equal(capped.length, 480);
  assert.equal(capped.endsWith("…"), true);
  assert.equal(smsSegments(capped), 3);
});

test("the queue accepts sms as a channel and keeps email the default", () => {
  assert.deepEqual([...NOTIFICATION_CHANNELS], ["email", "sms"]);
});

test("a failed send is returned rather than thrown, and reports the provider detail", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ message: "sender ID not approved" }), { status: 422 });
    const failure = await sendSms({ config, to: "0201234567", text: "t" });
    assert.equal(failure.ok, false);
    assert.match(failure.error, /Sailup HTTP 422/);
    assert.match(failure.error, /sender ID not approved/);

    // Sailup queues rather than delivers, so the 202 and its id are success.
    globalThis.fetch = async () => new Response(JSON.stringify({ id: "58cf292d", quantity: 2 }), { status: 202 });
    assert.deepEqual(await sendSms({ config, to: "0201234567", text: "t" }), { ok: true, id: "58cf292d", segments: 2 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
