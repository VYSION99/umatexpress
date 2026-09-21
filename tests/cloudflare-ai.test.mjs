import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

/**
 * The Workers AI reply reader.
 *
 * Which shape a reply arrives in depends on the model named in the settings:
 * the retired instruct models answered `{ response }`, and the current ones
 * answer the OpenAI-compatible `{ choices: [{ message: { content } }] }`. A
 * model swap that silently produced "empty response" for every answer is
 * exactly the failure this file exists to prevent.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => vite.close());

const { normalizeCloudflareAiText } = await vite.ssrLoadModule("/lib/cloudflare-ai.ts");

test("the legacy response shape is read", () => {
  assert.equal(normalizeCloudflareAiText({ response: "  hello  " }), "hello");
  assert.equal(normalizeCloudflareAiText("plain"), "plain");
  assert.equal(normalizeCloudflareAiText({ text: "one", answer: "two" }), "one");
});

test("the OpenAI-compatible choices shape is read", () => {
  const reply = { choices: [{ index: 0, message: { role: "assistant", content: '{"ok":true}' }, finish_reason: "stop" }], usage: {} };
  assert.equal(normalizeCloudflareAiText(reply), '{"ok":true}');
  assert.equal(normalizeCloudflareAiText({ choices: [{ message: { content: "first" } }, { message: { content: "second" } }] }), "first\nsecond");
  assert.equal(normalizeCloudflareAiText({ choices: [{ text: "streamed" }] }), "streamed");
  assert.equal(normalizeCloudflareAiText({ choices: [{ delta: { content: "partial" } }] }), "partial");
});

test("a reply with no text anywhere is empty rather than a guess", () => {
  assert.equal(normalizeCloudflareAiText(null), "");
  assert.equal(normalizeCloudflareAiText({ choices: [] }), "");
  assert.equal(normalizeCloudflareAiText({ usage: { tokens: 3 } }), "");
  assert.equal(normalizeCloudflareAiText([{ response: "" }, { choices: [] }]), "");
});
