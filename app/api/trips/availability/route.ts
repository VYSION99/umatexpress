import { ensurePaymentsTable, isTursoConfigured, rowsToObjects, turso } from "@/lib/turso";
import { getTrip, isValidTravelDate } from "@/lib/trips";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const tripId = Number(url.searchParams.get("tripId"));
  const travelDate = url.searchParams.get("travelDate");
  if (!getTrip(tripId) || !isValidTravelDate(travelDate)) {
    return Response.json({ error: "That trip or travel date is not available." }, { status: 400 });
  }

  if (!isTursoConfigured()) {
    return Response.json({ unavailableSeats: [], availableCount: 50, configured: false }, { headers: { "Cache-Control": "no-store" } });
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
    return Response.json({ unavailableSeats, availableCount: 50 - unavailableSeats.length }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Seat availability could not be loaded." }, { status: 503 });
  }
}
