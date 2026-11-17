# CampusRide zone directory

`campus_zones` is the shared source of truth for pickup and destination places. A zone has a stable `id`, student-facing `name` and `landmark`, latitude and longitude in decimal degrees, and an `active` flag. Pickup and destination are roles a zone can play in a corridor; they are not separate tables. `campus_route_corridors.origin_zone_id` and `destination_zone_id` reference those zone IDs.

The table already exists in the foundation schema. Apply [060_campus_zone_coordinates.sql](../../sql/060_campus_zone_coordinates.sql) to an existing database, or use the updated combined migration. The runtime campus schema pass creates the same triggers. They reject future zone writes without coordinates or outside latitude −90…90 and longitude −180…180, and reject corridor writes that do not reference two distinct active zones. Existing zone rows and coordinates are preserved.

The student route picker and public zone endpoint use only active zones with valid coordinates and corridors connecting them. The default route is the valid route with the most available queue places. The pickup and destination dropdowns show the zone landmark to help students identify the intended meeting point. A student choosing a different pickup sees only destinations connected to that zone.

The route picker can suggest the nearest mapped pickup from browser geolocation. It checks automatically only when the browser has already granted location access; otherwise the student can choose **Detect nearest pickup** and respond to the browser permission request. Matching runs locally against the zone coordinates already on the page. Exact GPS coordinates are not added to the URL or sent with the booking request. If the detected pickup cannot serve the current destination, the picker selects a valid destination and asks the student to review the route before showing rides. Poor GPS accuracy is called out rather than presenting the suggestion as an exact meeting point.

Staff can review and edit the zone directory in the CampusRide admin setup screen. Enter the coordinates of the **actual meeting point**, not a broad neighbourhood center. The six existing production rows have coordinates, but their accuracy should be checked on site before using them for precise walking directions. Editing a zone changes future map and distance calculations; it does not rewrite past queue entries.

To audit a database before release:

```sql
SELECT id, name, latitude, longitude, active FROM campus_zones ORDER BY name;
SELECT c.id, c.origin_zone_id, c.destination_zone_id
FROM campus_route_corridors c
LEFT JOIN campus_zones origin ON origin.id = c.origin_zone_id
LEFT JOIN campus_zones destination ON destination.id = c.destination_zone_id
WHERE origin.id IS NULL OR destination.id IS NULL
   OR origin.active <> 1 OR destination.active <> 1
   OR c.origin_zone_id = c.destination_zone_id;
```
