-- One-off for the trip payout release rule.
--
-- The ledger was first written under `release_after = max(next 12:00 AM,
-- departure + 24h)`. That rule is gone: an entry now becomes payable 24 hours
-- after the booking was paid, so every open row is re-anchored here onto the
-- same expression the engine computes (bookings.confirmed_at, then
-- payments.completed_at, then payments.created_at, then bookings.created_at).
--
-- Only ACCRUED rows move. PROCESSING, RELEASED, REVERSED and FAILED rows are
-- history: a transfer that already left must not read as if it were released
-- under a rule it never saw.
--
-- The statement compares before it writes, so re-running it matches nothing.
-- A row whose anchor cannot be read keeps what it has (the subquery yields
-- NULL and the comparison is never true), which can only make a payout later,
-- never earlier.

UPDATE organizer_payouts AS po
   SET release_after = (
       SELECT strftime('%Y-%m-%dT%H:%M:%fZ',
                       COALESCE(b.confirmed_at, p.completed_at, p.created_at, b.created_at),
                       '+24 hours')
         FROM bookings b
         LEFT JOIN payments p ON p.booking_id = b.id AND p.status = 'SUCCESSFUL'
        WHERE b.id = po.booking_id
   )
 WHERE po.status = 'ACCRUED'
   AND po.release_after <> (
       SELECT strftime('%Y-%m-%dT%H:%M:%fZ',
                       COALESCE(b.confirmed_at, p.completed_at, p.created_at, b.created_at),
                       '+24 hours')
         FROM bookings b
         LEFT JOIN payments p ON p.booking_id = b.id AND p.status = 'SUCCESSFUL'
        WHERE b.id = po.booking_id
   );
