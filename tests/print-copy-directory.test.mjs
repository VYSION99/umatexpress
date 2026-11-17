import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { sqliteTurso } from "./helpers/sqlite-turso.mjs";

const saved = { url: process.env.TURSO_DATABASE_URL, token: process.env.TURSO_AUTH_TOKEN };
process.env.TURSO_DATABASE_URL = "https://print-copy-test.turso.io";
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

const directory = await vite.ssrLoadModule("/lib/print-copy/directory.ts");
const input = {
  name: "Campus Print Desk", description: "Printing and binding near campus", location: "Near the main library",
  contactLabel: "Call shop", contactHref: "tel:+233200000000", hours: "Monday to Saturday, 8 AM to 6 PM",
  services: ["Black and white printing", "Spiral binding"], indicativePricing: "Ask for a quote from GH₵1 per page",
  turnaround: "Usually same day for small jobs",
};
const student = { id: "student-1", name: "Ama Student", email: "ama@st.umat.edu.gh" };
let provider;

test("only complete, verified shops are public", async () => {
  provider = await directory.savePrintCopyProvider({ ...input, indicativePricing: "" }, "staff@example.com");
  assert.deepEqual(await directory.listPublicPrintCopyProviders(), []);
  await assert.rejects(directory.decidePrintCopyProvider({ id: provider.id, action: "PUBLISH", note: "Confirmed with the shop manager." }, "staff@example.com"), (error) => error.code === "INVALID_STATE");
  provider = await directory.savePrintCopyProvider({ ...input, id: provider.id }, "staff@example.com");
  await directory.decidePrintCopyProvider({ id: provider.id, action: "PUBLISH", note: "Confirmed with the shop manager." }, "staff@example.com");
  const publicRows = await directory.listPublicPrintCopyProviders();
  assert.equal(publicRows.length, 1);
  assert.equal(publicRows[0].services.length, 2);
  assert.equal("verificationNote" in publicRows[0], false);
});

