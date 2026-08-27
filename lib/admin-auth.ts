import { verifyAdminPassword } from "@/lib/admin-credentials";

const COOKIE_NAME = "umx_admin_session";
const SESSION_SECONDS = 8 * 60 * 60;

type SessionPayload = { email: string; exp: number };

function adminEmails() {
  return (process.env.ADMIN_EMAILS || "").toLowerCase().split(",").map((item) => item.trim()).filter(Boolean);
}

function sessionSecret() {
  const secret = process.env.ADMIN_SESSION_SECRET || "";
  if (secret.length < 32 || secret.startsWith("replace-with")) return null;
  return secret;
}

function encode(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decode(value: string) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

async function signature(value: string, secret: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const result = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return encode(String.fromCharCode(...new Uint8Array(result)));
}

async function equalSecret(left: string, right: string) {
  const [leftHash, rightHash] = await Promise.all([left, right].map(async (value) => {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return new Uint8Array(hash);
  }));
  let difference = leftHash.length ^ rightHash.length;
  for (let index = 0; index < Math.max(leftHash.length, rightHash.length); index++) {
    difference |= (leftHash[index] || 0) ^ (rightHash[index] || 0);
  }
  return difference === 0;
}

function cookieValue(request: Request) {
  const prefix = `${COOKIE_NAME}=`;
  const item = (request.headers.get("cookie") || "").split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix));
  if (!item) return null;
  try { return decodeURIComponent(item.slice(prefix.length)); } catch { return null; }
}

export async function createAdminSession(email: string) {
  const secret = sessionSecret();
  if (!secret) throw new Error("ADMIN_SESSION_SECRET must contain at least 32 characters.");
  const payload = encode(JSON.stringify({ email: email.toLowerCase(), exp: Date.now() + SESSION_SECONDS * 1000 } satisfies SessionPayload));
  return `${payload}.${await signature(payload, secret)}`;
}

export async function adminSessionCookie(email: string, secure: boolean) {
  const value = await createAdminSession(email);
  return `${COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; HttpOnly;${secure ? " Secure;" : ""} SameSite=Strict; Max-Age=${SESSION_SECONDS}`;
}

export function clearAdminSessionCookie(secure: boolean) {
  return `${COOKIE_NAME}=; Path=/; HttpOnly;${secure ? " Secure;" : ""} SameSite=Strict; Max-Age=0`;
}

export async function adminEmailFromRequest(request: Request) {
  const injectedEmail = request.headers.get("oai-authenticated-user-email")?.toLowerCase();
  if (injectedEmail && adminEmails().includes(injectedEmail)) return injectedEmail;
  const secret = sessionSecret();
  const value = cookieValue(request);
  if (!secret || !value) return null;
  try {
    const [payload, suppliedSignature] = value.split(".");
    if (!payload || !suppliedSignature || !await equalSecret(await signature(payload, secret), suppliedSignature)) return null;
    const session = JSON.parse(decode(payload)) as SessionPayload;
    if (!adminEmails().includes(session.email) || session.exp <= Date.now()) return null;
    return session.email;
  } catch {
    return null;
  }
}

export async function validateAdminCredentials(email: string, password: string) {
  if (!adminEmails().includes(email.toLowerCase())) return false;
  return verifyAdminPassword(email, password);
}
