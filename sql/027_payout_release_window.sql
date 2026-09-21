-- Re-anchor open trip payouts onto the shorter release window.
--
-- The ledger was previously written under `release_after = paid + 24 hours`.
-- That window is now a console setting — `organizer_payout_release_minutes`,
-- twenty by default and 0 for as-soon-as-settled — so every entry still open is
-- re-anchored here onto the expression the engine computes today:
-- `COALESCE(bookings.confirmed_at, payments.completed_at, payments.created_at,
-- bookings.created_at) + the window`.
--
-- Only ACCRUED rows move, and only those nobody has claimed (`batch_id` empty).
-- PROCESSING, RELEASED, REVERSED and FAILED rows are history: a transfer that
-- already left must not read as if it were released under a rule it never saw.
--
-- EDIT THE INTERVAL BELOW to match the setting before running this, otherwise
-- open entries are re-anchored to a window the console does not show.
--
-- The statement compares before it writes, so re-running it matches nothing. A
-- row whose anchor cannot be read keeps what it has (the subquery yields NULL
-- and the comparison is never true), which can only make a payout later, never
-- earlier. Running this is optional: entries written from now on use the new
-- window by themselves.

UPDATE organizer_payouts AS po
   SET release_after = (
       SELECT strftime('%Y-%m-%dT%H:%M:%fZ',
                       COALESCE(b.confirmed_at, p.completed_at, p.created_at, b.created_at),
                       '+20 minutes')
         FROM bookings b
         LEFT JOIN payments p ON p.booking_id = b.id AND p.status = 'SUCCESSFUL'
        WHERE b.id = po.booking_id
   )
 WHERE po.status = 'ACCRUED'
   AND COALESCE(po.batch_id, '') = ''
   AND po.release_after <> (
       SELECT strftime('%Y-%m-%dT%H:%M:%fZ',
                       COALESCE(b.confirmed_at, p.completed_at, p.created_at, b.created_at),
                       '+20 minutes')
         FROM bookings b
         LEFT JOIN payments p ON p.booking_id = b.id AND p.status = 'SUCCESSFUL'
        WHERE b.id = po.booking_id
   );
