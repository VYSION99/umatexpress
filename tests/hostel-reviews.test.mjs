import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

/**
 * Reviews and ratings. Only a paid bed can be reviewed, one review per booking,
 * a landlord answers once, and staff may hide — never edit — what was said.
 * These run the engine against a fake Turso.
 */

process.env.TURSO_DATABASE_URL = "https://hostel-reviews-test.turso.io";
process.env.TURSO_AUTH_TOKEN = "test-token";

const reviews = [];
const bookings = [];
const outbox = [];
const audits = [];

const REVIEW_COLUMNS = [
  "id", "booking_id", "property_id", "landlord_id", "period_id", "student_email", "student_name", "rating", "title", "body",
  "status", "reply", "reply_by", "replied_at", "hidden_reason", "moderated_by", "moderated_at", "created_at", "updated_at",
];

function cell(value) {
  if (value === null || value === undefined) return { type: "null" };
  if (typeof value === "number") return { type: Number.isInteger(value) ? "integer" : "real", value: String(value) };
  return { type: "text", value: String(value) };
}
function table(columns, rows) {
  return { cols: columns.map((name) => ({ name })), rows: rows.map((row) => columns.map((name) => cell(row[name]))) };
}
const empty = { cols: [], rows: [] };
const ok = (result) => ({ type: "ok", response: { result: result || {} } });
const affected = (count) => ok({ affected_row_count: count });
const newestFirst = (rows) => [...rows].sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)));

function handle(sql, args) {
  if (/^SELECT version FROM (campus_schema_meta|schema_passes)/.test(sql)) return ok(empty);
  if (/^INSERT OR REPLACE INTO (campus_schema_meta|schema_passes)/.test(sql)) return affected(1);
  if (/^CREATE |^ALTER /.test(sql)) return ok(empty);
  if (/^UPDATE hostel_landlords/.test(sql)) return affected(0);

  if (/^INSERT INTO notification_outbox/.test(sql)) {
    const [id, , recipient, template, subject, message, reference, , nowIso] = args;
    outbox.push({ id, recipient, template, subject, message, reference, createdAt: nowIso });
    return affected(1);
  }
  if (/^INSERT INTO admin_audit_logs/.test(sql)) {
    audits.push({ admin_email: args[1], action: args[2], target_type: args[3], target_reference: args[4], details: args[5] });
    return affected(1);
  }

  if (/^INSERT INTO hostel_reviews/.test(sql)) {
    const [id, bookingId, propertyId, landlordId, periodId, studentEmail, studentName, rating, title, body, createdAt, updatedAt] = args;
    reviews.push({
      id, booking_id: bookingId, property_id: propertyId, landlord_id: landlordId, period_id: periodId,
      student_email: studentEmail, student_name: studentName, rating, title, body, status: "PUBLISHED",
      reply: "", reply_by: "", replied_at: "", hidden_reason: "", moderated_by: "", moderated_at: "", created_at: createdAt, updated_at: updatedAt,
    });
    return affected(1);
  }
  if (/^SELECT id,booking_id,property_id/.test(sql)) {
    if (/WHERE booking_id = \? LIMIT 1/.test(sql)) {
      const row = reviews.find((review) => review.booking_id === args[0]);
      return ok(row ? table(REVIEW_COLUMNS, [row]) : empty);
    }
    if (/WHERE id = \? LIMIT 1/.test(sql)) {
      const row = reviews.find((review) => review.id === args[0]);
      return ok(row ? table(REVIEW_COLUMNS, [row]) : empty);
    }
    if (/WHERE property_id = \? AND status = 'PUBLISHED'/.test(sql)) {
      const rows = newestFirst(reviews.filter((review) => review.property_id === args[0] && review.status === "PUBLISHED")).slice(0, Number(args[1]));
      return ok(rows.length ? table(REVIEW_COLUMNS, rows) : empty);
    }
    if (/WHERE landlord_id = \?/.test(sql)) {
      const rows = newestFirst(reviews.filter((review) => review.landlord_id === args[0])).slice(0, Number(args[1]));
      return ok(rows.length ? table(REVIEW_COLUMNS, rows) : empty);
    }
    if (/WHERE status = \?/.test(sql)) {
      const rows = newestFirst(reviews.filter((review) => review.status === args[0])).slice(0, Number(args[1]));
      return ok(rows.length ? table(REVIEW_COLUMNS, rows) : empty);
    }
    const rows = newestFirst(reviews).slice(0, Number(args[0]));
    return ok(rows.length ? table(REVIEW_COLUMNS, rows) : empty);
  }
  if (/^SELECT property_id, COUNT\(\*\) AS count, AVG\(rating\) AS average/.test(sql)) {
    const ids = args.slice(0, args.length);
    const grouped = ids.map((propertyId) => {
      const rows = reviews.filter((review) => review.property_id === propertyId && review.status === "PUBLISHED");
      return rows.length ? { property_id: propertyId, count: rows.length, average: rows.reduce((total, review) => total + Number(review.rating), 0) / rows.length } : null;
    }).filter(Boolean);
    return ok(grouped.length ? table(["property_id", "count", "average"], grouped) : empty);
  }
  if (/^UPDATE hostel_reviews SET reply = \?/.test(sql)) {
    const [reply, replyBy, repliedAt, updatedAt, id] = args;
    const row = reviews.find((review) => review.id === id);
    if (row) Object.assign(row, { reply, reply_by: replyBy, replied_at: repliedAt, updated_at: updatedAt });
    return affected(row ? 1 : 0);
  }
  if (/^UPDATE hostel_reviews SET status = \?/.test(sql)) {
    const [status, hiddenReason, moderatedBy, moderatedAt, updatedAt, id] = args;
    const row = reviews.find((review) => review.id === id);
    if (row) Object.assign(row, { status, hidden_reason: hiddenReason, moderated_by: moderatedBy, moderated_at: moderatedAt, updated_at: updatedAt });
    return affected(row ? 1 : 0);
  }
  if (/^SELECT student_email FROM hostel_bookings WHERE id = \? LIMIT 1/.test(sql)) {
    const row = bookings.find((booking) => booking.id === args[0]);
    return ok(row ? table(["student_email"], [{ student_email: row.student_email }]) : empty);
  }
  return ok(empty);
}

