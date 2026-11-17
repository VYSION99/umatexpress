import { envValue } from "@/lib/runtime-env";
import { isTursoConfiguredRuntime, turso } from "@/lib/turso";
import { CURIOSITY_POLICY_VERSION, type CuriosityServiceId } from "./catalog";

const COOKIE = "umatexpress_curiosity_pilot";
const COHORT_SECONDS = 7 * 24 * 60 * 60;
const FEEDBACK_SECONDS = 15 * 60;
const encoder = new TextEncoder();

function hex(bytes: Uint8Array) { return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
function fromHex(value: string) {
  if (!/^(?:[0-9a-f]{2})+$/.test(value)) return null;
  return new Uint8Array(value.match(/.{2}/g)!.map((part) => Number.parseInt(part, 16)));
}
function cookieValue(request: Request) {
  return request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) || "";
}
async function key(secret: string) {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function signature(secret: string, message: string) {
  return new Uint8Array(await crypto.subtle.sign("HMAC", await key(secret), encoder.encode(message)));
}
async function validSignature(secret: string, message: string, supplied: string) {
  const bytes = fromHex(supplied);
  return bytes?.length === 32 && crypto.subtle.verify("HMAC", await key(secret), bytes, encoder.encode(message));
}
function percentValue(raw: string) {
  const value = raw === "" ? 5 : Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= 100 ? value : 0;
}

/** Fail closed unless rollout, storage and a separate signing secret are ready. */
export async function curiosityPilotConfig() {
  const [flag, secret, percent] = await Promise.all([
    envValue("CURIOSITY_PILOT_ENABLED"), envValue("CURIOSITY_PILOT_SIGNING_KEY"), envValue("CURIOSITY_PILOT_PERCENT"),
  ]);
  const enabled = ["1", "true"].includes(flag.toLowerCase()) && secret.length >= 32
    && percentValue(percent) > 0 && await isTursoConfiguredRuntime();
  return { enabled, secret: enabled ? secret : "", percent: enabled ? percentValue(percent) : 0 };
}

function cohortCookie(request: Request, value: string, maxAge: number) {
  const secure = new URL(request.url).protocol === "https:" ? " Secure;" : "";
  return `${COOKIE}=${value}; Path=/api/curiosity; HttpOnly;${secure} SameSite=Lax; Max-Age=${maxAge}`;
}
export function clearCuriosityPilotCookie(request: Request) { return cohortCookie(request, "", 0); }

async function parseCohort(request: Request, secret: string) {
  const [version, expires, nonce, mac] = cookieValue(request).split(".");
  if (version !== "v1" || !/^\d{10}$/.test(expires || "") || !/^[0-9a-f]{32}$/.test(nonce || "") || !/^[0-9a-f]{64}$/.test(mac || "")) return null;
  if (Number(expires) <= Math.floor(Date.now() / 1000)) return null;
  if (!await validSignature(secret, `cohort|${version}|${expires}|${nonce}`, mac)) return null;
  return { nonce, mac };
}
function admitted(mac: string, percent: number) {
  return (Number.parseInt(mac.slice(0, 8), 16) / 0x1_0000_0000) < percent / 100;
}

/** The GET response sets one stable, anonymous 7-day cohort assignment. */
export async function curiosityCohortInvitation(request: Request) {
  const config = await curiosityPilotConfig();
  if (!config.enabled) return { enabled: false, cookie: "" };
  let assignment = await parseCohort(request, config.secret);
  let cookie = "";
  if (!assignment) {
    const expires = String(Math.floor(Date.now() / 1000) + COHORT_SECONDS);
    const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
    const mac = hex(await signature(config.secret, `cohort|v1|${expires}|${nonce}`));
    assignment = { nonce, mac };
    cookie = cohortCookie(request, `v1.${expires}.${nonce}.${mac}`, COHORT_SECONDS);
  }
  const eligible = admitted(assignment.mac, config.percent);
  if (eligible) {
    try { await turso("SELECT 1"); } catch { return { enabled: false, cookie }; }
  }
  return { enabled: eligible, cookie };
}

export async function curiosityCohortNonce(request: Request) {
  const config = await curiosityPilotConfig();
  if (!config.enabled) return null;
  const assignment = await parseCohort(request, config.secret);
  return assignment && admitted(assignment.mac, config.percent) ? assignment.nonce : null;
}

export async function issueCuriosityFeedbackToken(serviceId: CuriosityServiceId, cohortNonce: string) {
  const { secret } = await curiosityPilotConfig();
  if (!secret) throw new Error("Curiosity pilot is unavailable.");
  const expires = String(Math.floor(Date.now() / 1000) + FEEDBACK_SECONDS);
  const random = hex(crypto.getRandomValues(new Uint8Array(16)));
  const payload = `v1.${expires}.${serviceId}.${random}`;
  const mac = hex(await signature(secret, `feedback|${cohortNonce}|${CURIOSITY_POLICY_VERSION}|${payload}`));
  return `${payload}.${mac}`;
}

export async function validCuriosityFeedbackToken(token: string, serviceId: CuriosityServiceId, cohortNonce: string) {
  if (token.length > 200) return false;
  const [version, expires, service, random, mac] = token.split(".");
  if (version !== "v1" || !/^\d{10}$/.test(expires || "") || Number(expires) <= Math.floor(Date.now() / 1000)
    || service !== serviceId || !/^[0-9a-f]{32}$/.test(random || "") || !/^[0-9a-f]{64}$/.test(mac || "")) return false;
  const { secret } = await curiosityPilotConfig();
  return Boolean(secret && await validSignature(secret, `feedback|${cohortNonce}|${CURIOSITY_POLICY_VERSION}|${version}.${expires}.${service}.${random}`, mac));
}

export async function curiosityFeedbackDedupeHash(cohortNonce: string, serviceId: CuriosityServiceId) {
  const day = new Date().toISOString().slice(0, 10);
  const { secret } = await curiosityPilotConfig();
  if (!secret) throw new Error("Curiosity pilot is unavailable.");
  return hex(await signature(secret, `dedupe|v1|${cohortNonce}|${serviceId}|${CURIOSITY_POLICY_VERSION}|${day}`));
}
