import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

/**
 * The hostel analytics board. Every figure is folded from the ledgers the
 * operational screens write, so these tests pin the arithmetic: occupancy, the
 * money split, a zero-filled trend, and the per-property leaderboard.
 */

process.env.TURSO_DATABASE_URL = "https://hostel-analytics-test.turso.io";
process.env.TURSO_AUTH_TOKEN = "test-token";

const state = {
  bookings: [], spaces: [], payouts: [], listings: [], properties: [], landlords: [], reviews: [], messages: [],
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
const groupCount = (rows, key) => {
  const grouped = new Map();
  rows.forEach((row) => grouped.set(row[key], (grouped.get(row[key]) || 0) + 1));
  return table([key, "count"], [...grouped.entries()].map(([name, count]) => ({ [key]: name, count })));
};

function handle(sql) {
  if (/^SELECT version FROM (campus_schema_meta|schema_passes)/.test(sql)) return ok(empty);
  if (/^INSERT OR REPLACE INTO (campus_schema_meta|schema_passes)/.test(sql)) return affected(1);
  if (/^CREATE |^ALTER |^UPDATE hostel_landlords/.test(sql)) return ok(empty);

  if (/^SELECT COALESCE\(status,'PENDING_PAYMENT'\) AS status, COUNT\(\*\) AS count, COALESCE\(SUM\(total_amount\),0\) AS amount FROM hostel_bookings GROUP BY status/.test(sql)) {
    const grouped = new Map();
    state.bookings.forEach((booking) => {
      const current = grouped.get(booking.status) || { count: 0, amount: 0 };
      grouped.set(booking.status, { count: current.count + 1, amount: current.amount + Number(booking.total_amount || 0) });
    });
    return ok(table(["status", "count", "amount"], [...grouped.entries()].map(([status, value]) => ({ status, ...value }))));
  }
  if (/^SELECT substr\(paid_at,1,10\) AS day/.test(sql)) {
    const grouped = new Map();
    state.bookings.filter((booking) => booking.status === "PAID").forEach((booking) => {
      const day = String(booking.paid_at || "").slice(0, 10);
      const current = grouped.get(day) || { count: 0, amount: 0 };
      grouped.set(day, { count: current.count + 1, amount: current.amount + Number(booking.total_amount || 0) });
    });
    return ok(table(["day", "count", "amount"], [...grouped.entries()].map(([day, value]) => ({ day, ...value }))));
  }
  if (/^SELECT student_email, COUNT\(\*\) AS count FROM hostel_bookings WHERE status = 'PAID'/.test(sql)) {
    const grouped = new Map();
    state.bookings.filter((booking) => booking.status === "PAID").forEach((booking) => grouped.set(booking.student_email, (grouped.get(booking.student_email) || 0) + 1));
    return ok(table(["student_email", "count"], [...grouped.entries()].map(([student_email, count]) => ({ student_email, count }))));
  }
  if (/^SELECT COALESCE\(status,'DRAFT'\) AS status, COUNT\(\*\) AS count FROM hostel_listings/.test(sql)) return ok(groupCount(state.listings, "status"));
  if (/^SELECT COALESCE\(status,'DRAFT'\) AS status, COUNT\(\*\) AS count FROM hostel_properties/.test(sql)) return ok(groupCount(state.properties, "status"));
  if (/^SELECT COUNT\(\*\) AS total, COALESCE\(SUM\(CASE WHEN status = 'OCCUPIED'/.test(sql)) {
    return ok(table(["total", "occupied"], [{
      total: state.spaces.length,
      occupied: state.spaces.filter((space) => space.status === "OCCUPIED").length,
    }]));
  }
  if (/^SELECT COALESCE\(kyc_status,'PENDING'\) AS status, COUNT\(\*\) AS count FROM hostel_landlords/.test(sql)) {
    const grouped = new Map();
    state.landlords.forEach((landlord) => grouped.set(landlord.kyc_status, (grouped.get(landlord.kyc_status) || 0) + 1));
    return ok(table(["status", "count"], [...grouped.entries()].map(([status, count]) => ({ status, count }))));
  }
  if (/^SELECT COALESCE\(status,'ACCRUED'\) AS status, COUNT\(\*\) AS count/.test(sql)) {
    const grouped = new Map();
    state.payouts.forEach((payout) => {
      const current = grouped.get(payout.status) || { count: 0, amount: 0, gross: 0, commission: 0 };
      grouped.set(payout.status, {
        count: current.count + 1,
        amount: current.amount + Number(payout.net_amount || 0),
        gross: current.gross + Number(payout.gross_amount || 0),
        commission: current.commission + Number(payout.commission_amount || 0),
      });
    });
    return ok(table(["status", "count", "amount", "gross", "commission"], [...grouped.entries()].map(([status, value]) => ({ status, ...value }))));
  }
  if (/^SELECT COUNT\(\*\) AS count, COALESCE\(AVG\(rating\),0\) AS average/.test(sql)) {
    const hidden = state.reviews.filter((review) => review.status === "HIDDEN").length;
    const published = state.reviews.filter((review) => review.status !== "HIDDEN");
    return ok(table(["count", "average", "hidden"], [{
      count: published.length,
      average: published.length ? published.reduce((total, review) => total + Number(review.rating), 0) / published.length : 0,
      hidden,
    }]));
  }
  if (/^SELECT COUNT\(DISTINCT booking_id\) AS threads/.test(sql)) {
    return ok(table(["threads", "recent"], [{ threads: new Set(state.messages.map((message) => message.booking_id)).size, recent: 3 }]));
  }
  if (/^SELECT p\.id AS id, p\.name AS name, COUNT\(b\.id\) AS bookings/.test(sql)) {
    const grouped = new Map();
    state.bookings.filter((booking) => booking.status === "PAID").forEach((booking) => {
      const property = state.properties.find((item) => item.id === booking.property_id) || { name: "" };
      const current = grouped.get(booking.property_id) || { id: booking.property_id, name: property.name, bookings: 0, revenue: 0 };
      grouped.set(booking.property_id, { ...current, bookings: current.bookings + 1, revenue: current.revenue + Number(booking.total_amount || 0) });
    });
    return ok(table(["id", "name", "bookings", "revenue"], [...grouped.values()].sort((left, right) => right.revenue - left.revenue)));
  }
  if (/^SELECT property_id, COUNT\(\*\) AS count, AVG\(rating\) AS average\s+FROM hostel_reviews/.test(sql)) {
    const grouped = new Map();
    state.reviews.filter((review) => review.status === "PUBLISHED").forEach((review) => {
      const current = grouped.get(review.property_id) || { count: 0, total: 0 };
      grouped.set(review.property_id, { count: current.count + 1, total: current.total + Number(review.rating) });
    });
    return ok(table(["property_id", "count", "average"], [...grouped.entries()].map(([property_id, value]) => ({ property_id, count: value.count, average: value.total / value.count }))));
  }
  return ok(empty);
}

globalThis.fetch = async (url, init) => {
  const target = String(typeof url === "string" ? url : url?.url || "");
  if (target.startsWith("https://hostel-analytics-test.turso.io")) {
    const body = JSON.parse(init.body);
    const results = body.requests.filter((request) => request.type === "execute").map(({ stmt }) => handle(stmt.sql));
    return { ok: true, json: async () => ({ results }) };
  }
  throw new Error(`Unhandled request to ${target}`);
};

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => vite.close());

const { hostelAnalytics, hostelBookingTrend } = await vite.ssrLoadModule("/lib/hostel-engine/analytics.ts");

beforeEach(() => {
  state.bookings = [];
  state.spaces = [];
  state.payouts = [];
  state.listings = [];
  state.properties = [];
  state.landlords = [];
  state.reviews = [];
  state.messages = [];
});

function seed() {
  state.properties = [{ id: "property-1", name: "Owusu Lodge", status: "ACTIVE" }, { id: "property-2", name: "Adansi Court", status: "DRAFT" }];
  state.landlords = [{ id: "landlord-1", kyc_status: "VERIFIED" }, { id: "landlord-2", kyc_status: "PENDING" }];
  state.listings = [{ status: "APPROVED" }, { status: "APPROVED" }, { status: "PENDING_REVIEW" }];
  state.spaces = [{ status: "OCCUPIED" }, { status: "OCCUPIED" }, { status: "AVAILABLE" }, { status: "AVAILABLE" }];
  state.bookings = [
    { student_email: "ama@st.umat.edu.gh", status: "PAID", total_amount: 125_000, paid_at: "2026-09-01T10:00:00.000Z", property_id: "property-1" },
    { student_email: "ama@st.umat.edu.gh", status: "PAID", total_amount: 100_000, paid_at: "2026-09-03T10:00:00.000Z", property_id: "property-1" },
    { student_email: "kofi@st.umat.edu.gh", status: "PENDING_PAYMENT", total_amount: 90_000, paid_at: "", property_id: "property-2" },
    { student_email: "efua@st.umat.edu.gh", status: "REFUNDED", total_amount: 80_000, paid_at: "", property_id: "property-2" },
  ];
  state.payouts = [
    { status: "ACCRUED", gross_amount: 100_000, commission_amount: 3_000, net_amount: 97_000 },
    { status: "RELEASED", gross_amount: 125_000, commission_amount: 3_750, net_amount: 121_250 },
    { status: "REVERSED", gross_amount: 80_000, commission_amount: 2_400, net_amount: 77_600 },
  ];
  state.reviews = [
    { property_id: "property-1", rating: 5, status: "PUBLISHED" },
    { property_id: "property-1", rating: 4, status: "PUBLISHED" },
    { property_id: "property-1", rating: 1, status: "HIDDEN" },
  ];
  state.messages = [{ booking_id: "b1" }, { booking_id: "b1" }, { booking_id: "b2" }];
}

test("the trend zero-fills quiet days and keeps today last", () => {
  const trend = hostelBookingTrend([{ day: "2026-09-19", count: 2, amount: 500 }], 3, new Date("2026-09-20T12:00:00Z"));
  assert.deepEqual(trend.map((day) => day.day), ["2026-09-18", "2026-09-19", "2026-09-20"]);
  assert.equal(trend[0].count, 0, "a day with no booking is a zero row, not a missing one");
  assert.equal(trend[1].amount, 500);
  assert.equal(trend[2].count, 0);
});

test("the board folds occupancy, the pipeline and the money ledger", async () => {
  seed();
  const analytics = await hostelAnalytics({ now: new Date("2026-09-20T12:00:00Z") });
  assert.equal(analytics.occupancy.total, 4);
  assert.equal(analytics.occupancy.occupied, 2);
  assert.equal(analytics.occupancy.rate, 0.5);
  assert.equal(analytics.bookings.paid, 2);
  assert.equal(analytics.bookings.pendingPayment, 1);
  assert.equal(analytics.bookings.refunded, 1);
  assert.equal(analytics.bookings.paidValue, 225_000);
  assert.equal(analytics.bookings.distinctStudents, 1, "only the student with paid beds counts as a resident");
  assert.equal(analytics.bookings.repeatStudents, 1, "a student who booked twice is a repeat");
  assert.equal(analytics.money.gross, 305_000);
  assert.equal(analytics.money.commission, 9_150);
  assert.equal(analytics.money.net, 218_250, "net excludes what a reversal took back");
  assert.equal(analytics.money.released, 121_250);
  assert.equal(analytics.money.accrued, 97_000);
  assert.equal(analytics.money.reversed, 77_600);
  assert.equal(analytics.reviews.count, 2);
  assert.equal(analytics.reviews.average, 4.5);
  assert.equal(analytics.reviews.hidden, 1);
  assert.equal(analytics.listings.approved, 2);
  assert.equal(analytics.listings.pendingReview, 1);
  assert.equal(analytics.landlords.verified, 1);
  assert.equal(analytics.landlords.pendingKyc, 1);
  assert.equal(analytics.messages.threads, 2);
  assert.equal(analytics.topProperties[0].name, "Owusu Lodge");
  assert.equal(analytics.topProperties[0].revenue, 225_000);
  assert.equal(analytics.topProperties[0].ratingAverage, 4.5, "the leaderboard carries the building's score");
  assert.equal(analytics.topProperties[0].ratingCount, 2);
});

test("an empty deployment reports zeroes rather than failing", async () => {
  state.properties = [{ id: "property-1", name: "Owusu Lodge", status: "ACTIVE" }];
  const analytics = await hostelAnalytics({ now: new Date("2026-09-20T12:00:00Z") });
  assert.equal(analytics.occupancy.rate, 0);
  assert.equal(analytics.bookings.total, 0);
  assert.equal(analytics.money.gross, 0);
  assert.equal(analytics.reviews.average, 0);
  assert.deepEqual(analytics.topProperties, []);
  assert.equal(analytics.bookings.trend.length, 14);
  assert.ok(analytics.bookings.trend.every((day) => day.count === 0 && day.amount === 0));
});
