import { ensurePaymentsTable, isTursoConfiguredRuntime, rowsToObjects, turso } from "@/lib/turso";
import { getDynamicTrip } from "@/lib/dynamic-trips";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const tripId = String(url.searchParams.get("tripId") || "");
  const travelDate = url.searchParams.get("travelDate");
  const trip = await getDynamicTrip(tripId);
  if (!trip || trip.travelDate !== travelDate || !trip.active) {
    return Response.json({ error: "That trip or travel date is not available." }, { status: 400 });
  }

  if (!(await isTursoConfiguredRuntime())) {
    return Response.json({ unavailableSeats: [], availableCount: trip.capacity, capacity: trip.capacity, configured: false }, { headers: { "Cache-Control": "no-store" } });
  }

  try {
    await ensurePaymentsTable();
    const now = new Date().toISOString();
    await turso("DELETE FROM seat_holds WHERE status = 'HELD' AND expires_at < ?", [now]);
    const rows = rowsToObjects(await turso(
      "SELECT seat FROM seat_holds WHERE trip_id = ? AND travel_date = ? AND (status = 'BOOKED' OR (status = 'HELD' AND expires_at >= ?)) ORDER BY seat",
      [tripId, travelDate, now],
    ));
    const unavailableSeats = rows.map((row) => Number(row.seat)).filter(Number.isInteger);
    return Response.json({ unavailableSeats, availableCount: trip.capacity - unavailableSeats.length, capacity: trip.capacity }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Seat availability could not be loaded." }, { status: 503 });
  }
}
