import { platformSettingEnabled } from "@/lib/platform-settings";
import { envValue } from "@/lib/runtime-env";

/** Public map policy and HERE browser key. Settings writes remain admin-only. */
export async function GET() {
  const [hereMapsEnabled, apiKey] = await Promise.all([platformSettingEnabled("here_maps_enabled"), envValue("HERE_API_KEY")]);
  return Response.json({ hereMapsEnabled, hereApiKey: hereMapsEnabled ? apiKey : "" }, {
    headers: { "Cache-Control": "no-store" },
  });
}
