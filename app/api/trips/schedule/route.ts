import { staffEmailFromRequest } from "@/lib/staff-session";
import { isTursoConfiguredRuntime, turso } from "@/lib/turso";
import { ensureScheduledTripsTable, getDynamicTrips, seedDefaultScheduledTrips } from "@/lib/dynamic-trips";

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
  if (!(await isTursoConfiguredRuntime())) {
    return Response.json({ trips: await getDynamicTrips(), configured: false });
  }

  try {
    const adminView = new URL(request.url).searchParams.get("admin") === "1";
    if (adminView && !await staffEmailFromRequest(request)) {
      return Response.json({ error: "Admin access is not authorised." }, { status: 401 });
    }
    await seedDefaultScheduledTrips();
    const trips = await getDynamicTrips({ activeOnly: !adminView });
    return Response.json({ trips });
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
      "INSERT INTO scheduled_trips (id, title, route_from, route_to, travel_date, departure_time, arrival_time, price, capacity, coach_type, tag, amenities, notes, active, display_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
    const trip = (await getDynamicTrips({ activeOnly: false })).find((item) => item.id === id);
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
