# HERE maps and GraphHopper routes

The application uses HERE Maps API for JavaScript to render Hostel Finder, property location, walking-route, and CampusRide maps. Property address suggestions use HERE Geocoding and Search from the server. Hostel walking distances and times use GraphHopper pedestrian routes from the server. CampusRide still draws its stored, surveyed corridors; the map provider does not recalculate those routes.

1. Set `HERE_APP_ID` and `HERE_API_KEY` in `.env`. HERE issues both for one registered app. The app ID is for your records; the API key authenticates both the browser map and server-side address suggestions. A browser map necessarily receives the API key while the map is enabled. Configure suitable usage limits in HERE.
2. The public `/api/maps/config` response includes the HERE API key only while the admin map switch is on. Changing `HERE_API_KEY` requires a server restart or redeploy, but no frontend rebuild.
3. Create a GraphHopper API key and set `GRAPHOPPER_API_KEY` as a server secret. Walking routes remain optional; when unavailable the UI shows only the clearly labelled straight-line distance. Check GraphHopper's current plan and commercial-use terms before production use.
4. In **Admin → Platform settings**, enable **HERE Maps**. It is off by default and writes are audited. The switch controls embedded maps only; it does not block location capture, manual coordinates, address suggestions, or GraphHopper requests. Changes apply after a page refresh, allowing up to 15 seconds for server settings to propagate. `HERE_MAPS_ENABLED` is the runtime fallback until an admin saves an override.

If a browser map cannot initialize, its page shows a retry action; property staff can still set location without it. Map errors do not log provider credentials.

Official references: [HERE Maps JavaScript quick start](https://docs.here.com/maps-api-for-js/docs/quick-start), [HERE Autosuggest](https://docs.here.com/geocoding-and-search/docs/autosuggest), [GraphHopper Directions API](https://docs.graphhopper.com/openapi), [GraphHopper pricing](https://www.graphhopper.com/pricing/).
