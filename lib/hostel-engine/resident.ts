import { CampusEngineError } from "@/lib/campus-engine/errors";
import { verifyPaymentToken, paymentTokenFromRequest } from "@/lib/payment-access";
import { studentOwnsEmail } from "@/lib/student-auth";
import { rowsToObjects, turso } from "@/lib/turso";
import { listHostelAnnouncements, unreadHostelMessageCount, type HostelAnnouncement } from "@/lib/hostel-engine/messages";
import { listResidentPlugins, listServiceRequestsForBooking, type HostelPluginSubscription, type HostelServiceRequest } from "@/lib/hostel-engine/plugins";
import { getHostelBookingByReference, hostelBookingAuthHash, type HostelBooking } from "@/lib/hostel-engine/residency";
import { getHostelReviewForBooking, type HostelReview } from "@/lib/hostel-engine/reviews";
import { hostelRefundQuote, latestRefundForBooking, type HostelRefund, type HostelRefundQuote } from "@/lib/hostel-engine/refunds";

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

export async function residentDashboard(studentEmail: string): Promise<ResidentDashboard> {
  const email = String(studentEmail || "").trim().toLowerCase();
  // A cancelled or refunded booking stays on the page: the student needs the
  // record of what happened to the money, and the refund row carries it.
  const bookings = rowsToObjects(await turso(
    `SELECT reference FROM hostel_bookings WHERE student_email = ? AND status IN ('PAID','PAYMENT_REVIEW','CANCELLED','REFUNDED') ORDER BY created_at DESC LIMIT 20`,
    [email],
  ));
  const residencies: HostelResidency[] = [];
  for (const row of bookings) {
    const booking = await getHostelBookingByReference(String(row.reference));
    if (!booking) continue;
    const [plugins, services, unreadMessages, review, refund] = await Promise.all([
      listResidentPlugins({ landlordId: booking.landlordId, periodId: booking.periodId, propertyId: booking.propertyId }),
      listServiceRequestsForBooking(booking.id),
      unreadHostelMessageCount(booking.id, "STUDENT"),
      getHostelReviewForBooking(booking.id),
      latestRefundForBooking(booking.id),
    ]);
    // A quote is only meaningful while the money is still with the platform:
    // once a refund exists, the card shows that row instead.
    const refundQuote = refund ? null : hostelRefundQuote(booking);
    residencies.push({ booking, plugins, services, unreadMessages, review, refund, refundQuote });
  }
  const announcements: HostelAnnouncement[] = [];
  const seen = new Set<string>();
  for (const residency of residencies) {
    const key = `${residency.booking.landlordId}:${residency.booking.propertyId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const posts = await listHostelAnnouncements({ landlordId: residency.booking.landlordId, propertyId: residency.booking.propertyId });
    announcements.push(...posts);
  }
  announcements.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return { residencies, announcements: announcements.slice(0, 20) };
}
