# Maps, address search and walking routes

Embedded Hostel Finder and CampusRide maps use Leaflet with OpenStreetMap tiles. The browser reads only the map-enabled flag and tile URL from /api/maps/config; it does not receive a HERE or GraphHopper API key.

- **Display:** Enable **Interactive maps** in Admin → Platform settings. HERE_MAPS_ENABLED remains the runtime fallback name for this existing setting, even though display now uses OpenStreetMap. OSM_TILE_URL may specify an HTTPS tile template; blank uses the standard OpenStreetMap tiles. Choose a tile provider whose usage terms match expected traffic. The switch affects embedded maps, not saved location coordinates.
- **Property address suggestions:** Set HERE_API_KEY as a server secret to enable the landlord's address search. The key is sent only from the server to HERE Autosuggest. Owners must still confirm the pin. Without the key, staff can use device location or enter coordinates manually.
- **Walking routes:** Set GRAPHOPPER_API_KEY as a server secret to enable pedestrian distance and time. Without a route, the student page labels the direct distance separately and does not invent a walking estimate.

Map failures show a retry action. The map setting takes effect after a page refresh; allow up to 15 seconds for a saved admin change to propagate across servers. Rotating a server-side key requires updating the Worker secret.
