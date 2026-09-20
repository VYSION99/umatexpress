import { campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { resolveHostelHost } from "@/lib/hostel-engine/managers";
import { unreadHostelMessageCounts } from "@/lib/hostel-engine/messages";
import { listServiceRequestsForLandlord } from "@/lib/hostel-engine/plugins";
import { listHostelBookingsForLandlord } from "@/lib/hostel-engine/residency";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

/** A request still needing the host's attention. */
const OPEN_SERVICE_STATUSES = new Set(["REQUESTED", "APPROVED", "ACTIVE"]);

/**
 * The console's resident list: every booking for this landlord, each row
 * carrying its unread count and how many services are open, plus the totals a
 * dashboard strip needs. A delegate manager sees exactly what the owner sees,
 * because both resolve to the same landlord id.
 */
export async function GET(request: Request) {
  try {
    const account = await requireConsoleRole(request, ["LANDLORD"]);
    const limited = await rateLimit(request, "hostel-console-read", { limit: 240, windowMs: 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const host = await resolveHostelHost(account);
    const [bookings, requests] = await Promise.all([
      listHostelBookingsForLandlord(host.landlordId, { limit: 200 }),
      listServiceRequestsForLandlord(host.landlordId, { limit: 500 }),
    ]);
    const unread = await unreadHostelMessageCounts(bookings.map((booking) => booking.id), "HOST");
    const openByBooking = new Map<string, number>();
    for (const entry of requests) {
      if (!OPEN_SERVICE_STATUSES.has(entry.status)) continue;
      openByBooking.set(entry.bookingId, (openByBooking.get(entry.bookingId) || 0) + 1);
    }
    const residents = bookings.map((booking) => ({
      ...booking,
      unreadMessages: unread.get(booking.id) || 0,
      openServices: openByBooking.get(booking.id) || 0,
    }));
    const summary = {
      total: residents.length,
      resident: residents.filter((booking) => booking.status === "PAID").length,
      awaitingPayment: residents.filter((booking) => booking.status === "PENDING_PAYMENT").length,
      needsReview: residents.filter((booking) => booking.status === "PAYMENT_REVIEW").length,
      unreadMessages: residents.reduce((sum, booking) => sum + booking.unreadMessages, 0),
      openServices: requests.filter((entry) => entry.status === "REQUESTED").length,
      bedRevenue: residents.filter((booking) => booking.status === "PAID").reduce((sum, booking) => sum + booking.totalAmount, 0),
      commission: residents.filter((booking) => booking.status === "PAID").reduce((sum, booking) => sum + booking.commissionAmount, 0),
      net: residents.filter((booking) => booking.status === "PAID").reduce((sum, booking) => sum + booking.netAmount, 0),
    };
    return Response.json({ ok: true, residents, summary, isOwner: host.isOwner }, { headers: NO_STORE });
  } catch (error) {
    const { status, body } = campusErrorPayload(error);
    return Response.json(body, { status, headers: NO_STORE });
  }
}
