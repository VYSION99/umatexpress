import { ensureBookingsTable, rowsToObjects, turso } from "@/lib/turso";

/** Prevent edits that would silently change a paid ticket or a live seat hold. */
export async function tripHasLiveBookings(tripId: string, now = new Date()) {
  await ensureBookingsTable();
  const rows = rowsToObjects(await turso(
    `SELECT id FROM bookings WHERE trip_id = ? AND (
       booking_status IN ('CONFIRMED','PAYMENT_RECEIVED_REVIEW')
       OR (booking_status = 'AWAITING_PAYMENT' AND hold_expires_at > ?)
     ) LIMIT 1`,
    [tripId, now.toISOString()],
  ));
  return rows.length > 0;
}
