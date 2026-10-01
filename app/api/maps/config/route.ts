import { platformSettingEnabled } from "@/lib/platform-settings";

/** Public display policy only. Settings writes remain on the admin-only API. */
export async function GET() {
  return Response.json({ googleMapsEnabled: await platformSettingEnabled("google_maps_enabled") }, {
    headers: { "Cache-Control": "no-store" },
  });
}