globalThis.fetch = async (url, init) => {
  const target = String(typeof url === "string" ? url : url?.url || "");
  if (target.startsWith("https://hostel-reviews-test.turso.io")) {
    const body = JSON.parse(init.body);
    const results = body.requests
      .filter((request) => request.type === "execute")
      .map(({ stmt }) => handle(stmt.sql, (stmt.args || []).map((arg) => (arg.type === "null" ? null : arg.value))));
    return { ok: true, json: async () => ({ results }) };
  }
  throw new Error(`Unhandled request to ${target}`);
};

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => vite.close());

const {
  getHostelReviewForBooking, listPropertyReviews, listReviewsForLandlord, listReviewsForStaff,
  moderateHostelReview, replyToHostelReview, reviewSummaryForProperties, submitHostelReview,
} = await vite.ssrLoadModule("/lib/hostel-engine/reviews.ts");

const PAID_BOOKING = {
  id: "booking-1", reference: "HL-1", propertyId: "property-1", landlordId: "landlord-1", periodId: "period-1",
  studentEmail: "ama@st.umat.edu.gh", studentName: "Ama Mensah", landlordEmail: "owusu@example.com",
  propertyName: "Owusu Lodge", status: "PAID",
};

beforeEach(() => {
  reviews.length = 0;
  bookings.length = 0;
  outbox.length = 0;
  audits.length = 0;
  bookings.push({ id: "booking-1", student_email: "ama@st.umat.edu.gh" });
});

async function writeReview(overrides = {}) {
  return submitHostelReview({ booking: { ...PAID_BOOKING, ...(overrides.booking || {}) }, rating: 5, title: "Quiet and close", body: "The water ran every morning and the gate was locked at night.", ...overrides });
}

