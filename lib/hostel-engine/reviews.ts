import { CampusEngineError } from "@/lib/campus-engine/errors";
import { consoleAudit } from "@/lib/console-audit";
import { ensureHostelTables } from "@/lib/hostel-engine/landlord";
import { queueNotification } from "@/lib/notifications";
import { incrementMetric, logEvent } from "@/lib/observability";
import { rowsToObjects, runSchemaPass, turso } from "@/lib/turso";

/**
 * Reviews and ratings.
 *
 * Only a student with a paid booking may review, which is what makes the score
 * worth reading: every review is anchored to a bed that was actually bought.
 * One review per booking, a landlord reply, and a staff hide as the only
 * moderation lever — the platform would rather show an unhappy truth than
 * curate the average.
 */

export const HOSTEL_REVIEW_MAX_TITLE = 120;
export const HOSTEL_REVIEW_MAX_BODY = 1500;
export const HOSTEL_REVIEW_MIN_RATING = 1;
export const HOSTEL_REVIEW_MAX_RATING = 5;
export const HOSTEL_REVIEW_STATUSES = ["PUBLISHED", "HIDDEN"] as const;
export type HostelReviewStatus = (typeof HOSTEL_REVIEW_STATUSES)[number];

const REVIEW_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS hostel_reviews (
    id TEXT PRIMARY KEY,
    booking_id TEXT NOT NULL,
    property_id TEXT NOT NULL,
    landlord_id TEXT NOT NULL,
    period_id TEXT NOT NULL DEFAULT '',
    student_email TEXT NOT NULL,
    student_name TEXT NOT NULL DEFAULT '',
    rating INTEGER NOT NULL DEFAULT 0,
    title TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'PUBLISHED',
    reply TEXT NOT NULL DEFAULT '',
    reply_by TEXT NOT NULL DEFAULT '',
    replied_at TEXT NOT NULL DEFAULT '',
    hidden_reason TEXT NOT NULL DEFAULT '',
    moderated_by TEXT NOT NULL DEFAULT '',
    moderated_at TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_hostel_reviews_booking ON hostel_reviews(booking_id)",
  "CREATE INDEX IF NOT EXISTS idx_hostel_reviews_property ON hostel_reviews(property_id, status, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_hostel_reviews_landlord ON hostel_reviews(landlord_id, status, created_at DESC)",
];

export type HostelReview = {
  id: string;
  bookingId: string;
  propertyId: string;
  landlordId: string;
  periodId: string;
  studentEmail: string;
  studentName: string;
  rating: number;
  title: string;
  body: string;
  status: HostelReviewStatus;
  reply: string;
  replyBy: string;
  repliedAt: string;
  hiddenReason: string;
  moderatedBy: string;
  moderatedAt: string;
  createdAt: string;
  updatedAt: string;
};

export type HostelRatingSummary = { average: number; count: number };

const REVIEW_COLUMNS = `id,booking_id,property_id,landlord_id,COALESCE(period_id,'') AS period_id,student_email,COALESCE(student_name,'') AS student_name,
  rating,COALESCE(title,'') AS title,COALESCE(body,'') AS body,COALESCE(status,'PUBLISHED') AS status,
  COALESCE(reply,'') AS reply,COALESCE(reply_by,'') AS reply_by,COALESCE(replied_at,'') AS replied_at,
  COALESCE(hidden_reason,'') AS hidden_reason,COALESCE(moderated_by,'') AS moderated_by,COALESCE(moderated_at,'') AS moderated_at,
  created_at,updated_at`;

let reviewTablesReady: Promise<void> | null = null;

export function ensureHostelReviewTables() {
  reviewTablesReady ??= (async () => {
    await ensureHostelTables();
    await runSchemaPass({ id: "hostel_reviews", version: "022_hostel_reviews", statements: REVIEW_SCHEMA_STATEMENTS });
  })().catch((error: unknown) => {
    reviewTablesReady = null;
    throw error;
  });
  return reviewTablesReady;
}

