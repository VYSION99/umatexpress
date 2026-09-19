import { staffEmailFromRequest } from "@/lib/staff-session";
import { reversePayoutForBooking } from "@/lib/organizer-payouts";
import { ensureAdminAuditLogTable, ensureBookingsTable, rowsToObjects, turso } from "@/lib/turso";
import { notifyVacationBookingCancelled } from "@/lib/vacation-notify";

export async function GET(request: Request) {
  if (!await staffEmailFromRequest(request)) return Response.json({ error: "Admin access is not authorised." }, { status: 401 });
  try {
    await ensureBookingsTable();
    const result = await turso("SELECT reference, passenger_name, email, phone, seat, trip_id, travel_date, amount, payment_status, booking_status, departure_time, created_at FROM bookings ORDER BY created_at DESC LIMIT 200");
    return Response.json({ bookings: rowsToObjects(result) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Bookings could not be loaded." }, { status: 503 });
  }
}

export async function DELETE(request: Request) {
  const adminEmail = await staffEmailFromRequest(request);
  if (!adminEmail) return Response.json({ error: "Admin access is not authorised." }, { status: 401 });
  try {
    await ensureBookingsTable();
    await ensureAdminAuditLogTable();
    const body = await request.json().catch(() => ({})) as { reference?: string; mode?: "cancel" | "delete" };
    const reference = String(body.reference || "").trim();
    const mode = body.mode === "delete" ? "delete" : "cancel";
    if (!reference) return Response.json({ error: "A booking reference is required." }, { status: 400 });

    const booking = await turso("SELECT id, reference, passenger_name, email, phone, seat, trip_id, travel_date, amount, payment_status, booking_status, departure_time, created_at FROM bookings WHERE reference = ? LIMIT 1", [reference]);
    const rows = rowsToObjects(booking);
    const booked = rows[0];
    if (!booked) return Response.json({ error: "Booking not found." }, { status: 404 });

    if (mode === "delete") {
      if (String(booked.booking_status) !== "CANCELLED" && String(booked.payment_status) !== "CANCELLED") {
        return Response.json({ error: "Only cancelled bookings can be permanently deleted. Cancel it first, then delete it." }, { status: 409 });
      }
      const now = new Date().toISOString();
      await turso(
        "INSERT INTO admin_audit_logs (id, admin_email, action, target_type, target_reference, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [crypto.randomUUID(), adminEmail, "DELETE_CANCELLED_BOOKING", "booking", reference, JSON.stringify(booked), now],
      );
      await turso("DELETE FROM seat_holds WHERE booking_id = ?", [String(booked.id)]).catch(() => undefined);
      await turso("DELETE FROM bookings WHERE reference = ?", [reference]);
      return Response.json({ deleted: true, logged: true, reference }, { headers: { "Cache-Control": "no-store" } });
    }

    await turso("DELETE FROM seat_holds WHERE booking_id = ?", [String(booked.id)]).catch(() => undefined);
    await turso("UPDATE bookings SET payment_status = 'CANCELLED', booking_status = 'CANCELLED' WHERE reference = ?", [reference]);
    // A cancelled booking stops earning. A reversal the platform already paid
    // out becomes a debt the next payout absorbs, which the statement shows.
    const reversed = await reversePayoutForBooking({
      bookingId: String(booked.id),
      reason: "BOOKING_CANCELLED",
      actor: adminEmail,
    }).catch(() => ({ reversed: false }));
    await turso(
      "INSERT INTO admin_audit_logs (id, admin_email, action, target_type, target_reference, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [crypto.randomUUID(), adminEmail, "CANCEL_BOOKING", "booking", reference, JSON.stringify({ ...booked, payoutReversed: reversed.reversed === true }), new Date().toISOString()],
    );
    // Only a booking the passenger actually paid for is worth a message; a
    // stale unpaid hold disappearing is not news. The send never throws, so it
    // cannot turn a completed cancellation into an error.
    if (String(booked.payment_status) === "SUCCESSFUL") {
      await notifyVacationBookingCancelled(String(booked.id));
    }

    return Response.json({ cancelled: true, reference, seat: booked.seat, trip_id: booked.trip_id, travel_date: booked.travel_date }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Booking could not be cancelled." }, { status: 503 });
  }
}
