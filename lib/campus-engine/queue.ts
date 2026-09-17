export type SqlValue = string | number;

export type SqlResult = {
  rows?: unknown[];
  cols?: Array<{ name: string }>;
  affected_row_count?: number;
};

export type SqlExecutor = (sql: string, values?: SqlValue[]) => Promise<SqlResult>;

export const CAMPUS_HOLD_MINUTES = 10;

const QUEUE_TIME_COLUMNS = new Set(["accepted_at", "arrived_at", "boarded_at", "completed_at", "cancelled_at"]);

function records(result: SqlResult | undefined) {
  const columns = result?.cols?.map((column) => column.name) ?? [];
  return (result?.rows ?? []).map((row) => {
    const values = Array.isArray(row) ? row : [];
    return Object.fromEntries(columns.map((column, index) => [column, (values[index] as { value?: unknown })?.value ?? values[index]]));
  });
}

function firstRecord(result: SqlResult | undefined) {
  return records(result)[0] || null;
}

function changed(result: SqlResult | undefined) {
  const count = Number(result?.affected_row_count);
  if (Number.isFinite(count)) return count;
  return result?.rows?.length ?? 0;
}

export function campusHoldExpiry(now = Date.now()) {
  return new Date(now + CAMPUS_HOLD_MINUTES * 60_000).toISOString();
}

export type ClaimResult = { ok: true; position: number } | { ok: false; reason: "FULL" | "CLOSED" };

/**
 * Atomically reserves one slot on a ride and returns a monotonic queue
 * position. This is the only place capacity may be consumed.
 */
export async function claimCampusQueueSlot(exec: SqlExecutor, input: { rideId: string; nowIso: string }): Promise<ClaimResult> {
  const result = await exec(
    `UPDATE campus_rides
     SET available_slots = available_slots - 1,
         next_queue_position = next_queue_position + 1,
         status = CASE WHEN available_slots - 1 <= 0 THEN 'FULL' ELSE status END,
         accepting_queue = CASE WHEN available_slots - 1 <= 0 THEN 0 ELSE accepting_queue END,
         updated_at = ?
     WHERE id = ?
       AND status = 'OPEN'
       AND accepting_queue = 1
       AND available_slots > 0
     RETURNING next_queue_position - 1 AS position`,
    [input.nowIso, input.rideId],
  );
  const row = firstRecord(result);
  if (!row) {
    // A claim that wrote a row but returned none means the engine ignored
    // RETURNING; fail loudly rather than reporting a false "ride is full".
    if (changed(result) > 0) throw new Error("CampusRide queue claim wrote a row but returned no position.");
    const state = firstRecord(await exec("SELECT status, accepting_queue, available_slots FROM campus_rides WHERE id = ? LIMIT 1", [input.rideId]));
    if (state && (String(state.status) === "FULL" || Number(state.available_slots) <= 0)) return { ok: false, reason: "FULL" };
    return { ok: false, reason: "CLOSED" };
  }
  return { ok: true, position: Number(row.position) };
}

/** Returns held slots to a ride. `count` must come from an atomic update. */
export async function releaseCampusSlots(exec: SqlExecutor, input: { rideId: string; count: number; nowIso: string }) {
  if (input.count <= 0) return 0;
  const result = await exec(
    `UPDATE campus_rides
     SET available_slots = CASE WHEN available_slots + ? < capacity THEN available_slots + ? ELSE capacity END,
         status = CASE WHEN status = 'FULL' THEN 'OPEN' ELSE status END,
         accepting_queue = CASE WHEN status = 'FULL' THEN 1 ELSE accepting_queue END,
         updated_at = ?
     WHERE id = ?`,
    [input.count, input.count, input.nowIso, input.rideId],
  );
  return changed(result);
}

/**
 * Expires stale unpaid holds and releases exactly the slots they were
 * holding. Returns the number of holds released.
 */
export async function releaseExpiredCampusHolds(exec: SqlExecutor, input: { rideId: string; nowIso: string }) {
  const expired = await exec(
    `UPDATE campus_queue_entries
     SET queue_status = 'EXPIRED', updated_at = ?
     WHERE ride_id = ?
       AND queue_status = 'WAITING_PAYMENT'
       AND expires_at IS NOT NULL AND expires_at <> ''
       AND expires_at < ?`,
    [input.nowIso, input.rideId, input.nowIso],
  );
  const released = changed(expired);
  if (released > 0) await releaseCampusSlots(exec, { rideId: input.rideId, count: released, nowIso: input.nowIso });
  return released;
}

/**
 * Guarded state transition. Returns false when the row was not in the
 * expected `from` state, which makes every caller idempotent.
 */
export async function applyCampusQueueTransition(exec: SqlExecutor, input: {
  entryId: string;
  from: string;
  to: string;
  timeColumn?: string;
  paymentStatus?: string;
  ticketReady?: boolean;
  nowIso: string;
}) {
  const assignments = ["queue_status = ?", "updated_at = ?"];
  const values: SqlValue[] = [input.to, input.nowIso];
  if (input.timeColumn) {
    if (!QUEUE_TIME_COLUMNS.has(input.timeColumn)) throw new Error(`Unsupported queue time column: ${input.timeColumn}`);
    assignments.push(`${input.timeColumn} = ?`);
    values.push(input.nowIso);
  }
  if (input.paymentStatus) {
    assignments.push("payment_status = ?");
    values.push(input.paymentStatus);
  }
  if (input.ticketReady) assignments.push("ticket_image_ready = 1");
  values.push(input.entryId, input.from);
  const result = await exec(
    `UPDATE campus_queue_entries SET ${assignments.join(", ")} WHERE id = ? AND queue_status = ?`,
    values,
  );
  return changed(result) === 1;
}

/** Reads the live status of a queue entry (used for review/audit decisions). */
export async function campusQueueEntryState(exec: SqlExecutor, entryId: string) {
  const row = firstRecord(await exec("SELECT id, ride_id, queue_status, payment_status FROM campus_queue_entries WHERE id = ? LIMIT 1", [entryId]));
  if (!row) return null;
  return { id: String(row.id), rideId: String(row.ride_id || ""), queueStatus: String(row.queue_status || ""), paymentStatus: String(row.payment_status || "") };
}
