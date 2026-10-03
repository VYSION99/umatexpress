import { platformSettingEnabled } from "@/lib/platform-settings";
import { envValue } from "@/lib/runtime-env";
import { DEFAULT_OSM_TILE_URL, validTileUrl } from "@/lib/osm-maps";

/** Public map display policy. HERE remains server-side for address suggestions. */
export async function GET() {
  const [mapsEnabled, configuredTileUrl] = await Promise.all([
    platformSettingEnabled("here_maps_enabled"),
    envValue("OSM_TILE_URL"),
  ]);
  const tileUrl = validTileUrl(configuredTileUrl) ? configuredTileUrl : DEFAULT_OSM_TILE_URL;
  return Response.json({ mapsEnabled, tileUrl }, { headers: { "Cache-Control": "no-store" } });
}
