import { CampusEngineError } from "@/lib/campus-engine/errors";
import { claimFreeJaasMonthlyIdentity, claimFreeStageDevice, entitlementBySession, releaseFreeStageDevice } from "@/lib/cinema-streaming/entitlements";
import { platformSettingEnabled } from "@/lib/platform-settings";
import { envValue } from "@/lib/runtime-env";
import { rowsToObjects, turso } from "@/lib/turso";

export type JaasRuntime = { enabled: boolean; configured: boolean; domain: string; appId: string; keyId: string };
export type JaasCredentials = { domain: string; appId: string; keyId: string; privateKeyBase64: string };
type StageRole = "HOST" | "COHOST" | "PRESENTER";

/** Server-only configuration probe. No credential is returned by an API route. */
export async function jaasRuntime(): Promise<JaasRuntime> {
  const [enabled, domain, appId, keyId, privateKeyBase64] = await Promise.all([
    platformSettingEnabled("cinema_jaas_enabled"), envValue("JAAS_DOMAIN"), envValue("JAAS_APP_ID"),
    envValue("JAAS_KEY_ID"), envValue("JAAS_PRIVATE_KEY_BASE64"),
  ]);
  return { enabled, configured: Boolean(appId && keyId && privateKeyBase64), domain: domain || "8x8.vc", appId, keyId };
}

async function serverCredentials(): Promise<JaasCredentials> {
  const [runtime, privateKeyBase64] = await Promise.all([jaasRuntime(), envValue("JAAS_PRIVATE_KEY_BASE64")]);
  if (!runtime.enabled) throw new CampusEngineError("CONFIG_REQUIRED", "The managed Cinema stage is currently paused.", 503);
  if (!runtime.configured || !privateKeyBase64) throw new CampusEngineError("CONFIG_REQUIRED", "The managed Cinema stage credentials are incomplete.", 503);
  if (runtime.domain !== "8x8.vc" || !/^[A-Za-z0-9_-]+$/.test(runtime.appId) || !/^[A-Za-z0-9_./-]+$/.test(runtime.keyId)) {
    throw new CampusEngineError("CONFIG_REQUIRED", "The managed Cinema stage identifiers are invalid.", 503);
  }
  return { domain: runtime.domain, appId: runtime.appId, keyId: runtime.keyId, privateKeyBase64 };
}

