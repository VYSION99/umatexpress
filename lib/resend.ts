/**
 * Resend is the only outbound mail provider: one API key and one verified
 * sender address are enough for every message the platform sends, so there is
 * no provider switch to configure and no second code path to keep working.
 *
 * Nothing here decides *what* to send — it builds the exact request and can send
 * it. The request builder is pure, so the headers and body can be asserted in
 * tests without credentials or network access.
 */

export type ResendConfig = { apiKey?: string; from?: string; replyTo?: string };

export type EmailRequest = { url: string; headers: Record<string, string>; body: string };

export const RESEND_ENDPOINT = "https://api.resend.com/emails";

/** Resend needs a key and a verified sender before anything can be delivered. */
export function resendReady(config: ResendConfig) {
  return Boolean(String(config.apiKey || "").trim() && String(config.from || "").trim());
}

/** True for a value that can be handed to Resend as a recipient. */
export function looksLikeEmail(value: string) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(value || "").trim());
}

export function buildEmailRequest(input: { config: ResendConfig; to: string; subject: string; text: string }): EmailRequest {
  return {
    url: RESEND_ENDPOINT,
    headers: { "content-type": "application/json", authorization: `Bearer ${String(input.config.apiKey || "").trim()}` },
    body: JSON.stringify({
      from: String(input.config.from || "").trim(),
      to: [String(input.to || "").trim()],
      subject: input.subject,
      text: input.text,
      ...(String(input.config.replyTo || "").trim() ? { reply_to: String(input.config.replyTo).trim() } : {}),
    }),
  };
}

/**
 * Sends one email. A delivery failure is returned rather than thrown, because
 * every caller treats mail as a comfort layer: a booking or a driver action is
 * never undone because a mailbox bounced.
 */
export async function sendEmail(input: { config: ResendConfig; to: string; subject: string; text: string }): Promise<{ ok: boolean; id?: string; error?: string }> {
  const request = buildEmailRequest(input);
  const response = await fetch(request.url, { method: "POST", headers: request.headers, body: request.body });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    return { ok: false, error: `Resend HTTP ${response.status}${detail ? `: ${detail.slice(0, 160)}` : ""}` };
  }
  const data = await response.json().catch(() => null) as { id?: unknown } | null;
  return { ok: true, id: String(data?.id || "") };
}
