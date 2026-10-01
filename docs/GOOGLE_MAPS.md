# Google Maps setup

Hostel Finder, its property location picker, walking route displays, and CampusRide use the Maps JavaScript API. The script loads only when a map is mounted and is shared across maps on the page.

1. In the Google Cloud project that owns your API key, enable **Maps JavaScript API** and link a billing account.
2. Restrict the browser key to **Websites** and **Maps JavaScript API**. Include the origins you use:
   - `https://umatexpress.acmdevelopers2020.workers.dev/*`
   - `https://console-umatexpress.acmdevelopers2020.workers.dev/*`
   - Your custom production domains, if applicable.
   - `http://localhost:5173/*` and your actual development port when testing locally.
   - `http://127.0.0.1:5173/*` if you use that address locally.
3. Set the browser key in the ignored `.env` file:

   ```dotenv
   NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=your_browser_api_key
   NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID=
   ```

   The map ID is optional. A JavaScript map ID from your Google Cloud project may be supplied; otherwise Google's `DEMO_MAP_ID` is used for advanced markers. The maps request raster rendering so they do not depend on WebGL support.

4. Restart the development server after changing the key. For production, rebuild and deploy both the public and console Workers. These `NEXT_PUBLIC_` values are embedded in the browser build, so updating a Worker secret alone does not update them.
5. In **Admin → Platform settings**, turn **Google Maps** on. It is off by default; only administrators can change it, and changes are audited. The switch covers student maps, the property picker, walking route maps, and CampusRide. Off prevents new Google script and tile loads, keeps device location and manual coordinates available, and shows a compact message. Refresh open pages after changing it; allow up to 15 seconds for the setting to reach other servers. The switch itself requires no rebuild or redeploy. `GOOGLE_MAPS_ENABLED` is the runtime fallback until an admin saves an override.
6. Check the student hostel map and the console location picker. A saved entrance must appear on first load; clicking or dragging it must update latitude and longitude. On a phone, allow location access when choosing **Use my location**. Confirm the entrance before saving.

The Google sign-in client ID and OAuth client secret are not used for displaying maps. The browser map key is visible in browser requests by design; use website/API restrictions for it. Never place an OAuth client secret in a `NEXT_PUBLIC_` variable.

This change provides Google base maps and map controls. Existing address suggestions and pedestrian route calculations still use `OPENROUTESERVICE_API_KEY`. CampusRide draws its existing corridor geometry. Google Places, Geocoding, and Routes APIs are not required by this integration.

If a map fails, the screen offers a retry and the property form still accepts device location and manual coordinates. Check the browser console for Google's error code: `RefererNotAllowedMapError` means the website restriction is missing; `ApiNotActivatedMapError` means Maps JavaScript API is not enabled; `BillingNotEnabledMapError` means billing needs configuration.

Official references: [API setup](https://developers.google.com/maps/documentation/javascript/get-api-key), [loading the API](https://developers.google.com/maps/documentation/javascript/load-maps-js-api), [API errors](https://developers.google.com/maps/documentation/javascript/error-messages).
