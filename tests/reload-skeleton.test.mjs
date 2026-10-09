import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => vite.close());
const { ReloadSkeleton, RELOAD_SKELETON_MINIMUM_MS } = await vite.ssrLoadModule("/components/launcher/ReloadSkeleton.tsx");

test("reload placeholder mirrors the homepage structure", () => {
  const html = renderToStaticMarkup(createElement(ReloadSkeleton));
  assert.equal(RELOAD_SKELETON_MINIMUM_MS, 650);
  for (const part of ["reload-skeleton-bar", "reload-skeleton-hero", "reload-skeleton-companion", "reload-skeleton-services", "reload-skeleton-cards"]) assert.ok(html.includes(part));
  assert.equal((html.match(/<article/g) || []).length, 4);
});

test("the first-paint guard shows the skeleton only for reloads", async () => {
  const source = await readFile(new URL("../components/launcher/ReloadSkeleton.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../components/launcher/reload-skeleton.css", import.meta.url), "utf8");
  const layout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");
  assert.match(source, /navigation\?\.type === "reload"/);
  assert.match(source, /classList\.remove\("page-is-reloading"\)/);
  assert.match(css, /page-is-reloading \.reload-skeleton\{display:block/);
  assert.match(css, /prefers-reduced-motion:reduce/);
  assert.match(layout, /if\(r\)document\.documentElement\.classList\.add\('page-is-reloading'\)/);
});
