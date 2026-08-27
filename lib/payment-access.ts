const COOKIE_PREFIX = "umx_payment_access_";

export async function hashPaymentToken(token: string) {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
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