function reviewView(row: Record<string, unknown>): HostelReview {
  return {
    id: String(row.id || ""),
    bookingId: String(row.booking_id || ""),
    propertyId: String(row.property_id || ""),
    landlordId: String(row.landlord_id || ""),
    periodId: String(row.period_id || ""),
    studentEmail: String(row.student_email || ""),
    studentName: String(row.student_name || ""),
    rating: Number(row.rating || 0),
    title: String(row.title || ""),
    body: String(row.body || ""),
    status: String(row.status || "PUBLISHED") as HostelReviewStatus,
    reply: String(row.reply || ""),
    replyBy: String(row.reply_by || ""),
    repliedAt: String(row.replied_at || ""),
    hiddenReason: String(row.hidden_reason || ""),
    moderatedBy: String(row.moderated_by || ""),
    moderatedAt: String(row.moderated_at || ""),
    createdAt: String(row.created_at || ""),
    updatedAt: String(row.updated_at || ""),
  };
}

function cleanRating(value: unknown) {
  const rating = Math.round(Number(value));
  if (!Number.isFinite(rating) || rating < HOSTEL_REVIEW_MIN_RATING || rating > HOSTEL_REVIEW_MAX_RATING) {
    throw new CampusEngineError("VALIDATION_ERROR", "Choose a rating from one to five stars.", 400);
  }
  return rating;
}

function cleanText(value: unknown, limit: number) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

/** The student's own review of one booking, or null while they have not written one. */
export async function getHostelReviewForBooking(bookingId: string) {
  await ensureHostelReviewTables();
  const row = rowsToObjects(await turso(`SELECT ${REVIEW_COLUMNS} FROM hostel_reviews WHERE booking_id = ? LIMIT 1`, [String(bookingId || "")]))[0];
  return row ? reviewView(row) : null;
}

/**
 * Writes the review a paid stay earns. One per booking: a second attempt is a
 * conflict rather than an edit, so the record of what the student first said
 * cannot be quietly rewritten later.
 */
export async function submitHostelReview(input: {
  booking: {
    id: string; reference: string; propertyId: string; landlordId: string; periodId: string;
    studentEmail: string; studentName: string; landlordEmail: string; propertyName: string; status: string;
  };
  rating: unknown;
  title?: unknown;
  body?: unknown;
}) {
  await ensureHostelReviewTables();
  if (String(input.booking.status) !== "PAID") {
    throw new CampusEngineError("INVALID_STATE", "Only a paid bed can be reviewed.", 409);
  }
  const rating = cleanRating(input.rating);
  const title = cleanText(input.title, HOSTEL_REVIEW_MAX_TITLE);
  const body = cleanText(input.body, HOSTEL_REVIEW_MAX_BODY);
  if (!body) throw new CampusEngineError("VALIDATION_ERROR", "Tell other students what the stay was like.", 400);
  const existing = await getHostelReviewForBooking(input.booking.id);
  if (existing) throw new CampusEngineError("CONFLICT", "You have already reviewed this stay.", 409);

  const id = crypto.randomUUID();
  const stamp = new Date().toISOString();
  await turso(
    `INSERT INTO hostel_reviews (id,booking_id,property_id,landlord_id,period_id,student_email,student_name,rating,title,body,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,'PUBLISHED',?,?)`,
    [id, input.booking.id, input.booking.propertyId, input.booking.landlordId, input.booking.periodId,
      input.booking.studentEmail, input.booking.studentName, rating, title, body, stamp, stamp],
  );
  await incrementMetric("hostel_review_written");
  logEvent("info", "hostel_review_written", { propertyId: input.booking.propertyId, rating });
  if (input.booking.landlordEmail) {
    await queueNotification(turso, {
      recipient: input.booking.landlordEmail,
      template: "hostel_review_received",
      subject: `${rating}-star review for ${input.booking.propertyName || "your hostel"}`,
      message: `${input.booking.studentName || "A resident"} rated ${rating}/5: "${body.slice(0, 140)}". Reply from the console under Reviews.`,
      reference: `hostel-review:${id}`,
      nowIso: stamp,
    }).catch(() => undefined);
  }
  return (await getHostelReviewForBooking(input.booking.id)) as HostelReview;
}

