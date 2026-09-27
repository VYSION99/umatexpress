/**
 * Sailup is the outbound SMS provider: one Ghanaian REST API covering MTN,
 * Telecel and AirtelTigo, billed per 160-character segment, so the platform
 * needs no per-network contract and no second balance to keep funded.
 *
 * This mirrors `lib/resend.ts` on purpose. The request builder is pure, so the
 * headers and body are asserted in tests without a key or a network call, and a
 * delivery failure is returned rather than thrown — an SMS is a comfort layer
 * for the same reason mail is: a driver action is never undone because a handset
 * was off.
 */

export type SailupConfig = { apiKey?: string; senderId?: string; baseUrl?: string };

export type SmsRequest = { url: string; headers: Record<string, string>; body: string };

/** Overridable, so a test or a staging project can point at its own endpoint. */
export const SAILUP_ENDPOINT = "https://api.sailup.io/v1/sms/";

/**
 * A key alone sends nothing. Sailup delivers from a sender ID registered in the
 * dashboard, and a message sent from an unregistered one is rejected.
 */
export function sailupReady(config: SailupConfig) {
  return Boolean(String(config.apiKey || "").trim() && String(config.senderId || "").trim());
}

/**
 * The number a Ghanaian handset is known by, in the one form Sailup accepts.
 *
 * `0201234567`, `233201234567` and `+233201234567` are the same phone, and all
 * three are stored around the platform, so they are folded to `+233201234567`
 * here. Anything that is not a Ghanaian mobile returns "", which is what keeps
 * an email address or a half-typed number out of a paid send.
 */
export function normalizeGhanaPhone(value: unknown) {
  const raw = String(value ?? "").trim();
  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  const local = digits.startsWith("233")
    ? digits.slice(3)
    : digits.startsWith("0")
      ? digits.slice(1)
      : digits;
  return /^[2-9]\d{8}$/.test(local) ? `+233${local}` : "";
}

/** True for a value that can be handed to Sailup as a recipient. */
export function looksLikePhone(value: unknown) {
  return normalizeGhanaPhone(value) !== "";
}

/**
 * What Sailup bills: a message past 160 characters is another segment, and
 * another two pesewas. Exposed so a caller can see the cost of what it queues
 * before it queues it.
 */
export function smsSegments(text: string) {
  const length = String(text || "").length;
  return length === 0 ? 0 : Math.ceil(length / 160);
}

export function buildSmsRequest(input: { config: SailupConfig; to: string; text: string }): SmsRequest {
  return {
    url: String(input.config.baseUrl || "").trim() || SAILUP_ENDPOINT,
    headers: { "content-type": "application/json", authorization: `Bearer ${String(input.config.apiKey || "").trim()}` },
    body: JSON.stringify({
      from: String(input.config.senderId || "").trim(),
      to: [normalizeGhanaPhone(input.to) || String(input.to || "").trim()],
      body: String(input.text || ""),
    }),
  };
}

/**
 * Sends one message. Sailup answers 202 with the queued message, so anything in
 * the 2xx range is a delivery handoff and the id it returns is what a delivery
 * webhook later refers to. A failure comes back as a value: every caller treats
 * SMS as a comfort layer, never as a step that can fail a booking.
 */
export async function sendSms(input: { config: SailupConfig; to: string; text: string }): Promise<{ ok: boolean; id?: string; segments?: number; error?: string }> {
  const request = buildSmsRequest(input);
  const response = await fetch(request.url, { method: "POST", headers: request.headers, body: request.body });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    return { ok: false, error: `Sailup HTTP ${response.status}${detail ? `: ${detail.slice(0, 160)}` : ""}` };
  }
  const data = await response.json().catch(() => null) as { id?: unknown; quantity?: unknown } | null;
  return { ok: true, id: String(data?.id || ""), segments: Number(data?.quantity || 0) || smsSegments(input.text) };
}
