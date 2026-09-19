import { queueNotification } from "@/lib/notifications";
import { logEvent } from "@/lib/observability";
import { ensureBookingsTable, isTursoConfiguredRuntime, rowsToObjects, turso } from "@/lib/turso";

/**
 * Passenger messages for a vacationRide booking.
 *
 * The outbox is shared with campusRide: one row is both the email and the
 * in-app notification, and the unique `(reference, template)` index makes the
 * confirmation idempotent when verification and the Paystack webhook both
 * confirm the same booking. Templates carry the `vacation_` prefix so the
 * sender links to the vacation ticket page rather than the campus one.
 *
 * Like the payout accrual, these run on the payment path, so they never throw:
 * a passenger's ticket is already paid for by then, and a messaging failure
 * must not turn a successful payment into an error.
 */

export const VACATION_CONFIRMED_TEMPLATE = "vacation_booking_confirmed";
export const VACATION_CANCELLED_TEMPLATE = "vacation_booking_cancelled";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-03" → "3 Oct 2026"; anything else is shown unchanged. */
export function humanTravelDate(value: unknown) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || "").trim());
  if (!match) return String(value || "").trim();
  const month = MONTHS[Number(match[2]) - 1];
  return month ? `${Number(match[3])} ${month} ${match[1]}` : String(value || "").trim();
}

/** Pesewas to "GHS 183.60", or an empty string when no amount is known. */
export function moneyLabel(pesewas: unknown) {
  const amount = Number(pesewas || 0);
  return Number.isFinite(amount) && amount > 0 ? `GHS ${(amount / 100).toFixed(2)}` : "";
}

export type BookingNoticeRow = {
  reference: string;
  email: string;
  seat: number | string;
  travel_date: string;
  departure_time: string;
  amount: number | string;
  booking_status: string;
  route_from: string;
  route_to: string;
};

function routeLabel(row: BookingNoticeRow) {
  const from = String(row.route_from || "").trim();
  const to = String(row.route_to || "").trim();
  return from && to ? `${from} → ${to}` : from || to;
}

function whenLabel(row: BookingNoticeRow) {
  const date = humanTravelDate(row.travel_date);
  const time = String(row.departure_time || "").trim();
  if (!date) return time;
  return time ? `${date} at ${time}` : date;
}

/** The confirmed message a passenger reads in the feed and by email. */
export function vacationConfirmedMessage(row: BookingNoticeRow) {
  const parts = [`Your seat ${row.seat} on ${routeLabel(row) || "your UMaTeXPRESS trip"} is confirmed for ${whenLabel(row)}.`];
  const paid = moneyLabel(row.amount);
  if (paid) parts.push(`You paid ${paid}.`);
  parts.push(`Your reference is ${row.reference}.`);
  return { subject: `Your UMaTeXPRESS ticket ${row.reference} is confirmed`, message: parts.join(" ") };
}

/** The cancelled message. It claims no refund, because the decision is not this module's. */
export function vacationCancelledMessage(row: BookingNoticeRow) {
  const route = routeLabel(row);
  return {
    subject: `Your UMaTeXPRESS booking ${row.reference} was cancelled`,
    message: `Your booking${route ? ` on ${route}` : ""} has been cancelled by UMaTeXPRESS. Reference ${row.reference}.`,
  };
}

/**
 * One query, so a missing row or an unreachable database costs one attempt and
 * the caller keeps its promise to never fail the payment path.
 */
async function bookingNotice(bookingId: string) {
  const rows = rowsToObjects(await turso(
    `SELECT COALESCE(b.reference,'') AS reference,COALESCE(b.email,'') AS email,b.seat,
       COALESCE(b.travel_date,'') AS travel_date,COALESCE(b.departure_time,'') AS departure_time,
       COALESCE(b.amount,0) AS amount,COALESCE(b.booking_status,'') AS booking_status,
       COALESCE(t.route_from,'') AS route_from,COALESCE(t.route_to,'') AS route_to
     FROM bookings b LEFT JOIN scheduled_trips t ON t.id = b.trip_id
     WHERE b.id = ? LIMIT 1`,
    [bookingId],
  ));
  return (rows[0] as BookingNoticeRow | undefined) || null;
}

/**
 * `expectedStatus` is what the message claims: a confirmation is only sent for
 * a confirmed booking, and a cancellation only for a cancelled one, so the
 * message can never describe a state the booking is not in.
 */
async function queueBookingNotice(
  bookingId: string,
  template: string,
  expectedStatus: string,
  build: (row: BookingNoticeRow) => { subject: string; message: string },
) {
  try {
    if (!(await isTursoConfiguredRuntime())) return { status: "SKIPPED" as const, reason: "TURSO_NOT_CONFIGURED" };
    await ensureBookingsTable();
    const row = await bookingNotice(bookingId);
    if (!row || !String(row.reference || "").trim()) return { status: "SKIPPED" as const, reason: "BOOKING_NOT_FOUND" };
    if (String(row.booking_status || "") !== expectedStatus) return { status: "SKIPPED" as const, reason: "NOT_IN_STATE" };
    const { subject, message } = build(row);
    const queued = await queueNotification(turso, {
      recipient: String(row.email || ""),
      template,
      subject,
      message,
      reference: String(row.reference),
      nowIso: new Date().toISOString(),
    });
    return queued ? { status: "QUEUED" as const } : { status: "ALREADY_QUEUED" as const };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown";
    logEvent("error", "vacation_notification_failed", { bookingId, template, reason });
    return { status: "FAILED" as const, reason };
  }
}

/** Confirms one booking to the passenger. Safe to call twice; safe to fail. */
export function notifyVacationBookingConfirmed(bookingId: string) {
  return queueBookingNotice(bookingId, VACATION_CONFIRMED_TEMPLATE, "CONFIRMED", vacationConfirmedMessage);
}

/** Tells the passenger a booking they paid for was cancelled. */
export function notifyVacationBookingCancelled(bookingId: string) {
  return queueBookingNotice(bookingId, VACATION_CANCELLED_TEMPLATE, "CANCELLED", vacationCancelledMessage);
}