/** What the public page shows: published reviews, newest first. */
export async function listPropertyReviews(propertyId: string, options: { limit?: number } = {}) {
  await ensureHostelReviewTables();
  const limit = Math.min(Math.max(Math.round(Number(options.limit) || 12), 1), 50);
  const rows = rowsToObjects(await turso(
    `SELECT ${REVIEW_COLUMNS} FROM hostel_reviews WHERE property_id = ? AND status = 'PUBLISHED' ORDER BY created_at DESC LIMIT ?`,
    [String(propertyId || ""), limit],
  ));
  return rows.map(reviewView);
}

export async function reviewSummaryForProperty(propertyId: string): Promise<HostelRatingSummary> {
  const summaries = await reviewSummaryForProperties([String(propertyId || "")]);
  return summaries.get(String(propertyId || "")) || { average: 0, count: 0 };
}

/** One query for every card on the browse page, rather than one query per card. */
export async function reviewSummaryForProperties(propertyIds: Array<string>) {
  const ids = [...new Set(propertyIds.map((id) => String(id || "").trim()).filter(Boolean))];
  const summaries = new Map<string, HostelRatingSummary>();
  if (!ids.length) return summaries;
  await ensureHostelReviewTables();
  const placeholders = ids.map(() => "?").join(",");
  const rows = rowsToObjects(await turso(
    `SELECT property_id, COUNT(*) AS count, AVG(rating) AS average
     FROM hostel_reviews WHERE status = 'PUBLISHED' AND property_id IN (${placeholders})
     GROUP BY property_id`,
    ids,
  ));
  rows.forEach((row) => {
    const propertyId = String(row.property_id || "");
    if (!propertyId) return;
    summaries.set(propertyId, { average: Number(row.average || 0), count: Number(row.count || 0) });
  });
  return summaries;
}

/** The landlord's own list, including reviews staff have hidden, so nothing is secret. */
export async function listReviewsForLandlord(landlordId: string, options: { limit?: number } = {}) {
  await ensureHostelReviewTables();
  const limit = Math.min(Math.max(Math.round(Number(options.limit) || 50), 1), 200);
  const rows = rowsToObjects(await turso(
    `SELECT ${REVIEW_COLUMNS} FROM hostel_reviews WHERE landlord_id = ? ORDER BY created_at DESC LIMIT ?`,
    [String(landlordId || ""), limit],
  ));
  return rows.map(reviewView);
}

/** Staff see every review, newest first, with the hidden ones included. */
export async function listReviewsForStaff(options: { status?: string; limit?: number } = {}) {
  await ensureHostelReviewTables();
  const status = HOSTEL_REVIEW_STATUSES.includes(String(options.status || "").toUpperCase() as HostelReviewStatus)
    ? String(options.status).toUpperCase()
    : "";
  const limit = Math.min(Math.max(Math.round(Number(options.limit) || 100), 1), 300);
  const rows = status
    ? rowsToObjects(await turso(`SELECT ${REVIEW_COLUMNS} FROM hostel_reviews WHERE status = ? ORDER BY created_at DESC LIMIT ?`, [status, limit]))
    : rowsToObjects(await turso(`SELECT ${REVIEW_COLUMNS} FROM hostel_reviews ORDER BY created_at DESC LIMIT ?`, [limit]));
  return rows.map(reviewView);
}

/**
 * The landlord's answer, once. A reply is part of the record, so it is shown
 * with the review rather than replacing it, and it notifies the student.
 */
