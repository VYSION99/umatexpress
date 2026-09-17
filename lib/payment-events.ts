import { ensurePaymentEventsTable, turso } from "@/lib/turso";

/**
 * Records a provider webhook event exactly once.
 *
 * Returns true when this is the first time the event has been seen, and false
 * for a duplicate delivery, which callers should acknowledge and ignore.
 */
export async function claimPaymentEvent(provider: string, eventId: string, reference: string) {
  if (!eventId) return true;
  await ensurePaymentEventsTable();
  const result = await turso(
    "INSERT INTO payment_events (provider,event_id,reference,received_at) VALUES (?,?,?,?) ON CONFLICT(provider,event_id) DO NOTHING",
    [provider, eventId, reference, new Date().toISOString()],
  );
  return Number(result.affected_row_count || 0) === 1;
}

/**
 * Removes a claimed event so a provider retry can process it again. Call this
 * only when the event was recorded but processing it failed.
 */
export async function releasePaymentEvent(provider: string, eventId: string) {
  if (!eventId) return;
  await turso("DELETE FROM payment_events WHERE provider = ? AND event_id = ?", [provider, eventId]);
}
