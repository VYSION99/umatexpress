import { ensureScheduledTripsTable } from "@/lib/dynamic-trips";
import { ensureOrganizerTables, noticeRowToPromo } from "@/lib/organizers";
import { trips as legacyTrips } from "@/lib/trips";
import { assemblePublicNotices, type NoticeRoute, type PublicNotice } from "@/lib/trip-notice";
import { DEFAULT_TRIP_SETTINGS, getTripSettings } from "@/lib/trip-settings";
import { isTursoConfiguredRuntime, rowsToObjects, turso } from "@/lib/turso";

/**
 * Every flyer the public page should rotate through: the platform notice plus
 * each approved organizer's notice. The route line is not stored on the notice
 * at all — it is composed from the live, approved coaches each notice belongs
 * to, so a notice can never advertise a destination nobody is driving to.
 */

function routesByOwner(rows: Record<string, unknown>[]) {
  const routes = new Map<string, NoticeRoute[]>();
  for (const row of rows) {
    const owner = String(row.organizer_id || "");
    const from = String(row.route_from || "").trim();
    const to = String(row.route_to || "").trim();
    if (!from || !to) continue;
    routes.set(owner, [...(routes.get(owner) || []), { from, to }]);
  }
  return routes;
}

export async function listPublicNotices(): Promise<PublicNotice[]> {
  if (!(await isTursoConfiguredRuntime())) {
    return assemblePublicNotices({
      platform: DEFAULT_TRIP_SETTINGS.flyerPromo,
      platformRoutes: legacyTrips.map((trip) => ({ from: trip.from, to: trip.to })),
      organizers: [],
    });
  }
  await ensureScheduledTripsTable();
  await ensureOrganizerTables();
  const [settings, tripRows, noticeRows] = await Promise.all([
    getTripSettings(),
    // Only coaches a student can actually book count towards a route line.
    turso("SELECT COALESCE(organizer_id,'') AS organizer_id, route_from, route_to FROM scheduled_trips WHERE active = 1 AND archived = 0 AND review_status = 'APPROVED'"),
    turso(
      `SELECT n.organizer_id AS organizer_id, COALESCE(o.name,'') AS organizer_name,
              n.enabled, n.title, n.route, n.fare, n.night_bus, n.day_buses,
              n.drop_off_points, n.amenities, n.contacts
       FROM trip_notices n
       JOIN trip_organizers o ON o.id = n.organizer_id
       WHERE n.enabled = 1 AND o.status = 'APPROVED'`,
    ),
  ]);
  const routes = routesByOwner(rowsToObjects(tripRows));
  return assemblePublicNotices({
    platform: settings.flyerPromo,
    platformRoutes: routes.get("") || [],
    organizers: rowsToObjects(noticeRows).map((row) => ({
      id: String(row.organizer_id || ""),
      name: String(row.organizer_name || "").trim(),
      promo: noticeRowToPromo(row),
      routes: routes.get(String(row.organizer_id || "")) || [],
    })),
  });
}
