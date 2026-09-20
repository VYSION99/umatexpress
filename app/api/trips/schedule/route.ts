import { staffEmailFromRequest } from "@/lib/staff-session";
import { isTursoConfiguredRuntime, turso } from "@/lib/turso";
import { ensureScheduledTripsTable, getDynamicTrips, seedDefaultScheduledTrips } from "@/lib/dynamic-trips";
import { organizerDisplayNames } from "@/lib/organizers";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

export type ScheduledTripInput = {
  title: string;
  routeFrom: string;
  routeTo: string;
  travelDate: string;
  departureTime: string;
  arrivalTime: string;
  price: number;
  capacity: number;
  coachType: string;
  tag?: string;
  amenities?: string[];
  notes?: string;
  active?: boolean;
  displayOrder?: number;
};

function normalizeTripBody(body: Partial<ScheduledTripInput>) {
  const title = String(body.title ?? "").trim();
  const routeFrom = String(body.routeFrom ?? "").trim();
  const routeTo = String(body.routeTo ?? "").trim();
  const travelDate = String(body.travelDate ?? "").trim();
  const departureTime = String(body.departureTime ?? "").trim();
  const arrivalTime = String(body.arrivalTime ?? "").trim();
  const coachType = String(body.coachType ?? "VIP Coach").trim() || "VIP Coach";
  const tag = String(body.tag ?? title).trim() || title;
  const amenities = Array.isArray(body.amenities) ? body.amenities.map((item) => String(item).trim()).filter(Boolean) : ["AC", "Wi-Fi", "USB power"];
  const notes = String(body.notes ?? "").trim();
  const price = Number(body.price ?? 0);
  const capacity = Number(body.capacity ?? 0);
  const active = Boolean(body.active ?? true);
  const displayOrder = Number(body.displayOrder ?? 0);

  if (!title || !routeFrom || !routeTo || !travelDate || !departureTime || !arrivalTime) {
    return { error: "Provide the trip title, route, travel date, and both departure and arrival times." };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(travelDate)) return { error: "Choose a valid travel date." };
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(departureTime) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(arrivalTime)) return { error: "Choose valid departure and arrival times." };
  if (!Number.isFinite(price) || price <= 0) return { error: "The trip fare must be greater than zero." };
  if (!Number.isFinite(capacity) || capacity <= 0) return { error: "Seat capacity must be greater than zero." };

  return {
    value: {
      title,
      routeFrom,
      routeTo,
      travelDate,
      departureTime,
      arrivalTime,
      price: Math.round(price),
      capacity: Math.round(capacity),
      coachType,
      tag,
      amenities,
      notes,
      active,
      displayOrder: Number.isFinite(displayOrder) ? Math.round(displayOrder) : 0,
    },
  };
}

