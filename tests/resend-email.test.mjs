import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => vite.close());

const { resendReady, looksLikeEmail, buildEmailRequest, sendEmail, RESEND_ENDPOINT } = await vite.ssrLoadModule("/lib/resend.ts");
const config = { apiKey: "re_123", from: "UMaTeXPRESS <rides@umatexpress.app>" };

test("Resend needs both an API key and a verified sender", () => {
  assert.equal(resendReady(config), true);
  assert.equal(resendReady({ apiKey: "re_123" }), false);
  assert.equal(resendReady({ from: "rides@umatexpress.app" }), false);
  assert.equal(resendReady({ apiKey: "  ", from: "  " }), false);
});

test("only a real address is attempted", () => {
  assert.equal(looksLikeEmail("ama@st.umat.edu.gh"), true);
  assert.equal(looksLikeEmail("  ama@st.umat.edu.gh  "), true);
  // Rows left behind by the retired SMS providers stored a phone number here.
  assert.equal(looksLikeEmail("0540000000"), false);
  assert.equal(looksLikeEmail(""), false);
  assert.equal(looksLikeEmail("not-an-address@"), false);
});

test("the request is a bearer-authenticated JSON email", () => {
  const request = buildEmailRequest({ config, to: "ama@st.umat.edu.gh", subject: "Your campusRide driver has arrived", text: "Driver arrived." });
  assert.equal(request.url, RESEND_ENDPOINT);
  assert.equal(request.headers.authorization, "Bearer re_123");
  assert.equal(request.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(request.body), {
    from: "UMaTeXPRESS <rides@umatexpress.app>",
    to: ["ama@st.umat.edu.gh"],
    subject: "Your campusRide driver has arrived",
    text: "Driver arrived.",
  });
});

test("a reply-to is included only when it is configured", () => {
  const input = { config, to: "ama@st.umat.edu.gh", subject: "s", text: "t" };
  assert.equal("reply_to" in JSON.parse(buildEmailRequest(input).body), false);
  const withReply = buildEmailRequest({ ...input, config: { ...config, replyTo: "support@umatexpress.app" } });
  assert.equal(JSON.parse(withReply.body).reply_to, "support@umatexpress.app");
});

test("a failed send is returned rather than thrown, and reports the provider detail", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ message: "domain is not verified" }), { status: 403 });
    const failure = await sendEmail({ config, to: "ama@st.umat.edu.gh", subject: "s", text: "t" });
    assert.equal(failure.ok, false);
    assert.match(failure.error, /Resend HTTP 403/);
    assert.match(failure.error, /domain is not verified/);

    globalThis.fetch = async () => Response.json({ id: "email-1" });
    assert.deepEqual(await sendEmail({ config, to: "ama@st.umat.edu.gh", subject: "s", text: "t" }), { ok: true, id: "email-1" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
