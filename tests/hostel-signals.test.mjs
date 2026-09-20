import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

/**
 * Trust signals. The rules only record what they noticed, deduplicated per
 * pattern and entity; a person decides what it means. These tests run the
 * scanner and the resolution path against a fake Turso.
 */

process.env.TURSO_DATABASE_URL = "https://hostel-signals-test.turso.io";
process.env.TURSO_AUTH_TOKEN = "test-token";

const state = {
  live: [], photos: [], bookings: [], messages: [], landlords: [], signals: new Map(), audits: [],
};

function cell(value) {
  if (value === null || value === undefined) return { type: "null" };
  if (typeof value === "number") return { type: Number.isInteger(value) ? "integer" : "real", value: String(value) };
  return { type: "text", value: String(value) };
}
const ok = (result) => ({ type: "ok", response: { result: result || {} } });
const empty = { cols: [], rows: [] };
const table = (columns, rows) => ({ cols: columns.map((name) => ({ name })), rows: rows.map((row) => columns.map((name) => cell(row[name]))) });
const affected = (count) => ok({ affected_row_count: count });

function handle(sql, args) {
  if (/^SELECT version FROM (campus_schema_meta|schema_passes)/.test(sql)) return ok(empty);
  if (/^INSERT OR REPLACE INTO (campus_schema_meta|schema_passes)/.test(sql)) return affected(1);
  if (/^CREATE |^ALTER |^UPDATE hostel_landlords SET commission_bps/.test(sql)) return ok(empty);

  if (/^INSERT INTO hostel_risk_signals/.test(sql)) {
    const [id, signalKey, severity, entityType, entityId, landlordId, propertyId, title, detail, evidence, createdAt, updatedAt] = args;
    const key = `${signalKey}:${entityId}:OPEN`;
    const existing = state.signals.get(key);
    state.signals.set(key, {
      id: existing?.id || id, signal_key: signalKey, severity, entity_type: entityType, entity_id: entityId,
      landlord_id: landlordId, property_id: propertyId, title, detail, evidence, status: "OPEN",
      reviewed_by: "", reviewed_at: "", review_note: "",
      created_at: existing?.created_at || createdAt, updated_at: updatedAt,
    });
    return affected(1);
  }
  if (/^SELECT id,signal_key,severity,entity_type/.test(sql)) {
    const rows = [...state.signals.values()].filter((signal) => signal.status === args[0]);
    return ok(rows.length ? table(Object.keys(rows[0]), rows) : empty);
  }
  if (/^SELECT id,status FROM hostel_risk_signals WHERE id = \? LIMIT 1/.test(sql)) {
    const row = [...state.signals.values()].find((signal) => signal.id === args[0]);
    return ok(row ? table(["id", "status"], [{ id: row.id, status: row.status }]) : empty);
  }
  if (/^UPDATE hostel_risk_signals SET status = \?/.test(sql)) {
    const [status, reviewedBy, reviewedAt, note, updatedAt, id] = args;
    const row = [...state.signals.values()].find((signal) => signal.id === id);
    if (row) {
      state.signals.delete(`${row.signal_key}:${row.entity_id}:${row.status}`);
      Object.assign(row, { status, reviewed_by: reviewedBy, reviewed_at: reviewedAt, review_note: note, updated_at: updatedAt });
      state.signals.set(`${row.signal_key}:${row.entity_id}:${status}`, row);
    }
    return affected(row ? 1 : 0);
  }
  if (/^INSERT INTO admin_audit_logs/.test(sql)) {
    state.audits.push({ admin_email: args[1], action: args[2], target_type: args[3], target_reference: args[4], details: args[5] });
    return affected(1);
  }

  if (/FROM hostel_listings l\s+JOIN hostel_spaces s/.test(sql)) return ok(state.live.length ? table(LIVE_COLUMNS, state.live) : empty);
  if (/FROM hostel_property_photos WHERE COALESCE\(r2_key,''\) <> '' GROUP BY r2_key/.test(sql)) {
    const grouped = new Map();
    state.photos.forEach((photo) => {
      const entry = grouped.get(photo.r2_key) || { r2_key: photo.r2_key, property_ids: new Set(), photos: 0 };
      entry.property_ids.add(photo.property_id);
      entry.photos += 1;
      grouped.set(photo.r2_key, entry);
    });
    const rows = [...grouped.values()].filter((entry) => entry.property_ids.size > 1)
      .map((entry) => ({ r2_key: entry.r2_key, properties: entry.property_ids.size, property_ids: [...entry.property_ids].join(","), photos: entry.photos }));
    return ok(rows.length ? table(["r2_key", "properties", "property_ids", "photos"], rows) : empty);
  }
  if (/GROUP BY student_email, period_id HAVING beds > \?/.test(sql)) {
    const grouped = new Map();
    state.bookings.filter((booking) => booking.status === "PAID").forEach((booking) => {
      const key = `${booking.student_email}:${booking.period_id}`;
      grouped.set(key, (grouped.get(key) || 0) + 1);
    });
    const rows = [...grouped.entries()].filter(([, beds]) => beds > Number(args[0]))
      .map(([key, beds]) => ({ student_email: key.split(":")[0], period_id: key.split(":")[1], beds }));
    return ok(rows.length ? table(["student_email", "period_id", "beds"], rows) : empty);
  }
  if (/FROM hostel_messages m JOIN hostel_bookings b ON b.id = m.booking_id/.test(sql)) {
    return ok(state.messages.length ? table(MESSAGE_COLUMNS, state.messages) : empty);
  }
  if (/GROUP BY payout_bank_code, payout_account_last4 HAVING landlords > 1/.test(sql)) {
    const grouped = new Map();
    state.landlords.filter((landlord) => landlord.payout_account_last4).forEach((landlord) => {
      const key = `${landlord.payout_bank_code}:${landlord.payout_account_last4}`;
      const entry = grouped.get(key) || { payout_bank_code: landlord.payout_bank_code, payout_account_last4: landlord.payout_account_last4, landlords: 0, names: [] };
      entry.landlords += 1;
      entry.names.push(landlord.name);
      grouped.set(key, entry);
    });
    const rows = [...grouped.values()].filter((entry) => entry.landlords > 1).map((entry) => ({ ...entry, names: entry.names.join(",") }));
    return ok(rows.length ? table(["payout_bank_code", "payout_account_last4", "landlords", "names"], rows) : empty);
  }
  return ok(empty);
}

