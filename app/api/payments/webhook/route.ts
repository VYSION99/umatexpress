import { after } from "next/server";
import { verifyPaystackWebhookSignature } from "@/lib/paystack";
import { actionablePaystackEvent, type PaystackWebhook } from "@/lib/payments/paystack-events";
import { receivePaymentEvent, processPaymentInboxEvent } from "@/lib/payments/inbox";
import { requestIdFromRequest, withRequestId, logEvent } from "@/lib/observability";

export async function POST(request: Request) {
  const requestId = requestIdFromRequest(request);
  const respond = (body: unknown, status = 200) => withRequestId(Response.json(body, {
    status, headers: { "Cache-Control": "no-store" },
  }), requestId);
  const rawBody = await request.text();
  try {
    if (!await verifyPaystackWebhookSignature(rawBody, request.headers.get("x-paystack-signature"))) {
      return respond({ error: "Invalid Paystack signature." }, 401);
    }
  } catch {
    return respond({ error: "Webhook verification is unavailable." }, 503);
  }
  let event: PaystackWebhook;
  try {
    const parsed = JSON.parse(rawBody);
    if (!parsed || typeof parsed !== "object" || !parsed.data || typeof parsed.data !== "object") throw new Error();
    event = parsed;
  } catch {
    return respond({ error: "Invalid webhook payload." }, 400);
  }
  if (!actionablePaystackEvent(event)) return respond({ message: "Event is not actionable." });
  if (!String(event.data?.reference || "").trim()) return respond({ error: "Missing payment reference." }, 400);
  let id: string;
  try {
    id = await receivePaymentEvent(event);
  } catch {
    return respond({ error: "Webhook could not be persisted." }, 503);
  }
  // Paystack needs a quick acknowledgement. The event is durable before this
  // point; platform waitUntil keeps the fast path alive after the response and
  // the scheduled inbox sweep remains the recovery authority.
  const processRecordedEvent = async () => {
    try {
      await processPaymentInboxEvent(id);
    } catch {
      logEvent("error", "payment_inbox_deferred", { requestId, id });
    }
  };
  try {
    after(processRecordedEvent);
  } catch {
    // Direct route tests and a plain Node development server do not provide a
    // request lifecycle. Production Workers use `after`/waitUntil; locally the
    // durable inbox still makes this best-effort microtask safe.
    void Promise.resolve().then(processRecordedEvent);
  }
  return respond({ accepted: true, message: "Event recorded." });
}