export async function GET(request: Request) {
  const adminView = new URL(request.url).searchParams.get("admin") === "1";
  // The public read is the cheapest way to scrape the whole schedule, and it
  // hits the database on every call. Both views are metered before the auth
  // check, because otherwise `?admin=1` is an unauthenticated way around the
  // limiter. The ceiling is generous on purpose: a campus network puts many
  // students behind one address, so the limit is there to stop a flood, not to
  // meter a person.
  const limited = await rateLimit(request, "trips-schedule-read", { limit: 240, windowMs: 60_000 });
  if (!limited.ok) return rateLimitResponse(limited.retryAfter);
  if (!(await isTursoConfiguredRuntime())) {
    return Response.json({ trips: await getDynamicTrips(), configured: false });
  }

  try {
    if (adminView && !await staffEmailFromRequest(request)) {
      return Response.json({ error: "Admin access is not authorised." }, { status: 401 });
    }
    await seedDefaultScheduledTrips();
    // The admin view is the only reader allowed to see trips that are not
    // approved; students never see an unreviewed trip.
    const trips = await getDynamicTrips({ activeOnly: !adminView, approvedOnly: !adminView });
    // The public list groups coaches by who runs them, so it needs a display
    // name. Names only, and an unreachable lookup degrades to the platform
    // label rather than failing the list.
    const names = await organizerDisplayNames(trips.map((trip) => trip.organizerId));
    return Response.json({ trips: trips.map((trip) => ({ ...trip, organizerName: names[trip.organizerId] || "" })) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Scheduled trips could not be loaded." }, { status: 503 });
  }
}

export async function POST(request: Request) {
  if (!await staffEmailFromRequest(request)) {
    return Response.json({ error: "Admin access is not authorised." }, { status: 401 });
  }

  try {
    if (!(await isTursoConfiguredRuntime())) {
      throw new Error("Configure Turso before creating a trip.");
    }

    const parsed = normalizeTripBody(await request.json() as Partial<ScheduledTripInput>);
    if (parsed.error || !parsed.value) return Response.json({ error: parsed.error }, { status: 400 });
    const { title, routeFrom, routeTo, travelDate, departureTime, arrivalTime, price, capacity, coachType, tag, amenities, notes, active, displayOrder } = parsed.value;

    await ensureScheduledTripsTable();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await turso(
      // A trip an administrator creates belongs to the platform and is live
      // immediately; the review gate exists for organizer submissions.
      "INSERT INTO scheduled_trips (id, title, route_from, route_to, travel_date, departure_time, arrival_time, price, capacity, coach_type, tag, amenities, notes, active, display_order, organizer_id, review_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'APPROVED', ?, ?)",
      [id, title, routeFrom, routeTo, travelDate, departureTime, arrivalTime, price, capacity, coachType, tag, JSON.stringify(amenities), notes, active ? 1 : 0, displayOrder, now, now],
    );

    return Response.json({
      trip: {
        id,
        title,
        from: routeFrom,
        to: routeTo,
        travelDate,
        time: departureTime,
        arrival: arrivalTime,
        price,
        capacity,
        coachType,
        tag,
        amenities,
        notes,
        active,
        displayOrder,
        createdAt: now,
      },
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "The trip could not be scheduled." }, { status: 503 });
  }
}

export async function PATCH(request: Request) {
  if (!await staffEmailFromRequest(request)) return Response.json({ error: "Admin access is not authorised." }, { status: 401 });

  try {
    if (!(await isTursoConfiguredRuntime())) throw new Error("Configure Turso before updating a trip.");
    const body = await request.json() as Partial<ScheduledTripInput> & { id?: string };
    const id = String(body.id || "").trim();
    if (!id) return Response.json({ error: "Missing trip id." }, { status: 400 });
    const parsed = normalizeTripBody(body);
    if (parsed.error || !parsed.value) return Response.json({ error: parsed.error }, { status: 400 });
    const { title, routeFrom, routeTo, travelDate, departureTime, arrivalTime, price, capacity, coachType, tag, amenities, notes, active, displayOrder } = parsed.value;
    const now = new Date().toISOString();

    await ensureScheduledTripsTable();
    await turso(
      "UPDATE scheduled_trips SET title = ?, route_from = ?, route_to = ?, travel_date = ?, departure_time = ?, arrival_time = ?, price = ?, capacity = ?, coach_type = ?, tag = ?, amenities = ?, notes = ?, active = ?, display_order = ?, updated_at = ? WHERE id = ?",
      [title, routeFrom, routeTo, travelDate, departureTime, arrivalTime, price, capacity, coachType, tag, JSON.stringify(amenities), notes, active ? 1 : 0, displayOrder, now, id],
    );
    const trip = (await getDynamicTrips({ activeOnly: false, approvedOnly: false })).find((item) => item.id === id);
    if (!trip) return Response.json({ error: "Trip was not found." }, { status: 404 });
    return Response.json({ trip });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "The trip could not be updated." }, { status: 503 });
  }
}

export async function DELETE(request: Request) {
  if (!await staffEmailFromRequest(request)) return Response.json({ error: "Admin access is not authorised." }, { status: 401 });

  try {
    if (!(await isTursoConfiguredRuntime())) throw new Error("Configure Turso before deleting a trip.");
    const id = String((await request.json() as { id?: string }).id || "").trim();
    if (!id) return Response.json({ error: "Missing trip id." }, { status: 400 });
    await ensureScheduledTripsTable();
    await turso("UPDATE scheduled_trips SET archived = 1, active = 0, updated_at = ? WHERE id = ?", [new Date().toISOString(), id]);
    return Response.json({ ok: true, archived: true, id });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "The trip could not be deleted." }, { status: 503 });
  }
}
