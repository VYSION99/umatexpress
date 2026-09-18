import { CampusEngineError } from "@/lib/campus-engine/errors";
import { envValue } from "@/lib/runtime-env";

/**
 * Reversible encryption for the few values the platform must be able to read
 * back, such as an organizer's payout account number. A hash is not enough
 * there: a payout has to be addressed to the real number.
 *
 * The key comes from `PAYOUT_ENCRYPTION_KEY`, falling back to the admin session
 * secret so an existing deployment keeps working. Rotating either value makes
 * previously sealed values unreadable, so a dedicated key should be set before
 * real payouts run.
 *
 * Every sealed value carries a `v1:` marker. That is what makes encryption a
 * property of the column rather than of the writer: a stored value without the
 * marker is visibly not sealed, instead of quietly sitting in plain text.
 */
const SEALED_PREFIX = "v1:";

async function boxKey() {
  const raw = await envValue("PAYOUT_ENCRYPTION_KEY", ["ADMIN_SESSION_SECRET"]);
  if (!raw || raw.length < 32 || raw.startsWith("replace-with")) {
    throw new CampusEngineError("CONFIG_REQUIRED", "Set PAYOUT_ENCRYPTION_KEY before storing payout details.", 503);
  }
  // The secret is text of any length; AES needs a fixed-size key, so it is
  // hashed rather than truncated.
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

export function isSealed(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(SEALED_PREFIX);
}

export async function sealSecret(plain: string) {
  const trimmed = String(plain || "").trim();
  if (!trimmed) return "";
  const key = await boxKey();
  // A fresh IV per value: reusing one with AES-GCM is what breaks it.
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(trimmed));
  const combined = new Uint8Array(iv.length + sealed.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(sealed), iv.length);
  return `${SEALED_PREFIX}${toBase64(combined)}`;
}

/** Returns null rather than throwing, so one unreadable row cannot break a page. */
export async function openSecret(value: unknown): Promise<string | null> {
  if (!isSealed(value)) return null;
  try {
    const combined = fromBase64(value.slice(SEALED_PREFIX.length));
    const iv = combined.slice(0, 12);
    const body = combined.slice(12);
    const key = await boxKey();
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, body);
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

/** `••••1234` — enough to recognise an account without exposing it. */
export function maskAccountNumber(last4: string) {
  const digits = String(last4 || "").trim();
  return digits ? `••••${digits}` : "";
}

export function lastFour(value: string) {
  const cleaned = String(value || "").replace(/\s+/g, "");
  return cleaned.slice(-4);
}
