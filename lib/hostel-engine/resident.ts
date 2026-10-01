import { ensureHostelMessageTables } from "./message-schema";
import { CampusEngineError } from "@/lib/campus-engine/errors";
import { verifyPaymentToken, paymentTokenFromRequest } from "@/lib/payment-access";
import { studentOwnsEmail } from "@/lib/student-auth";
import { rowsToObjects, turso, tursoReadBatch } from "@/lib/turso";
import { announcementView, type HostelAnnouncement } from "@/lib/hostel-engine/messages";
import { ensureHostelPluginTables, subscriptionView, serviceView, type HostelPluginSubscription, type HostelServiceRequest } from "@/lib/hostel-engine/plugins";
import { getHostelBookingByReference, hostelBookingAuthHash, ensureHostelResidencyTables, BOOKING_COLUMNS, BOOKING_JOINS, bookingView, type HostelBooking } from "@/lib/hostel-engine/residency";
import { ensureHostelReviewTables, reviewView, type HostelReview } from "@/lib/hostel-engine/reviews";
import { hostelRefundQuote, ensureHostelRefundTables, refundView, type HostelRefund, type HostelRefundQuote } from "@/lib/hostel-engine/refunds";

/**
 * The resident page's data.
 *
 * A residency is a paid booking. Everything here hangs off it: the services the
 * landlord switched on for that property and year, the requests the resident
 * has already made, the unread count on the thread, and the announcements the
 * landlord published to the building.
 */

export type HostelResidency = {
  booking: HostelBooking;
  plugins: HostelPluginSubscription[];
  services: HostelServiceRequest[];
  unreadMessages: number;
  /** The review this student wrote for the stay, or null while there is none. */
  review: HostelReview | null;
  /** The latest refund on this booking, or null while none was ever asked for. */
  refund: HostelRefund | null;
  /** What the policy would return today, so the cancel card can price itself. */
  refundQuote: HostelRefundQuote | null;
};

export type ResidentDashboard = {
  residencies: HostelResidency[];
  announcements: HostelAnnouncement[];
  pagination: { page: number; pages: number; total: number };
  historyTotal: number;
};

/**
 * A student may open their own booking through the signed account, or through
 * the payment cookie minted at checkout. Nothing else is accepted, so a
 * reference guessed from a ticket cannot reveal another student's room.
 */
export async function authorizeStudentHostelBooking(request: Request, reference: string) {
  const booking = await getHostelBookingByReference(String(reference || ""));
  if (!booking) throw new CampusEngineError("NOT_FOUND", "That hostel booking was not found.", 404);
  const token = paymentTokenFromRequest(request, booking.reference);
  const authorised = await verifyPaymentToken(token, await hostelBookingAuthHash(booking.reference));
  if (authorised || (await studentOwnsEmail(request, booking.studentEmail))) return booking;
  throw new CampusEngineError("FORBIDDEN", "That booking does not belong to your account.", 403);
}

/** The console side: only the landlord that owns the booking, or staff. */
export async function authorizeHostHostelBooking(landlordId: string, reference: string) {
  const booking = await getHostelBookingByReference(String(reference || ""));
  if (!booking) throw new CampusEngineError("NOT_FOUND", "That hostel booking was not found.", 404);
  if (booking.landlordId !== landlordId) throw new CampusEngineError("FORBIDDEN", "That booking belongs to another landlord.", 403);
  return booking;
}

