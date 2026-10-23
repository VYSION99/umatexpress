# Food M4 — Guarded payments and settlement

**Status:** Implemented behind default-off global and provider gates
**Implemented:** 20 October 2026

M4 adds online checkout after vendor acceptance, exact payment verification, full pre-cutoff cancellation refunds, vendor earnings, release timing and administrator reconciliation. It does not enable payments automatically, send vendor payouts automatically, introduce delivery or publish Food on the homepage.

Two independent switches protect real collection: the administrator-controlled `food_payments_enabled` platform setting and the selected provider's payment profile. Both default off. Turning either off prevents new checkout without deleting pending payments, refunds, earnings or audit evidence.

## Order and money flow

1. The student sends a pickup request and the vendor accepts it.
2. When both money gates are on, the student sees Pay securely. The server snapshots the food subtotal, processing fee, commission and vendor net in integer pesewas.
3. Paystack webhook and verification paths call the same settlement function. An amount or currency mismatch moves the payment to review and never marks it paid.
4. A payment-enrolled order cannot be marked ready until payment succeeds.
5. Collection creates one vendor earning. It remains pending until the configured release delay passes, then becomes available.
6. An administrator records the external vendor payout reference. M4 does not silently send vendor money.

The release delay and commission are frozen when checkout starts. Each recorded external payout reference can belong to only one earning; staff must record separate transfer references for separate earnings. A provider response with a different refund amount or currency is held for manual review.

## Cancellation and refunds

The existing cancellation cutoff remains authoritative. If no successful online payment exists, cancellation creates no refund. If payment succeeded, M4 records a refund for the full amount collected, including the processing fee. An administrator reviews and sends it through Paystack. Approval, provider processing and paid settlement are separate states.

The immutable finance projection reverses Food fee recovery, commission and vendor liability only when the refund is paid. Students must not be told money has returned while a refund is merely requested or approved.

## Production acceptance checklist

- Keep the global gate off while testing schema and authorization.
- Enroll one verified provider with an agreed commission and release delay.
- Run an accepted order through payment and verify exact amount and currency.
- Confirm an unpaid enrolled order cannot be marked ready.
- Cancel a paid order before cutoff and complete the refund webhook path.
- Confirm collection creates one earning and repeated actions cannot duplicate it.
- Reconcile payment, refund and vendor payout references against Paystack.
- Check the payment provider's webhook delivery and finance reconciliation queue before any live pilot.
- Enable the global gate only during staffed pilot hours.

Migration: `sql/042_food_payments.sql`
