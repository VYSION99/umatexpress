import { isTursoConfiguredRuntime, rowsToObjects, turso } from "@/lib/turso";
import { processPaystackEvent, type PaystackWebhook } from "@/lib/payments/paystack-events";
import { logEvent } from "@/lib/observability";

export const PAYMENT_INBOX_SCHEMA = `CREATE TABLE IF NOT EXISTS payment_inbox (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  event_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  reference TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PROCESSING','PROCESSED','REVIEW')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  lease_token TEXT,
  lease_until TEXT,
  last_error TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  UNIQUE(provider, event_type, resource_id)
)`;

async function ensureInbox() {
  await turso(PAYMENT_INBOX_SCHEMA);
  await turso("CREATE INDEX IF NOT EXISTS idx_payment_inbox_due ON payment_inbox(status, available_at, lease_until)");
}

export function paymentEventIdentity(event: PaystackWebhook) {
  const reference = String(event.data?.reference || "").trim();
  const resource = String(event.data?.id || event.data?.transfer_code || reference);
  if (!event.event || !resource || !reference) throw new Error("Incomplete payment event identity.");
  return { id: `PAYSTACK:${event.event}:${resource}`, resource, reference };
}

export async function receivePaymentEvent(event: PaystackWebhook) {
  await ensureInbox();
  const { id, resource, reference } = paymentEventIdentity(event);
  const data = event.data!;
  // Persist only fields used by settlement, never the full provider payload
  // (which can include customer and card authorization information).
  const payload = JSON.stringify({ event: event.event, data: {
    id: data.id, reference, amount: data.amount, currency: data.currency,
    status: data.status, fees: data.fees, transfer_code: data.transfer_code,
    gateway_response: data.gateway_response, reason: data.reason,
  } });
  const now = new Date().toISOString();
  await turso(`INSERT INTO payment_inbox
    (id,provider,event_type,resource_id,reference,payload,available_at,received_at)
    VALUES (?,'PAYSTACK',?,?,?,?,?,?) ON CONFLICT(provider,event_type,resource_id) DO NOTHING`,
  [id, event.event!, resource, reference, payload, now, now]);
  return id;
}

export async function processPaymentInboxEvent(id: string) {
  const now = new Date().toISOString();
  const token = crypto.randomUUID();
  const leaseUntil = new Date(Date.now() + 5 * 60_000).toISOString();
  const row = rowsToObjects(await turso(`UPDATE payment_inbox
    SET status='PROCESSING', lease_token=?, lease_until=?, attempts=attempts+1
    WHERE id=? AND ((status='PENDING' AND available_at<=?) OR (status='PROCESSING' AND lease_until<=?))
    RETURNING payload, attempts`, [token, leaseUntil, id, now, now]))[0];
  if (!row) return null;
  try {
    const result = await processPaystackEvent(JSON.parse(String(row.payload)) as PaystackWebhook);
    if (!result.handled) throw new Error("PAYMENT_REFERENCE_NOT_FOUND");
    await turso(`UPDATE payment_inbox SET status='PROCESSED', processed_at=?, lease_token=NULL,
      lease_until=NULL, last_error=NULL WHERE id=? AND lease_token=?`, [new Date().toISOString(), id, token]);
    return result;
  } catch (error) {
    const attempts = Number(row.attempts);
    const status = attempts >= 12 ? "REVIEW" : "PENDING";
    const available = new Date(Date.now() + Math.min(3600, 30 * 2 ** Math.min(attempts, 7)) * 1000).toISOString();
    // Errors from downstream services may contain sensitive details. Store a
    // stable operational code; the payload/reference supplies the audit link.
    const reason = error instanceof Error && error.message === "PAYMENT_REFERENCE_NOT_FOUND"
      ? "PAYMENT_REFERENCE_NOT_FOUND" : "PROCESSING_FAILED";
    await turso(`UPDATE payment_inbox SET status=?, available_at=?, last_error=?, lease_token=NULL,
      lease_until=NULL WHERE id=? AND lease_token=?`, [status, available, reason, id, token]);
    logEvent("error", "payment_inbox_retry", { id, attempts, status, reason });
    throw error;
  }
}

export async function drainPaymentInbox(limit = 2) {
  if (!await isTursoConfiguredRuntime()) return { processed: 0, failed: 0 };
  await ensureInbox();
  const now = new Date().toISOString();
  const rows = rowsToObjects(await turso(`SELECT id FROM payment_inbox
    WHERE (status='PENDING' AND available_at<=?) OR (status='PROCESSING' AND lease_until<=?)
    ORDER BY received_at LIMIT ?`, [now, now, Math.max(1, Math.min(10, limit))]));
  let processed = 0;
  let failed = 0;
  for (const row of rows) {
    try { if (await processPaymentInboxEvent(String(row.id))) processed++; }
    catch { failed++; }
  }
  return { processed, failed };
}