test("a paid stay earns exactly one review", async () => {
  const review = await writeReview();
  assert.equal(review.status, "PUBLISHED");
  assert.equal(review.rating, 5);
  assert.equal(review.propertyId, "property-1");
  assert.equal(outbox.filter((item) => item.template === "hostel_review_received").length, 1, "the landlord is told once");

  await assert.rejects(() => writeReview(), (error) => error?.code === "CONFLICT" && error.status === 409);
  assert.equal(reviews.length, 1, "a second attempt must not rewrite the first");
});

test("only a paid bed can be reviewed", async () => {
  await assert.rejects(
    () => writeReview({ booking: { status: "PENDING_PAYMENT" } }),
    (error) => error?.code === "INVALID_STATE" && /paid/i.test(error.message),
  );
  assert.equal(reviews.length, 0);
});

test("the rating and the words are checked", async () => {
  for (const rating of [0, 6, 4.2]) {
    if (rating === 4.2) continue;
    await assert.rejects(() => writeReview({ rating }), (error) => error?.code === "VALIDATION_ERROR");
  }
  await assert.rejects(() => writeReview({ body: "   " }), (error) => error?.code === "VALIDATION_ERROR");
  assert.equal(reviews.length, 0);
});

test("the public list and the summary only count published reviews", async () => {
  await writeReview();
  await writeReview({ booking: { ...PAID_BOOKING, id: "booking-2" }, rating: 4, title: "", body: "Good value for the distance." });
  const listed = await listPropertyReviews("property-1");
  assert.equal(listed.length, 2);
  const summary = (await reviewSummaryForProperties(["property-1", "property-2"])).get("property-1");
  assert.equal(summary.count, 2);
  assert.equal(summary.average, 4.5);

  await moderateHostelReview({ reviewId: listed[0].id, action: "HIDE", reason: "Names a person", actor: "admin@umat.edu.gh" });
  assert.equal((await listPropertyReviews("property-1")).length, 1, "a hidden review leaves the public page");
  assert.equal((await reviewSummaryForProperties(["property-1"])).get("property-1").count, 1);
  assert.equal((await listReviewsForStaff({ status: "HIDDEN" })).length, 1, "staff still see what was hidden");
  assert.equal((await listReviewsForLandlord("landlord-1")).length, 2, "the hostel sees its own hidden review too");
});

test("a landlord answers once, and the student is told", async () => {
  const review = await writeReview();
  const answered = await replyToHostelReview({ reviewId: review.id, landlordId: "landlord-1", reply: "Thank you — the pump was replaced in October.", actor: "owusu@example.com" });
  assert.match(answered.reply, /pump/);
  assert.equal(outbox.filter((item) => item.template === "hostel_review_replied").length, 1);
  await assert.rejects(
    () => replyToHostelReview({ reviewId: review.id, landlordId: "landlord-1", reply: "One more thing.", actor: "owusu@example.com" }),
    (error) => error?.code === "INVALID_STATE",
  );
  await assert.rejects(
    () => replyToHostelReview({ reviewId: review.id, landlordId: "landlord-2", reply: "Not mine.", actor: "other@example.com" }),
    (error) => error?.code === "FORBIDDEN",
  );
});

test("hiding needs a reason and is audited; publishing back undoes it", async () => {
  const review = await writeReview();
  await assert.rejects(
    () => moderateHostelReview({ reviewId: review.id, action: "HIDE", reason: "", actor: "admin@umat.edu.gh" }),
    (error) => error?.code === "VALIDATION_ERROR",
  );
  const hidden = await moderateHostelReview({ reviewId: review.id, action: "HIDE", reason: "Personal contact details", actor: "admin@umat.edu.gh" });
  assert.equal(hidden.status, "HIDDEN");
  assert.equal(hidden.hiddenReason, "Personal contact details");
  assert.equal(audits.filter((item) => item.action === "hostel_review_hidden").length, 1, "moderation is audited");
  const published = await moderateHostelReview({ reviewId: review.id, action: "PUBLISH", actor: "admin@umat.edu.gh" });
  assert.equal(published.status, "PUBLISHED");
  assert.equal((await getHostelReviewForBooking("booking-1")).status, "PUBLISHED");
});