export async function residentDashboard(studentEmail: string, options: { view?: string; page?: number } = {}): Promise<ResidentDashboard> {
  await ensureHostelResidencyTables();
  await Promise.all([ensureHostelPluginTables(), ensureHostelMessageTables(), ensureHostelReviewTables(), ensureHostelRefundTables()]);
  const email = String(studentEmail || "").trim().toLowerCase();
  const today = new Date().toISOString().slice(0, 10);
  const current = `b.status IN ('PENDING_PAYMENT','PAYMENT_REVIEW','PAID') AND COALESCE(st.status,'EXPECTED') NOT IN ('CHECKED_OUT','NO_SHOW','CANCELLED') AND COALESCE(pe.ends_on,'9999-12-31')>=?`;
  const history = options.view === "history";
  const where = `b.student_email=? AND ${history ? `NOT (${current})` : `(${current})`}`;
  const counts = rowsToObjects(await turso(`SELECT COUNT(*) AS total,SUM(CASE WHEN ${current} THEN 1 ELSE 0 END) AS current_count ${BOOKING_JOINS} WHERE b.student_email=?`, [today, email]))[0] || {};
  const historyTotal = Number(counts.total || 0) - Number(counts.current_count || 0);
  const total = history ? historyTotal : Number(counts.current_count || 0);
  const pageSize = 5, pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.max(1, Math.min(pages, Math.floor(Number(options.page) || 1)));
  const bookings = rowsToObjects(await turso(`SELECT ${BOOKING_COLUMNS} ${BOOKING_JOINS} WHERE ${where}
    ORDER BY b.created_at DESC,b.id DESC LIMIT ? OFFSET ?`, [email, today, pageSize, (page - 1) * pageSize])).map(bookingView);
  if (!bookings.length) return { residencies: [], announcements: [], pagination: { page, pages, total }, historyTotal };
  const ids = bookings.map(booking => booking.id), marks = ids.map(() => "?").join(",");
  // All detail queries share one HTTP request; history never reads new private notices.
  const results = await tursoReadBatch([
    { sql: `SELECT b.id AS booking_id,sub.*,pl.name AS plugin_name,pl.category AS plugin_category,pl.code AS plugin_code,pe.name AS period_name
      FROM hostel_bookings b JOIN hostel_plugin_subscriptions sub ON sub.landlord_id=b.landlord_id AND sub.period_id=b.period_id AND (sub.property_id='' OR sub.property_id=b.property_id)
      JOIN hostel_plugins pl ON pl.id=sub.plugin_id LEFT JOIN hostel_periods pe ON pe.id=sub.period_id
      WHERE b.id IN (${marks}) AND sub.status='ACTIVE' ORDER BY pl.name COLLATE NOCASE`, args: ids },
    { sql: `SELECT req.*,pl.name AS plugin_name,pl.category AS plugin_category FROM hostel_service_requests req LEFT JOIN hostel_plugins pl ON pl.id=req.plugin_id
      WHERE req.booking_id IN (${marks}) ORDER BY req.created_at DESC`, args: ids },
    { sql: `SELECT booking_id,COUNT(*) AS c FROM hostel_messages WHERE booking_id IN (${marks}) AND sender_type IN ('HOST','ADMIN') AND read_at='' GROUP BY booking_id`, args: ids },
    { sql: `SELECT * FROM hostel_reviews WHERE booking_id IN (${marks})`, args: ids },
    { sql: `SELECT * FROM hostel_refunds WHERE booking_id IN (${marks}) ORDER BY created_at DESC,id DESC`, args: ids },
    { sql: `SELECT a.*,p.name AS property_name FROM hostel_announcements a LEFT JOIN hostel_properties p ON p.id=a.property_id
      WHERE ?=0 AND a.status='PUBLISHED' AND EXISTS (SELECT 1 ${BOOKING_JOINS} WHERE b.student_email=? AND b.status='PAID'
        AND COALESCE(st.status,'EXPECTED') IN ('EXPECTED','CHECKED_IN') AND COALESCE(pe.ends_on,'9999-12-31')>=? AND pe.starts_on<=?
        AND b.landlord_id=a.landlord_id AND (a.property_id='' OR a.property_id=b.property_id)) ORDER BY a.created_at DESC LIMIT 20`, args: [history ? 1 : 0, email, today, today] },
  ]);
  const [plugins, services, unread, reviews, refunds, posts] = results.map(rowsToObjects);
  const residencies = bookings.map(booking => {
    const refundRow = refunds.find(row => row.booking_id === booking.id);
    const reviewRow = reviews.find(row => row.booking_id === booking.id);
    return { booking,
      plugins: history || booking.status !== "PAID" ? [] : plugins.filter(row => row.booking_id === booking.id).map(subscriptionView),
      services: services.filter(row => row.booking_id === booking.id).map(serviceView),
      unreadMessages: Number(unread.find(row => row.booking_id === booking.id)?.c || 0),
      review: reviewRow ? reviewView(reviewRow) : null,
      refund: refundRow ? refundView(refundRow) : null,
      refundQuote: refundRow ? null : hostelRefundQuote(booking),
    };
  });
  return { residencies, announcements: posts.map(announcementView), pagination: { page, pages, total }, historyTotal };
}