export async function replyToHostelReview(input: { reviewId: string; landlordId: string; reply: unknown; actor: string }) {
  await ensureHostelReviewTables();
  const reviewId = String(input.reviewId || "").trim();
  const reply = cleanText(input.reply, HOSTEL_REVIEW_MAX_BODY);
  if (!reviewId) throw new CampusEngineError("VALIDATION_ERROR", "Choose a review to answer.", 400);
  if (!reply) throw new CampusEngineError("VALIDATION_ERROR", "Write a reply before sending it.", 400);
  const row = rowsToObjects(await turso(`SELECT ${REVIEW_COLUMNS} FROM hostel_reviews WHERE id = ? LIMIT 1`, [reviewId]))[0];
  const review = row ? reviewView(row) : null;
  if (!review) throw new CampusEngineError("NOT_FOUND", "That review no longer exists.", 404);
  if (review.landlordId !== input.landlordId) throw new CampusEngineError("FORBIDDEN", "That review belongs to another hostel.", 403);
  if (review.reply) throw new CampusEngineError("INVALID_STATE", "You have already answered this review.", 409);
  const stamp = new Date().toISOString();
  await turso(
    "UPDATE hostel_reviews SET reply = ?, reply_by = ?, replied_at = ?, updated_at = ? WHERE id = ?",
    [reply, String(input.actor || ""), stamp, stamp, reviewId],
  );
  const booking = rowsToObjects(await turso("SELECT student_email FROM hostel_bookings WHERE id = ? LIMIT 1", [review.bookingId]))[0];
  const studentEmail = String(booking?.student_email || "");
  if (studentEmail) {
    await queueNotification(turso, {
      recipient: studentEmail,
      template: "hostel_review_replied",
      subject: "Your hostel review has an answer",
      message: `The hostel replied on your ${review.rating}-star review: "${reply.slice(0, 140)}".`,
      reference: `hostel-review-reply:${review.id}`,
      nowIso: stamp,
    }).catch(() => undefined);
  }
  logEvent("info", "hostel_review_replied", { reviewId });
  return { ...review, reply, replyBy: String(input.actor || ""), repliedAt: stamp, updatedAt: stamp };
}

/** The staff lever: hide a review, or put it back. Never delete, never edit. */
export async function moderateHostelReview(input: { reviewId: string; action: unknown; reason?: unknown; actor: string }) {
  await ensureHostelReviewTables();
  const reviewId = String(input.reviewId || "").trim();
  const action = String(input.action || "").trim().toUpperCase();
  if (!reviewId) throw new CampusEngineError("VALIDATION_ERROR", "Choose a review to moderate.", 400);
  if (!["HIDE", "PUBLISH"].includes(action)) throw new CampusEngineError("VALIDATION_ERROR", "Unknown review action.", 400);
  const row = rowsToObjects(await turso(`SELECT ${REVIEW_COLUMNS} FROM hostel_reviews WHERE id = ? LIMIT 1`, [reviewId]))[0];
  const review = row ? reviewView(row) : null;
  if (!review) throw new CampusEngineError("NOT_FOUND", "That review no longer exists.", 404);
  const status: HostelReviewStatus = action === "HIDE" ? "HIDDEN" : "PUBLISHED";
  const reason = status === "HIDDEN" ? cleanText(input.reason, 300) : "";
  if (status === "HIDDEN" && !reason) throw new CampusEngineError("VALIDATION_ERROR", "Say why the review is being hidden.", 400);
  const stamp = new Date().toISOString();
  await turso(
    "UPDATE hostel_reviews SET status = ?, hidden_reason = ?, moderated_by = ?, moderated_at = ?, updated_at = ? WHERE id = ?",
    [status, reason, String(input.actor || ""), stamp, stamp, reviewId],
  );
  await consoleAudit({
    actor: input.actor,
    action: status === "HIDDEN" ? "hostel_review_hidden" : "hostel_review_published",
    targetType: "hostel_review",
    targetReference: reviewId,
    details: { propertyId: review.propertyId, rating: review.rating, reason },
  });
  logEvent("info", "hostel_review_moderated", { reviewId, status });
  return { ...review, status, hiddenReason: reason, moderatedBy: String(input.actor || ""), moderatedAt: stamp, updatedAt: stamp };
}
