import { DEFAULT_TRIP_SETTINGS, activeTripIds, getTripSettings, isValidTime, normalizeFlyerPromo, type FlyerPromo, type TripDisplayMode, type TripSchedule } from "@/lib/trip-settings";
import { adminEmailFromRequest } from "@/lib/admin-auth";
import { isTursoConfigured, turso } from "@/lib/turso";

export async function GET() {
  if (!isTursoConfigured()) {
    const settings = { ...DEFAULT_TRIP_SETTINGS };
    return Response.json({ ...settings, activeTripIds: activeTripIds(settings.mode), configured: false }, { headers: { "Cache-Control": "no-store" } });
  }
  try {
    const settings = await getTripSettings();
    return Response.json({ ...settings, activeTripIds: activeTripIds(settings.mode) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Trip settings could not be loaded." }, { status: 503 });
  }
}

export async function PATCH(request: Request) {
  if (!await adminEmailFromRequest(request)) return Response.json({ error: "Admin access is not authorised." }, { status: 401 });
  try {
    const current = await getTripSettings();
    const body = await request.json() as Partial<TripSchedule> & { mode?: TripDisplayMode; flyerPromo?: Partial<FlyerPromo> };
    const mode = body.mode ?? current.mode;
    if (mode !== "MORNING" && mode !== "EVENING" && mode !== "BOTH") {
      return Response.json({ error: "Choose Morning, Afternoon/Evening, or Both." }, { status: 400 });
    }
    const schedule: TripSchedule = {
      morningDeparture: body.morningDeparture ?? current.morningDeparture,
      morningArrival: body.morningArrival ?? current.morningArrival,
      eveningDeparture: body.eveningDeparture ?? current.eveningDeparture,
      eveningArrival: body.eveningArrival ?? current.eveningArrival,
    };
    if (Object.values(schedule).some((value) => !isValidTime(value))) {
      return Response.json({ error: "Enter valid departure and arrival times." }, { status: 400 });
    }
    const flyerPromo = body.flyerPromo ? normalizeFlyerPromo(body.flyerPromo) : current.flyerPromo;
    await turso(
      "UPDATE trip_settings SET display_mode = ?, morning_departure = ?, morning_arrival = ?, evening_departure = ?, evening_arrival = ?, flyer_promo = ?, updated_at = ? WHERE id = 1",
      [mode, schedule.morningDeparture, schedule.morningArrival, schedule.eveningDeparture, schedule.eveningArrival, JSON.stringify(flyerPromo), new Date().toISOString()],
    );
    return Response.json({ mode, ...schedule, flyerPromo, activeTripIds: activeTripIds(mode) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Trip settings could not be saved." }, { status: 503 });
  }
}
