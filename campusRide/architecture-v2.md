# campusRide architecture v2 — robust queue, payments, and access

This document describes a robustness-focused redesign of the campusRide
lifecycle. It keeps the current stack (Next/vinext on Cloudflare Workers,
Turso/libSQL over the HTTP pipeline, Paystack) and replaces the racy
read-then-write paths with database-enforced invariants.

The guiding rule:

> The database owns the invariants. Application code only *requests*
> transitions, and every mutation is a single conditional statement whose
> `affected_row_count` is checked.

## 1. Problems this fixes

| Symptom in the current code | Root cause |
| --- | --- |
| Two riders can be assigned the same queue position; payment webhook throws a unique-index error after the rider is charged. | `COUNT(*) + 1` positions (`lib/campus-engine/rides.ts`) plus a partial unique index that excludes the pre-payment status. |
| A ride can be overbooked under concurrent joins. | Capacity checked by count, then decremented on payment, in separate statements. |
| Abandoned checkouts leak capacity forever. | No hold expiry for `WAITING_PAYMENT` entries. |
| Verified payment can report `paid: true` while flagged for review. | Caller keeps a stale local `status` after the mark call downgrades it. |
| Driver can read the passenger boarding PIN. | `mapQueueEntry` returns `ride_pin` to the driver feed. |
| Admin fare edits to seeded trips revert. | `getDynamicTrips` re-seeds and overwrites `price` on every read. |
| Admin auth bypass on a plain Cloudflare deploy. | `oai-authenticated-user-email` header trusted before cookies. |

## 2. Data model

### `campus_rides` (capacity + ordering counters)

```sql
ALTER TABLE campus_rides ADD COLUMN next_queue_position INTEGER NOT NULL DEFAULT 1;
```

`next_queue_position` is a monotonic counter. It never decreases, so a
position is never reused, even after a cancellation. There is no
`seats_held` column: `available_slots` *is* the hold counter and is
decremented at claim time, not at payment time.

### `campus_queue_entries` (the reservation)

```sql
ALTER TABLE campus_queue_entries ADD COLUMN expires_at TEXT;
CREATE INDEX IF NOT EXISTS idx_campus_queue_expiry
ON campus_queue_entries(queue_status, expires_at);
```

Lifecycle: `WAITING_PAYMENT` (holds a slot, expires) → `PAID_WAITING` →
`ACCEPTED_BY_DRIVER` → `DRIVER_ARRIVED` → `BOARDED` → `COMPLETED`, with
terminal `EXPIRED`, `PAYMENT_FAILED`, `PAYMENT_RECEIVED_REVIEW`,
`NO_SHOW`, `CANCELLED_BY_DRIVER`.

### `campus_payments`

Unchanged key: one row per attempt, unique `reference`, `status` guarded
on every write.

### `payment_events` (new, idempotency)

```sql
CREATE TABLE IF NOT EXISTS payment_events (
  provider    TEXT NOT NULL,
  event_id    TEXT NOT NULL,
  reference   TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (provider, event_id)
);
```

Insert-first. A duplicate event is acknowledged and ignored.

## 3. Invariant SQL

All of these live in `lib/campus-engine/queue.ts` and are unit-tested
against a real SQLite engine.

### Claim a slot and a position (atomic)

```sql
UPDATE campus_rides
SET available_slots        = available_slots - 1,
    next_queue_position    = next_queue_position + 1,
    status                 = CASE WHEN available_slots - 1 <= 0 THEN 'FULL' ELSE status END,
    accepting_queue        = CASE WHEN available_slots - 1 <= 0 THEN 0 ELSE accepting_queue END,
    updated_at             = ?
WHERE id = ?
  AND status = 'OPEN'
  AND accepting_queue = 1
  AND available_slots > 0
RETURNING next_queue_position - 1 AS position;
```

Zero rows means full or closed. `position` comes from the same statement,
so concurrent claims can never collide.

### Release a held slot

```sql
UPDATE campus_rides
SET available_slots  = CASE WHEN available_slots + ? < capacity THEN available_slots + ? ELSE capacity END,
    status           = CASE WHEN status = 'FULL' THEN 'OPEN' ELSE status END,
    accepting_queue  = CASE WHEN status = 'FULL' THEN 1 ELSE accepting_queue END,
    updated_at       = ?
WHERE id = ?;
```

### Guarded state transition

```sql
UPDATE campus_queue_entries
SET queue_status = ?, <timestamp_column> = ?, updated_at = ?
WHERE id = ? AND queue_status = ?;
```

The `WHERE ... AND queue_status = ?` guard is what prevents double
boarding, double release, and out-of-order transitions under load. The
timestamp column is validated against a fixed allowlist before it is
interpolated.

### Expire stale holds

