import { adminEmailFromRequest } from "@/lib/admin-auth";
import { ensureBookingsTable, rowsToObjects, turso } from "@/lib/turso";

export async function GET(request: Request) {
  if (!await adminEmailFromRequest(request)) return Response.json({ error: "Admin access is not authorised." }, { status: 401 });
  try {
    await ensureBookingsTable();
    const result = await turso("SELECT reference, passenger_name, email, phone, seat, trip_id, travel_date, amount, payment_status, booking_status, departure_time, created_at FROM bookings ORDER BY created_at DESC LIMIT 200");
    return Response.json({ bookings: rowsToObjects(result) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Bookings could not be loaded." }, { status: 503 });
  }
}
