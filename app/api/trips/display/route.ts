import { DEFAULT_TRIP_SETTINGS, activeTripIds, getTripSettings, isValidTime, normalizeFlyerPromo, type FlyerPromo, type TripDisplayMode, type TripSchedule } from "@/lib/trip-settings";
import { organizerNoticeForTrip } from "@/lib/organizers";
import { listPublicNotices } from "@/lib/public-notices";
import { staffEmailFromRequest } from "@/lib/staff-session";
import { isTursoConfiguredRuntime, turso } from "@/lib/turso";
import { hasNoticeContent } from "@/lib/trip-notice";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

/**
 * `?tripId=` makes `flyerPromo` that trip's organizer's, so one organizer's fare
 * and contacts never appear on another organizer's coach. The public carousel
 * instead reads `notices`, which carries every enabled notice (platform first,
 * then organizers by name) with the live routes each notice belongs to.
 */
export async function GET(request: Request) {
  const limited = await rateLimit(request, "trips-display-read", { limit: 240, windowMs: 60_000 });
  if (!limited.ok) return rateLimitResponse(limited.retryAfter);
  const tripId = new URL(request.url).searchParams.get("tripId") || "";
  async function noticeFor(fallback: FlyerPromo) {
    if (!tripId) return fallback;
    const organizerNotice = await organizerNoticeForTrip(tripId).catch(() => null);
    return organizerNotice && organizerNotice.enabled && hasNoticeContent(organizerNotice) ? organizerNotice : fallback;
  }
  if (!(await isTursoConfiguredRuntime())) {
    const settings = { ...DEFAULT_TRIP_SETTINGS };
    return Response.json(
      { ...settings, activeTripIds: activeTripIds(settings.mode), configured: false, notices: await listPublicNotices() },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  try {
    const settings = await getTripSettings();
    const [flyerPromo, notices] = await Promise.all([noticeFor(settings.flyerPromo), listPublicNotices()]);
    return Response.json(
      { ...settings, flyerPromo, activeTripIds: activeTripIds(settings.mode), notices },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Trip settings could not be loaded." }, { status: 503 });
  }
}

export async function PATCH(request: Request) {
  if (!await staffEmailFromRequest(request)) return Response.json({ error: "Admin access is not authorised." }, { status: 401 });
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
    // Merge any partial update onto the stored notice so an omitted field keeps
    // its saved value instead of being blanked.
    const flyerPromo = body.flyerPromo ? normalizeFlyerPromo(body.flyerPromo, current.flyerPromo) : current.flyerPromo;
    await turso(
      "UPDATE trip_settings SET display_mode = ?, morning_departure = ?, morning_arrival = ?, evening_departure = ?, evening_arrival = ?, flyer_promo = ?, updated_at = ? WHERE id = 1",
      [mode, schedule.morningDeparture, schedule.morningArrival, schedule.eveningDeparture, schedule.eveningArrival, JSON.stringify(flyerPromo), new Date().toISOString()],
    );
    return Response.json({ mode, ...schedule, flyerPromo, activeTripIds: activeTripIds(mode) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Trip settings could not be saved." }, { status: 503 });
  }
}