const LIVE_COLUMNS = ["listing_id", "price", "period_id", "listing_status", "property_id", "landlord_id", "property_name", "kyc_status", "landlord_name"];
const MESSAGE_COLUMNS = ["id", "booking_id", "content", "sender_type", "created_at", "landlord_id", "property_id", "reference"];

globalThis.fetch = async (url, init) => {
  const target = String(typeof url === "string" ? url : url?.url || "");
  if (target.startsWith("https://hostel-signals-test.turso.io")) {
    const body = JSON.parse(init.body);
    const results = body.requests.filter((request) => request.type === "execute").map(({ stmt }) => handle(stmt.sql, (stmt.args || []).map((arg) => (arg.type === "null" ? null : arg.value))));
    return { ok: true, json: async () => ({ results }) };
  }
  throw new Error(`Unhandled request to ${target}`);
};

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => vite.close());

const { listHostelSignals, resolveHostelSignal, scanHostelSignals } = await vite.ssrLoadModule("/lib/hostel-engine/signals.ts");

beforeEach(() => {
  state.live = [];
  state.photos = [];
  state.bookings = [];
  state.messages = [];
  state.landlords = [];
  state.signals = new Map();
  state.audits = [];
});

function liveListing(overrides = {}) {
  return {
    listing_id: "listing-1", price: 100_000, period_id: "period-1", listing_status: "APPROVED",
    property_id: "property-1", landlord_id: "landlord-1", property_name: "Owusu Lodge",
    kyc_status: "VERIFIED", landlord_name: "Mr. Owusu", ...overrides,
  };
}

test("a bed priced far from the year is raised once, then refreshed", async () => {
  state.live = [1, 2, 3, 4, 5].map((index) => liveListing({ listing_id: `listing-${index}`, price: 100_000 }));
  state.live.push(liveListing({ listing_id: "listing-9", price: 600_000, property_name: "Golden Gate" }));
  const first = await scanHostelSignals();
  assert.equal(first.bySeverity.MEDIUM, 1);
  const raised = (await listHostelSignals()).find((signal) => signal.signalKey === "price_outlier");
  assert.equal(raised.entityId, "listing-9");
  assert.equal(raised.evidence.multiple, 6);
  const raisedAt = raised.updatedAt;

  const second = await scanHostelSignals();
  assert.equal(second.raised, 1, "a rescan refreshes the row instead of stacking a duplicate");
  assert.equal((await listHostelSignals()).filter((signal) => signal.signalKey === "price_outlier").length, 1);
  assert.ok((await listHostelSignals())[0].updatedAt >= raisedAt);
});

