import { constantTimeEqual } from "@/lib/campus-engine/crypto";

const COOKIE_PREFIX = "umx_payment_access_";

// The cookie is the guest's key and expires after an hour; a signed-in
// passenger's own account email is the durable fallback on the verify routes.
export async function hashPaymentToken(token: string) {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Compares a presented token against a stored hash without leaking where the
 * first difference is. The digests are fixed-length hex, so the byte compare is
 * itself constant-time and a wrong token never short-circuits.
 */
export async function verifyPaymentToken(token: string | null, storedHash: unknown) {
  const hash = String(storedHash || "");
  if (!token || !hash) return false;
  const actual = await hashPaymentToken(token);
  return constantTimeEqual(new TextEncoder().encode(actual), new TextEncoder().encode(hash));
}

export function paymentAccessCookie(reference: string, token: string, secure = true) {
  const value = encodeURIComponent(token);
  return `${COOKIE_PREFIX}${reference}=${value}; Path=/; HttpOnly;${secure ? " Secure;" : ""} SameSite=Strict; Max-Age=3600`;
}

export function paymentTokenFromRequest(request: Request, reference: string) {
  const cookie = request.headers.get("cookie") || "";
  const cookieName = `${COOKIE_PREFIX}${reference}=`;
  const raw = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(cookieName));
  if (!raw) return null;
  let value: string;
  try { value = decodeURIComponent(raw.slice(cookieName.length)); } catch { return null; }
  return value || null;
}