```sql
UPDATE campus_queue_entries
SET queue_status = 'EXPIRED', updated_at = ?
WHERE ride_id = ?
  AND queue_status = 'WAITING_PAYMENT'
  AND expires_at IS NOT NULL AND expires_at <> ''
  AND expires_at < ?;
```

The `affected_row_count` of this statement is the exact number of slots
to return, so the release can never over- or under-count.

## 4. Payment pipeline

1. Webhook verifies the Paystack HMAC signature.
2. `INSERT INTO payment_events ... ON CONFLICT DO NOTHING`. If the row
   already existed, ack `200` and stop.
3. Apply the effect with guarded updates and check `affected_row_count`:
   - success → transition `WAITING_PAYMENT` → `PAID_WAITING`. No capacity
     change (already held at claim time).
   - hold expired → `PAID_REVIEW` for manual resolution.
   - failure → transition `WAITING_PAYMENT` → `PAYMENT_FAILED` and release
     exactly one slot.
4. `/payments/verify` calls the *same* function; it never re-implements
   the logic, and it returns the effective status (never a stale local one).

A scheduled reconciliation job re-verifies `PENDING` payments older than a
few minutes and sweeps expired holds.

## 5. Access

- Cookie-only sessions. The `oai-authenticated-user-email` header is only
  trusted when a platform signature proves the request came through the
  hosting proxy.
- `token_version` on each principal, embedded in the signed payload and
  bumped on password change/reset, so old cookies die immediately.
- Constant-time comparison everywhere, including the driver session
  signature.
- Driver feeds never include `ride_pin`.

## 6. Rate limiting

Durable limiting via the Cloudflare rate-limiting binding or a Durable
Object per `scope:key`, with a Turso-backed fallback. Failed-attempt
counters and lockout for login and PIN verification.

## 7. Observability

- Request id per request, included in logs and audit rows.
- Counters: queue depth, claim failures, payment success/fail rate,
  webhook duplicates, stale holds swept.
- Explicit degradation: money paths fail closed on DB/provider errors;
  browsing degrades to read-only.

## 8. Testing strategy

The invariant SQL is exercised against a real SQLite engine
(`node:sqlite`) in `tests/queue-integrity.test.mjs`:

- claims never exceed capacity, and positions are unique and monotonic;
- a cancelled position is never reused;
- expired holds release exactly once;
- guarded transitions apply once;
- payment failure releases the slot exactly once.

These tests would have caught the queue-collision, overbooking, and
double-release bugs that mocks cannot see.

## 9. Rollout

1. **Queue integrity — done.** `sql/000_umatexpress_full_migration.sql` (was `sql/011`), atomic claim/release in
   `lib/campus-engine/queue.ts`, hold expiry, guarded transitions,
   invariant tests in `tests/queue-integrity.test.mjs`.
2. **Payment idempotency — done.** `sql/000` (was `sql/012`) and `lib/payment-events.ts`
   record each provider event once; the webhook acknowledges replays and
   releases the claim if processing fails. `lib/campus-engine/reconcile.ts`
   re-verifies stale PENDING payments and sweeps expired holds, exposed at
   `POST/GET /api/admin/campus/reconcile` for a scheduler to call.
3. **Access — done.** `sql/000` (was `sql/013`), identity header is opt-in
   (`TRUST_PLATFORM_IDENTITY`), `token_version`/`session_epoch` rotate on
   password change with the cookie reissued, constant-time driver signature
   compare, and login/PIN lockouts via `lib/auth-guard.ts`.
4. **Durable rate limiting — done.** `lib/rate-limit.ts` consumes an atomic
   fixed window in Turso (`consumeRateLimitWindow`), shared across Worker
   isolates, with an in-memory fallback for local preview.
5. **Observability and degradation — done.** `lib/observability.ts` adds a
   request id (`x-request-id`/`cf-ray`, else generated) propagated onto
   responses and into `campus_audit_logs.details`, single-line JSON events,
   and per-day counters (`metrics_counters`) for queue claims/failures,
   expired-hold sweeps, payment outcomes, and webhook duplicates/failures.
   Admin reporting is at `GET/POST /api/admin/campus/metrics?day=YYYY-MM-DD`.
   Money paths (`/api/payments/*`, `/api/campus/queue/*`) now fail closed
   with `503` when Turso or the provider is unavailable instead of returning
   a partial/preview state; browsing endpoints remain read-only.

### Reconciliation scheduling

A Cloudflare Cron Trigger runs every 5 minutes (`triggers.crons` in
`vite.config.ts`). The worker entry (`worker/index.ts`) exports a `scheduled`
handler that calls `runCampusReconcile` (`lib/campus-engine/reconcile-job.ts`),
which re-verifies stale PENDING payments against Paystack and sweeps expired
holds. The job never throws and is safe to overlap, because every effect goes
through the same idempotent mark functions as the webhook.

`/api/admin/campus/reconcile` stays admin-authenticated and idempotent, so an
operator or an external scheduler can also trigger the same sweep on demand.