function base64Url(input: Uint8Array | string) {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64(value: string) {
  const normalized = value.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function derLength(length: number) {
  if (length < 128) return Uint8Array.of(length);
  const bytes: number[] = [];
  for (let value = length; value > 0; value >>>= 8) bytes.unshift(value & 255);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function der(tag: number, content: Uint8Array) {
  const length = derLength(content.length);
  const output = new Uint8Array(1 + length.length + content.length);
  output[0] = tag;
  output.set(length, 1);
  output.set(content, 1 + length.length);
  return output;
}

function joinBytes(...parts: Uint8Array[]) {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}

/** WebCrypto imports PKCS#8. Wrap a JaaS PKCS#1 RSA key when necessary. */
function pkcs8Key(privateKeyBase64: string) {
  let text = "";
  try { text = new TextDecoder().decode(decodeBase64(privateKeyBase64)); }
  catch { throw new CampusEngineError("CONFIG_REQUIRED", "The JaaS private key is not valid base64.", 503); }
  const match = text.match(/-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]+?)-----END (?:RSA )?PRIVATE KEY-----/);
  if (!match) throw new CampusEngineError("CONFIG_REQUIRED", "The JaaS private key must contain a PEM private key.", 503);
  const key = decodeBase64(match[2]);
  if (!match[1]) return key;
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  const rsaAlgorithm = Uint8Array.of(0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00);
  return der(0x30, joinBytes(version, rsaAlgorithm, der(0x04, key)));
}

export type JaasTokenInput = {
  roomAlias: string;
  user: { id: string; name: string; email: string };
  role: StageRole;
  expiresAt: Date;
  now?: Date;
};

/** Pure signing boundary, exported so its exact claims and signature can be tested. */
export async function signJaasStageToken(input: JaasTokenInput, credentials: JaasCredentials) {
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const expires = Math.floor(input.expiresAt.getTime() / 1000);
  if (!/^[A-Za-z0-9_-]{3,120}$/.test(input.roomAlias)) throw new CampusEngineError("VALIDATION_ERROR", "The managed-stage room name is invalid.", 400);
  if (expires <= nowSeconds || expires > nowSeconds + 20 * 60) throw new CampusEngineError("VALIDATION_ERROR", "Managed-stage tokens must expire within twenty minutes.", 400);
  const moderator = input.role === "HOST" || input.role === "COHOST";
  const header = { alg: "RS256", kid: credentials.keyId, typ: "JWT" };
  const payload = {
    aud: "jitsi", iss: "chat", sub: credentials.appId, room: input.roomAlias,
    nbf: nowSeconds - 10, exp: expires,
    context: {
      room: { regex: false },
      user: {
        id: input.user.id, name: input.user.name.slice(0, 100) || "Cinema participant", email: input.user.email,
        avatar: "", moderator: moderator ? "true" : "false", "hidden-from-recorder": false,
      },
      features: {
        livestreaming: input.role === "HOST", recording: false, transcription: false,
        "outbound-call": false, "sip-outbound-call": false, "file-upload": false,
      },
    },
  };
  const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey("pkcs8", pkcs8Key(credentials.privateKeyBase64), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  } catch {
    throw new CampusEngineError("CONFIG_REQUIRED", "The JaaS private key could not sign RS256 tokens.", 503);
  }
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
}

function roomAlias(eventId: string) { return `umx-${eventId.replace(/[^A-Za-z0-9]/g, "").slice(0, 64)}`; }

export async function issueJaasStageAccess(input: {
  sessionId: string;
  account: { id: string; name: string; email: string };
  deviceSessionId: string;
  now?: Date;
  credentials?: JaasCredentials;
}) {
  const entitlement = await entitlementBySession(input.sessionId);
  if (!entitlement || entitlement.provider !== "JAAS") throw new CampusEngineError("NOT_FOUND", "This room uses the standard Cinema stage.", 404);
  const row = rowsToObjects(await turso(`SELECT e.id AS event_id,e.status AS event_status,o.status AS organizer_status,o.organizer_type,o.verified_at,
      s.status AS room_status,s.host_student_id,COALESCE(p.role,'VIEWER') AS participant_role
    FROM cinema_events e JOIN cinema_organizers o ON o.id=e.organizer_id JOIN cinema_sessions s ON s.id=e.session_id
    LEFT JOIN cinema_participants p ON p.session_id=s.id AND p.student_id=?
    WHERE s.id=? LIMIT 1`, [input.account.id, input.sessionId]))[0];
  if (!row || String(row.event_status) !== "PUBLISHED" || String(row.organizer_status) !== "ACTIVE" ||
    (String(row.organizer_type) !== "STUDENT_GROUP" && !row.verified_at)) {
    throw new CampusEngineError("FORBIDDEN", "This managed event is not currently published.", 403);
  }
  if (!["CREATED", "LIVE"].includes(String(row.room_status))) throw new CampusEngineError("INVALID_STATE", "This managed stage has ended.", 409);
  const role = String(row.host_student_id) === input.account.id ? "HOST" : String(row.participant_role).toUpperCase();
  if (!["HOST", "COHOST", "PRESENTER"].includes(role)) throw new CampusEngineError("FORBIDDEN", "The host must admit you to the speaking stage first.", 403);
  const now = input.now ?? new Date();
  if (now.getTime() < Date.parse(entitlement.startsAt) - 30 * 60_000) throw new CampusEngineError("INVALID_STATE", "The managed stage opens thirty minutes before the event.", 409);
  if (now.getTime() >= Date.parse(entitlement.expiresAt)) throw new CampusEngineError("INVALID_STATE", "This managed-stage entitlement has expired.", 409);
  const credentials = input.credentials ?? await serverCredentials();
  const alias = roomAlias(entitlement.eventId);
  const tokenExpiresAt = new Date(Math.min(now.getTime() + 15 * 60_000, Date.parse(entitlement.expiresAt)));
  const token = await signJaasStageToken({ roomAlias: alias, user: input.account, role: role as StageRole, expiresAt: tokenExpiresAt, now }, credentials);
  await claimFreeStageDevice({ eventId: entitlement.eventId, studentId: input.account.id, deviceSessionId: input.deviceSessionId, now });
  try {
    const usage = await claimFreeJaasMonthlyIdentity({ studentId: input.account.id, now });
    return { provider: "JAAS" as const, domain: credentials.domain, roomName: `${credentials.appId}/${alias}`, token, role: role as StageRole, expiresAt: tokenExpiresAt.toISOString(), usage };
  } catch (error) {
    await releaseFreeStageDevice({ eventId: entitlement.eventId, studentId: input.account.id, deviceSessionId: input.deviceSessionId });
    throw error;
  }
}

export async function releaseJaasStageAccess(input: { sessionId: string; accountId: string; deviceSessionId: string }) {
  const entitlement = await entitlementBySession(input.sessionId);
  if (!entitlement || entitlement.provider !== "JAAS") return { released: false };
  return releaseFreeStageDevice({ eventId: entitlement.eventId, studentId: input.accountId, deviceSessionId: input.deviceSessionId });
}