test("a live listing behind an unverified landlord is high severity", async () => {
  state.live = [liveListing({ kyc_status: "PENDING" })];
  const result = await scanHostelSignals();
  assert.equal(result.bySeverity.HIGH, 1);
  const raised = (await listHostelSignals()).find((signal) => signal.signalKey === "kyc_unverified_live");
  assert.equal(raised.severity, "HIGH");
  assert.match(raised.detail, /KYC is PENDING/);
});

test("bed hoarding, reused photos and a shared payout account are noticed", async () => {
  state.bookings = [1, 2, 3, 4].map((index) => ({ student_email: "ama@st.umat.edu.gh", period_id: "period-1", status: "PAID", id: `booking-${index}` }));
  state.photos = [
    { r2_key: "hostel/1/property-1/photo-1", property_id: "property-1" },
    { r2_key: "hostel/1/property-1/photo-1", property_id: "property-2" },
  ];
  state.landlords = [
    { name: "Mr. Owusu", payout_bank_code: "040100", payout_account_last4: "1234" },
    { name: "Mrs. Adansi", payout_bank_code: "040100", payout_account_last4: "1234" },
  ];
  await scanHostelSignals();
  const keys = (await listHostelSignals()).map((signal) => signal.signalKey);
  assert.ok(keys.includes("bed_hoarding"), "four paid beds for one student in one year");
  assert.ok(keys.includes("photo_reused"), "one image on two buildings");
  assert.ok(keys.includes("shared_payout_account"), "two landlords pointing at one account");
  assert.equal((await listHostelSignals()).find((signal) => signal.signalKey === "bed_hoarding").severity, "MEDIUM");
  assert.equal((await listHostelSignals()).find((signal) => signal.signalKey === "shared_payout_account").severity, "LOW");
});

test("payment talk outside the platform is raised from the thread", async () => {
  state.messages = [
    { id: "message-1", booking_id: "booking-1", content: "Please send the money to my momo 0244000111 instead", sender_type: "HOST", created_at: "2026-09-19T10:00:00.000Z", landlord_id: "landlord-1", property_id: "property-1", reference: "HL-1" },
    { id: "message-2", booking_id: "booking-1", content: "The gate closes at nine.", sender_type: "HOST", created_at: "2026-09-19T10:05:00.000Z", landlord_id: "landlord-1", property_id: "property-1", reference: "HL-1" },
  ];
  await scanHostelSignals();
  const signals = await listHostelSignals();
  assert.equal(signals.filter((signal) => signal.signalKey === "off_platform_payment").length, 1);
  assert.equal(signals.find((signal) => signal.signalKey === "off_platform_payment").entityId, "message-1");
});

test("a signal closes only with a note, is audited, and can be raised again", async () => {
  state.live = [liveListing({ kyc_status: "PENDING" })];
  await scanHostelSignals();
  const signal = (await listHostelSignals())[0];

  await assert.rejects(
    () => resolveHostelSignal({ signalId: signal.id, action: "REVIEW", note: "   ", actor: "mod@umat.edu.gh" }),
    (error) => error?.code === "VALIDATION_ERROR",
  );
  const reviewed = await resolveHostelSignal({ signalId: signal.id, action: "REVIEW", note: "Called the landlord; KYC received today.", actor: "mod@umat.edu.gh" });
  assert.equal(reviewed.status, "REVIEWED");
  assert.equal(state.audits.filter((audit) => audit.action === "hostel_signal_reviewed").length, 1);
  await assert.rejects(
    () => resolveHostelSignal({ signalId: signal.id, action: "DISMISS", note: "again", actor: "mod@umat.edu.gh" }),
    (error) => error?.code === "INVALID_STATE",
  );
  assert.equal((await listHostelSignals({ status: "REVIEWED" })).length, 1);
  assert.equal((await listHostelSignals({ status: "OPEN" })).length, 0);

  await scanHostelSignals();
  assert.equal((await listHostelSignals({ status: "OPEN" })).length, 1, "a pattern that returns is raised again");
});
