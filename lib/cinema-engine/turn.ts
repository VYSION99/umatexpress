import { logEvent } from "@/lib/observability";
import { envValue } from "@/lib/runtime-env";

/**
 * The ICE servers a room's browsers are allowed to use.
 *
 * The mesh itself is peer to peer, which is what keeps the platform out of the
 * audio path; a TURN relay is only needed when two networks cannot meet
 * directly. Cloudflare's TURN service is the relay, and its credentials are
 * short-lived and minted here — the API token that can mint them never leaves
 * the Worker, and a client only ever sees the username and credential for its
 * own session.
 *
 * A deployment without the two TURN variables is not broken: the room falls
 * back to Cloudflare's public STUN server, which is enough whenever both peers
 * are on an ordinary network. No resolver means no relay, and the client says
 * so rather than pretending the call will always connect.
 */

export type CinemaIceServer = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

/** The same STUN endpoint Cloudflare documents for Calls and RealtimeKit. */
export const CINEMA_STUN_ONLY: CinemaIceServer[] = [{ urls: "stun:stun.cloudflare.com:3478" }];

/** Cloudflare's own maximum; the isolate cache below refreshes well before it. */
const TURN_CREDENTIAL_TTL_SECONDS = 24 * 60 * 60;
/** An hour: the credentials live for a day, so re-minting early costs nothing. */
const CACHE_MS = 60 * 60_000;

let cached: { at: number; servers: CinemaIceServer[] } | null = null;

/** Test seam: a fresh isolate must not reuse another deployment's credentials. */
export function resetCinemaIceCache() {
  cached = null;
}

const ICE_URL_PATTERN = /^(stun|stuns|turn|turns):/i;

/** Only the URL shapes a browser can use, and only strings, survive. */
function normalizeIceServers(value: unknown): CinemaIceServer[] {
  // Cloudflare answers with one object; a deployment proxy may hand back a
  // list. Both are the same thing, so both are accepted.
  const entries = Array.isArray(value) ? value : value && typeof value === "object" ? [value] : [];
  const servers: CinemaIceServer[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const source = entry as { urls?: unknown; username?: unknown; credential?: unknown };
    const urls = (Array.isArray(source.urls) ? source.urls : [source.urls])
      .map((url) => String(url || "").trim())
      .filter((url) => ICE_URL_PATTERN.test(url));
    if (!urls.length) continue;
    const server: CinemaIceServer = { urls: urls.length === 1 ? urls[0] : urls };
    if (typeof source.username === "string" && source.username) server.username = source.username;
    if (typeof source.credential === "string" && source.credential) server.credential = source.credential;
    servers.push(server);
  }
  return servers;
}

export async function cinemaIceServers(input: { fetchImpl?: typeof fetch; now?: number } = {}): Promise<{ iceServers: CinemaIceServer[]; turn: boolean }> {
  const now = input.now ?? Date.now();
  if (cached && now - cached.at < CACHE_MS) return { iceServers: cached.servers, turn: true };

  const keyId = String(await envValue("CLOUDFLARE_TURN_KEY_ID")).trim();
  const token = String(await envValue("CLOUDFLARE_TURN_API_TOKEN")).trim();
  if (!keyId || !token) return { iceServers: CINEMA_STUN_ONLY, turn: false };

  try {
    const request = input.fetchImpl ?? fetch;
    const response = await request(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ ttl: TURN_CREDENTIAL_TTL_SECONDS }),
      },
    );
    if (!response.ok) throw new Error(`TURN credential request failed with ${response.status}.`);
    const body = await response.json() as { iceServers?: unknown };
    const servers = normalizeIceServers(body?.iceServers);
    if (!servers.length) throw new Error("TURN credential response carried no usable ICE servers.");
    cached = { at: now, servers };
    return { iceServers: servers, turn: true };
  } catch (error) {
    // A relay that is down must not close the room: STUN-only still connects
    // two ordinary networks, and the next request tries the relay again.
    logEvent("warn", "cinema_turn_unavailable", { reason: error instanceof Error ? error.message : "unknown" });
    return { iceServers: CINEMA_STUN_ONLY, turn: false };
  }
}
