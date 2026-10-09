# Payment architecture

Paystack is the only direct payment provider. Its hosted checkout accepts
supported cards and mobile-money channels. The platform does not call the MTN
Collection API. Mobile money remains an eligible payout destination through
Paystack. Virtual cards and wallets are future work.

## Payer-paid processing charge

Every Paystack checkout gross-ups the listed fare, rent plus utilities, or
hostel plugin catalogue price by the configured Ghana processing rate (1.95% by
default). The payer sees the base, processing amount and total before opening
Paystack. The backend recalculates the total from its own price data and sends
that frozen amount to Paystack; a payment with a different amount is held for
review. Vacation and campus fares, hostel commissions and landlord payouts are
calculated from the original service price, excluding the processing charge.
The finance journal records fee recovery separately from service revenue.

A full hostel refund may include the original processing amount under the
refund policy; the platform can absorb a provider fee that Paystack does not
return. The amount actually charged by Paystack can differ from the estimate if
merchant pricing changes, so reconcile verified transaction fees against the
configured rate. Keep any Paystack dashboard automatic fee pass-through off
when this application-level gross-up is in use, to avoid adding the fee twice.

## Money flow

Each student or landlord checkout has a payment intent tied to a product order.
An attempt has a provider reference, integer amount, currency and state.
Authenticated checkout requests use a scoped idempotency key, and a duplicate
request gets the original response without issuing a second provider call.
Concurrent requests with the same key are serialized by a database constraint.
The browser retains the key across network retries. Older clients use a hash of
the request payload scoped to their account.

Provider operations are recorded before calls to Paystack. Accepted calls
persist their result. A provider timeout or unknown response leaves the operation
UNKNOWN; it cannot be submitted again with the same reference. Reconciliation
verifies the original reference. Payout earnings and refunds stay reserved while
the outcome remains unknown. A definite provider rejection may release a
reservation. Paystack refund requests include a unique merchant note so a lost
response can be matched to exactly one provider refund.

Signed Paystack webhooks enter a durable inbox. Event identity includes the
lifecycle event type, so a transfer reversal is distinct from its success.
Conditional leases prevent concurrent processing. Expired leases, failed work
and unmatched references are retried; exhausted events enter REVIEW. The shared
dispatcher routes charge, transfer and refund events to existing product rules.
Vacation booking verification and webhooks call the same transactional settlement
function. Hostel settlement already uses conditional transactions, while campus
ride and other product flows retain their existing state handlers.

The accounting projection captures payment, booking, payout and refund source
changes through database triggers. Source mutation and financial outbox insertion
commit together. The projector writes integer, balanced, append-only journals
and keeps a snapshot of each source's current financial position. Accounts
separate provider clearing, customer funds, commission revenue, seller pending,
seller reserved, payout clearing and refunds reserved. Commission amounts come
from source snapshots. An invalid split enters REVIEW and stops later events
for that source. Legacy product ledgers remain the payout authority until an
opening-balance reconciliation signs off on the new journals.

The five-minute worker trigger alternates existing campus reconciliation and
finance maintenance. Finance maintenance installs capture for newly created
product tables, drains a bounded number of financial and webhook events, and
verifies old provider operations and pending attempts. Paystack settlement
transactions can be reconciled page by page from the authenticated finance desk.
Unmatched and amount/currency-mismatched references are visible there. Every
manual replay needs an administrator session and a reason stored in an audit
record. Replay is limited to items in REVIEW.

## Deployment

Apply `sql/035_payment_inbox.sql` and `sql/036_finance_core.sql` before release.
Runtime schema setup is idempotent, but explicit migrations reduce first-request
work. Confirm `PAYSTACK_SECRET_KEY`, `PAYSTACK_CURRENCY`, Turso credentials and
the scheduled Worker trigger. The finance desk is at `/console/finance`.

The first capture pass snapshots existing product rows; those journals are
opening positions, not proof that past provider settlements match. Compare them
with Paystack transaction and settlement reports before using balances to
authorize new types of spending. No historical product rows are deleted.
Measure outbox lag, REVIEW counts and Worker subrequest use during rollout.
Do not increase payout automation until the opening reconciliation is complete.

Provider integration must be tested with Paystack test credentials before live
activation. Production provider credentials, real settlement data, and rollout
approval are external to this repository, so local tests cannot certify actual
bank settlement or Ghana merchant-account capabilities.

## Verification

`tests/payment-core.test.mjs` executes real SQL to cover checkout concurrency,
unknown provider results, rollback, expiring holds, balanced immutable journals,
trigger capture and replay protection. Existing product suites cover booking,
notification, payout and refund behavior. The full repository build and test
command is `npm test`.
