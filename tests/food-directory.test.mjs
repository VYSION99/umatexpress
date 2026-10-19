import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { sqliteTurso } from "./helpers/sqlite-turso.mjs";

const saved = { url: process.env.TURSO_DATABASE_URL, token: process.env.TURSO_AUTH_TOKEN };
process.env.TURSO_DATABASE_URL = "https://food-directory-test.turso.io";
process.env.TURSO_AUTH_TOKEN = "test";
const sql = sqliteTurso();
const originalFetch = globalThis.fetch;
globalThis.fetch = sql.fetch;
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ configFile: false, appType: "custom", root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => {
  await vite.close(); sql.db.close(); globalThis.fetch = originalFetch;
  if (saved.url === undefined) delete process.env.TURSO_DATABASE_URL; else process.env.TURSO_DATABASE_URL = saved.url;
  if (saved.token === undefined) delete process.env.TURSO_AUTH_TOKEN; else process.env.TURSO_AUTH_TOKEN = saved.token;
});

const food = await vite.ssrLoadModule("/lib/food/listings.ts");
const providerInput = {
  name: "Campus Bowl", description: "Rice, stew and local meals.", location: "Near the main library",
  contactLabel: "Call Campus Bowl", contactHref: "tel:+233200000000", hours: "Monday to Saturday, 7 AM to 8 PM",
  pickupDetails: "Collect from the marked service counter.",
  menuItems: [{ name: "Waakye", description: "Rice and beans", priceGhs: 25.5, dietaryNote: "Ask about allergens" }],
};

let provider;
test("draft food providers remain private until staff verification", async () => {
  provider = await food.saveFoodProvider(providerInput, "staff@example.com");
  assert.equal(provider.status, "DRAFT");
  assert.equal(provider.menuItems[0].priceGhs, 25.5);
  assert.deepEqual(await food.listPublicFoodListings(), []);

  await assert.rejects(food.decideFoodProvider({ id: provider.id, action: "PUBLISH", note: "short" }, "staff@example.com"), (error) => error.code === "VALIDATION_ERROR");
  await food.decideFoodProvider({ id: provider.id, action: "PUBLISH", note: "Confirmed by the named provider contact." }, "staff@example.com");
  const publicListings = await food.listPublicFoodListings();
  assert.equal(publicListings.length, 1);
  assert.equal(publicListings[0].name, "Campus Bowl");
  assert.equal("verificationNote" in publicListings[0], false, "internal verification notes must not reach students");
});

test("editing a published listing returns it to draft", async () => {
  await food.saveFoodProvider({ ...providerInput, id: provider.id, hours: "Monday to Friday, 8 AM to 6 PM" }, "staff@example.com");
  assert.deepEqual(await food.listPublicFoodListings(), []);
});

test("only published listings accept correction reports and staff can close them", async () => {
  await assert.rejects(food.reportFoodListing({ providerId: provider.id, category: "HOURS", message: "The closing time appears to have changed." }), (error) => error.code === "NOT_FOUND");
  await food.decideFoodProvider({ id: provider.id, action: "PUBLISH", note: "Reconfirmed by the provider after the hours change." }, "staff@example.com");
  const report = await food.reportFoodListing({ providerId: provider.id, category: "HOURS", message: "The provider was closed before the listed time." });
  const queue = await food.listFoodReports();
  assert.equal(queue[0].id, report.id);
  assert.equal(queue[0].status, "OPEN");
  await food.resolveFoodReport({ id: report.id, action: "RESOLVE", note: "Hours checked with provider." }, "staff@example.com");
  assert.equal((await food.listFoodReports())[0].status, "RESOLVED");
});

test("suspending a listing removes it from public results", async () => {
  await food.decideFoodProvider({ id: provider.id, action: "SUSPEND", note: "Provider contact could not reconfirm the listing." }, "staff@example.com");
  assert.deepEqual(await food.listPublicFoodListings(), []);
});
