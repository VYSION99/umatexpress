import { getDynamicTrips, seedDefaultScheduledTrips } from "@/lib/dynamic-trips";
import { organizerDisplayNames } from "@/lib/organizers";
import { activeTripIds, getTripSettings } from "@/lib/trip-settings";
import { tripSearchReply, type TripSearchTrip } from "@/lib/trip-search";
import { isTursoConfiguredRuntime } from "@/lib/turso";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * "Find my trip" in the student's own words. The endpoint reads the same
 * public, approved trips the page shows, asks the assistant to choose one id
 * from that list, and answers with a reply composed from the real row. A
 * missing model, an unusable answer or a hallucinated id all fall back to the
 * deterministic matcher, so the box keeps working when AI is off.
 */
export async function POST(request: Request) {
  try {
    const limited = await rateLimit(request, "trip-ai-search", { limit: 20, windowMs: 10 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);

    const body = await request.json() as { message?: unknown };
    const message = String(body.message || "").trim().slice(0, 300);
    if (!message) return Response.json({ error: "Describe the trip you want first." }, { status: 400, headers: NO_STORE });

    const configured = await isTursoConfiguredRuntime();
    if (configured) await seedDefaultScheduledTrips().catch(() => {});
    const trips = await getDynamicTrips({ activeOnly: true, approvedOnly: true });

    // The page hides the legacy morning/evening coaches when the schedule is
    // switched to a single departure; the assistant must see the same list.
    let visible = trips;
    if (configured) {
      const settings = await getTripSettings();
      const legacy = activeTripIds(settings.mode);
      visible = trips.filter((trip) => (trip.id === "1" || trip.id === "2") ? legacy.includes(Number(trip.id)) : true);
    }

    const names = await organizerDisplayNames(visible.map((trip) => trip.organizerId));
    const options: TripSearchTrip[] = visible.map((trip) => ({
      id: trip.id,
      from: trip.from,
      to: trip.to,
      travelDate: trip.travelDate,
      time: trip.time,
      arrival: trip.arrival,
      price: trip.price,
      capacity: trip.capacity,
      coachType: trip.coachType,
      organizerName: names[trip.organizerId] || "",
    }));

    const result = await tripSearchReply({ message, trips: options });
    return Response.json({ ok: true, ...result }, { headers: NO_STORE });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Trip search is unavailable right now. Browse the coaches on this page." },
      { status: 503, headers: NO_STORE },
    );
  }
}