test("quote requests require a published shop and retain only the signed-in account contact", async () => {
  assert.equal((await directory.getPrintCopyQuoteSettings()).enabled, false);
  await assert.rejects(directory.createPrintCopyQuote({ providerId: provider.id, requirements: "Forty A4 pages, double sided, black and white, spiral bound." }, student), (error) => error.code === "INVALID_STATE");
  await assert.rejects(directory.setPrintCopyQuoteSettings({ enabled: true, supportOwner: "" }, "staff@example.com"), (error) => error.code === "VALIDATION_ERROR");
  await directory.setPrintCopyQuoteSettings({ enabled: true, supportOwner: "Campus services support desk" }, "staff@example.com");
  await assert.rejects(directory.createPrintCopyQuote({ providerId: provider.id, requirements: "short" }, student), (error) => error.code === "VALIDATION_ERROR");
  const created = await directory.createPrintCopyQuote({ providerId: provider.id, requirements: "Forty A4 pages, double sided, black and white, spiral bound." }, student);
  assert.match(created.reference, /^PC-[0-9A-F]{10}$/);
  const [quote] = await directory.listPrintCopyQuotes();
  assert.equal(quote.student_email, student.email);
  assert.equal(quote.student_name, student.name);
  await assert.rejects(directory.updatePrintCopyQuote({ id: quote.id, status: "CLOSED", staffNote: "Done" }), (error) => error.code === "VALIDATION_ERROR");
  await directory.updatePrintCopyQuote({ id: quote.id, status: "IN_PROGRESS", staffNote: "Shop is preparing a quote." });
  await directory.updatePrintCopyQuote({ id: quote.id, status: "CLOSED", staffNote: "Student contacted with the shop quote." });
  assert.equal((await directory.listPrintCopyQuotes())[0].status, "CLOSED");
  sql.db.prepare("UPDATE print_copy_quotes SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(quote.id);
  assert.deepEqual(await directory.listPrintCopyQuotes(), []);
  assert.equal(sql.db.prepare("SELECT count(*) AS n FROM print_copy_quotes").get().n, 1, "listing does not delete student data as a side effect");
  assert.equal(await directory.purgeExpiredPrintCopyQuotes(), 1);
  assert.equal(sql.db.prepare("SELECT count(*) AS n FROM print_copy_quotes").get().n, 0);
});

test("corrections close with a staff outcome and edits remove public visibility", async () => {
  const report = await directory.reportPrintCopyListing({ providerId: provider.id, category: "HOURS", message: "The shop closed earlier than the listed time." });
  assert.equal((await directory.listPrintCopyReports())[0].id, report.id);
  await directory.resolvePrintCopyReport({ id: report.id, action: "RESOLVE", note: "Hours reconfirmed with shop." }, "staff@example.com");
  assert.equal((await directory.listPrintCopyReports())[0].status, "RESOLVED");
  await directory.savePrintCopyProvider({ ...input, id: provider.id, hours: "Monday to Friday, 9 AM to 5 PM" }, "staff@example.com");
  assert.deepEqual(await directory.listPublicPrintCopyProviders(), []);
  await assert.rejects(directory.createPrintCopyQuote({ providerId: provider.id, requirements: "Forty A4 pages, double sided, black and white, spiral bound." }, student), (error) => error.code === "NOT_FOUND");
});

test("quote insert rechecks a concurrent switch change in the same SQL statement", async () => {
  await directory.decidePrintCopyProvider({ id: provider.id, action: "PUBLISH", note: "Reconfirmed all details with the shop manager." }, "staff@example.com");
  await directory.setPrintCopyQuoteSettings({ enabled: true, supportOwner: "Campus services support desk" }, "staff@example.com");
  let intercepted = false;
  globalThis.fetch = async (url, options) => {
    const statements = JSON.parse(options.body).requests.flatMap((request) => request.batch?.steps?.map((step) => step.stmt.sql) || (request.stmt ? [request.stmt.sql] : []));
    if (statements.some((statement) => statement.startsWith("INSERT INTO print_copy_quotes"))) {
      intercepted = true;
      sql.db.prepare("UPDATE print_copy_settings SET quotes_enabled=0 WHERE id='GLOBAL'").run();
    }
    return sql.fetch(url, options);
  };
  try {
    await assert.rejects(directory.createPrintCopyQuote({ providerId: provider.id, requirements: "Forty A4 pages, double sided, black and white, spiral bound." }, student), (error) => error.code === "INVALID_STATE");
  } finally { globalThis.fetch = sql.fetch; }
  assert.equal(intercepted, true);
  assert.equal(sql.db.prepare("SELECT count(*) AS n FROM print_copy_quotes").get().n, 0);
  await directory.setPrintCopyQuoteSettings({ enabled: true, supportOwner: "Campus services support desk" }, "staff@example.com");
  globalThis.fetch = async (url, options) => {
    const statements = JSON.parse(options.body).requests.flatMap((request) => request.batch?.steps?.map((step) => step.stmt.sql) || (request.stmt ? [request.stmt.sql] : []));
    if (statements.some((statement) => statement.startsWith("INSERT INTO print_copy_quotes"))) sql.db.prepare("UPDATE print_copy_providers SET status='SUSPENDED' WHERE id=?").run(provider.id);
    return sql.fetch(url, options);
  };
  try {
    await assert.rejects(directory.createPrintCopyQuote({ providerId: provider.id, requirements: "Forty A4 pages, double sided, black and white, spiral bound." }, student), (error) => error.code === "NOT_FOUND");
  } finally { globalThis.fetch = sql.fetch; }
  assert.equal(sql.db.prepare("SELECT count(*) AS n FROM print_copy_quotes").get().n, 0);
});

test("stale verification removes public listing and blocks new quotes", async () => {
  await directory.decidePrintCopyProvider({ id: provider.id, action: "PUBLISH", note: "Reconfirmed all details with the shop manager." }, "staff@example.com");
  await directory.setPrintCopyQuoteSettings({ enabled: true, supportOwner: "Campus services support desk" }, "staff@example.com");
  sql.db.prepare("UPDATE print_copy_providers SET verified_at='2020-01-01T00:00:00.000Z' WHERE id=?").run(provider.id);
  assert.deepEqual(await directory.listPublicPrintCopyProviders(), []);
  await assert.rejects(directory.createPrintCopyQuote({ providerId: provider.id, requirements: "Forty A4 pages, double sided, black and white, spiral bound." }, student), (error) => error.code === "NOT_FOUND");
  await assert.rejects(directory.setPrintCopyQuoteSettings({ enabled: true, supportOwner: "Campus services support desk" }, "staff@example.com"), (error) => error.code === "INVALID_STATE");
  await directory.decidePrintCopyProvider({ id: provider.id, action: "PUBLISH", note: "Reconfirmed all details with the shop manager." }, "staff@example.com");
  assert.equal((await directory.listPublicPrintCopyProviders()).length, 1);
});

test("students see only their own active quote statuses, and scheduled purge removes expired records", async () => {
  const other = { id: "student-2", name: "Kojo Student", email: "kojo@st.umat.edu.gh" };
  const created = await directory.createPrintCopyQuote({ providerId: provider.id, requirements: "Thirty colour pages, single sided, stapled in groups of five." }, student);
  await directory.createPrintCopyQuote({ providerId: provider.id, requirements: "Forty A4 pages, double sided, black and white, spiral bound." }, other);
  const own = await directory.listStudentPrintCopyQuotes(student.id);
  assert.equal(own.length, 1);
  assert.equal(own[0].reference, created.reference);
  assert.equal("requirements" in own[0], false);
  assert.equal("student_email" in own[0], false);
  assert.equal("staff_note" in own[0], false);
  const staffQuote = (await directory.listPrintCopyQuotes()).find((row) => row.reference === created.reference);
  await directory.updatePrintCopyQuote({ id: staffQuote.id, status: "IN_PROGRESS", staffNote: "Contacted shop for details." });
  assert.equal((await directory.listStudentPrintCopyQuotes(student.id))[0].status, "IN_PROGRESS");
  const notice = sql.db.prepare("SELECT recipient,subject,message FROM notification_outbox WHERE template='print_copy_quote_in_progress' AND subject LIKE ?").get(`%${created.reference}%`);
  assert.equal(notice.recipient, student.email);
  assert.match(notice.subject, new RegExp(created.reference));
  assert.doesNotMatch(notice.message, /Contacted shop for details/);
  sql.db.prepare("UPDATE print_copy_quotes SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(staffQuote.id);
  assert.equal(await directory.purgeExpiredPrintCopyQuotes(), 1);
  assert.deepEqual(await directory.listStudentPrintCopyQuotes(student.id), []);
});

test("quote status moves forward only and listing reads do not prune as a side-effect", async () => {
  // Create a fresh quote in NEW state.
  const created = await directory.createPrintCopyQuote({ providerId: provider.id, requirements: "Twenty colour pages, double sided, spiral bound for a thesis chapter." }, student);
  const [quote] = await directory.listPrintCopyQuotes();
  assert.equal(quote.reference, created.reference);
  assert.equal(quote.status, "NEW");
  // Cannot jump straight from NEW to CLOSED.
  await assert.rejects(
    directory.updatePrintCopyQuote({ id: quote.id, status: "CLOSED", staffNote: "Skipping in-progress." }),
    (error) => error.code === "INVALID_STATE",
  );
  // Advance to IN_PROGRESS.
  await directory.updatePrintCopyQuote({ id: quote.id, status: "IN_PROGRESS", staffNote: "" });
  // Cannot move backwards to NEW.
  await assert.rejects(
    directory.updatePrintCopyQuote({ id: quote.id, status: "NEW", staffNote: "" }),
    (error) => error.code === "INVALID_STATE",
  );
  // Advance to CLOSED.
  await directory.updatePrintCopyQuote({ id: quote.id, status: "CLOSED", staffNote: "Shop confirmed and student notified." });
  assert.equal((await directory.listPrintCopyQuotes()).find((r) => r.reference === created.reference).status, "CLOSED");
  // Expire the row directly; the next list read must NOT delete it (no side-effect DELETE).
  sql.db.prepare("UPDATE print_copy_quotes SET expires_at='2000-01-01T00:00:00.000Z' WHERE reference=?").run(created.reference);
  // After manually expiring, the row is hidden by the WHERE filter but still present in the DB.
  assert.equal(sql.db.prepare("SELECT count(*) AS n FROM print_copy_quotes WHERE reference=?").get(created.reference).n, 1);
  // A list read must not delete it — purge is the cron's job.
  await directory.listPrintCopyQuotes();
  assert.equal(sql.db.prepare("SELECT count(*) AS n FROM print_copy_quotes WHERE reference=?").get(created.reference).n, 1);
  // The dedicated purge function removes it.
  assert.equal(await directory.purgeExpiredPrintCopyQuotes(), 1);
  assert.equal(sql.db.prepare("SELECT count(*) AS n FROM print_copy_quotes WHERE reference=?").get(created.reference).n, 0);
});

test("report resolution requires a minimum note, closes the report, and rejects a second resolution", async () => {
  const report = await directory.reportPrintCopyListing({ providerId: provider.id, category: "PRICE", message: "Pricing listed on the page does not match what the shop charges." });
  // Note too short.
  await assert.rejects(
    directory.resolvePrintCopyReport({ id: report.id, action: "RESOLVE", note: "Ok" }, "staff@example.com"),
    (error) => error.code === "VALIDATION_ERROR",
  );
  // Invalid action.
  await assert.rejects(
    directory.resolvePrintCopyReport({ id: report.id, action: "APPROVE", note: "Pricing was reconfirmed with the shop owner." }, "staff@example.com"),
    (error) => error.code === "VALIDATION_ERROR",
  );
  // Successful RESOLVE.
  const resolved = await directory.resolvePrintCopyReport({ id: report.id, action: "RESOLVE", note: "Pricing was reconfirmed with the shop owner." }, "staff@example.com");
  assert.equal(resolved.status, "RESOLVED");
  assert.equal((await directory.listPrintCopyReports()).find((r) => r.id === report.id).status, "RESOLVED");
  // Cannot resolve an already-resolved report.
  await assert.rejects(
    directory.resolvePrintCopyReport({ id: report.id, action: "RESOLVE", note: "Trying to resolve again." }, "staff@example.com"),
    (error) => error.code === "NOT_FOUND",
  );
  // DISMISS path.
  const report2 = await directory.reportPrintCopyListing({ providerId: provider.id, category: "OTHER", message: "Contact number listed appears to be incorrect." });
  const dismissed = await directory.resolvePrintCopyReport({ id: report2.id, action: "DISMISS", note: "Verified with shop; number is correct." }, "staff@example.com");
  assert.equal(dismissed.status, "DISMISSED");
  assert.equal((await directory.listPrintCopyReports()).find((r) => r.id === report2.id).status, "DISMISSED");
});
