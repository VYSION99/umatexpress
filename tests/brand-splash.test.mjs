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
const { BrandSplash, SPLASH_DURATION_MS, SPLASH_STAGES, SPLASH_WORDMARK } = await vite.ssrLoadModule("/components/launcher/BrandSplash.tsx");

test("the opening sequence uses the exact source artwork and six-second timeline", () => {
  const html = renderToStaticMarkup(createElement(BrandSplash));
  assert.equal(SPLASH_DURATION_MS, 6000);
  assert.equal(SPLASH_STAGES.length, 12);
  assert.deepEqual(SPLASH_STAGES, [
    "darkness", "particle-emergence", "particle-convergence", "left-circuit", "right-circuit", "orbital-draw",
    "main-leaf", "lower-leaf-details", "emblem-energy-pulse", "wordmark-assembly", "underline-light-sweep", "final-reveal",
  ]);
  assert.equal(SPLASH_WORDMARK, "UMATeXPRESS");
  assert.equal((html.match(/src="\/logo-watermark\.png"/g) || []).length, 4, "the emblem uses the transparent original mark");
  assert.equal((html.match(/src="\/logo-web\.png"/g) || []).length, 12, "the eleven wordmark slices and final lock-up use the original logo");
  for (const part of ["is-left-circuit", "is-right-circuit", "is-main-leaf", "is-lower-leaf"]) assert.ok(html.includes(part));
  assert.match(html, /data-duration="6000"/);
  assert.match(html, /data-stages="12"/);
});

test("the sequence is one-shot, dismissible, and reduced-motion safe", async () => {
  const source = await readFile(new URL("../components/launcher/BrandSplash.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../components/launcher/brand-splash.css", import.meta.url), "utf8");
  const layout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");
  assert.match(source, /sessionStorage\.getItem\(STORAGE_KEY\)/);
  assert.match(source, /event\.key === "Escape"/);
  assert.match(source, /prefers-reduced-motion: reduce/);
  assert.match(source, /navigation\?\.type === "reload"/);
  assert.match(source, /classList\.remove\("brand-splash-active"\)/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)/);
  assert.match(css, /splash-already-seen \.brand-splash\{display:none\}/);
  assert.match(layout, /performance\.getEntriesByType\('navigation'\)/);
  assert.match(css, /splash-final-lock 260ms ease-out 5450ms/);
  assert.match(css, /splash-overlay-out 300ms ease 5700ms/);
});
