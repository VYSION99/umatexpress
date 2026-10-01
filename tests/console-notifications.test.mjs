import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => vite.close());

test("console notifications require a live console session", async () => {
  const route = await vite.ssrLoadModule("/app/api/console/notifications/route.ts");
  const request = new Request("https://console.umatexpress.test/api/console/notifications");
  assert.equal((await route.GET(request)).status, 401);
  assert.equal((await route.PATCH(new Request(request.url, { method: "PATCH", body: "{}" }))).status, 401);
});
