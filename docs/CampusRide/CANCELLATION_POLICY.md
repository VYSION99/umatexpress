# CampusRide Cancelling a Seat, and the Money That Follows

**Status:** implemented — a seat may be given up, the fare outcome is decided by policy, and the refund is recorded but never sent by the cancellation itself
**Applies to:** `campus_queue_entries`, `campus_refunds`, `campus_payments`, the student ticket, the campus refund desk

---

## 1. The rule, in one reading

There are two separate questions when a seat is given up, and they were
previously answered by the same silence — nothing happened, and the platform
kept the money.

1. **May the seat still be given up?** Yes, until the passenger has boarded.
2. **What is owed back?** It depends on whether anyone had taken the seat, and
   on who ended the ride.

The answers are in one place, `campusRefundQuote`, so the button on the ticket,
the confirmation text and the ledger row can never quote three different
policies.

| Seat state | Who ended it | Fare outcome |
|------------|--------------|--------------|
| `PAID_WAITING` (nobody has taken the seat) | passenger | **full refund** — the passenger paid for a seat nobody took |
| `PAID_WAITING` | platform (nobody ever came) | **full refund** — the seat was never delivered |
| `ACCEPTED_BY_DRIVER`, `DRIVER_ARRIVED` | passenger | **no refund** — the driver has already spent the trip coming to them |
| `ACCEPTED_BY_DRIVER`, `DRIVER_ARRIVED` | driver cancels | **full refund** — the passenger paid for a journey the driver did not deliver |
| `ACCEPTED_BY_DRIVER`, `DRIVER_ARRIVED` | the ride closes under them | **full refund** — the platform did not deliver it either |
| `BOARDED`, `COMPLETED` | — | **cannot be cancelled** |
| not paid | passenger | **nothing to refund** — cancelling just frees the seat |

The harsh half of the rule is about the passenger's own change of mind, and it
exists because the driver has already paid for the trip in fuel and time. Turn
the cause around and the reasoning inverts, which is why `campusFailedRideQuote`
answers the second row of cases and the *cause* — never the passenger — chooses
between the two functions.

A **no-show** is deliberately the other case. The driver was there and the
passenger was not, so the fare is kept and the record is kept with it.

## 2. What "full refund" means

The passenger gets back what they paid: the fare **and** the payment rail's fee,
because the amount refunded is the checkout total, not the fare alone. Paystack's
fee on a refund the platform caused is absorbed by the platform. The amount is
small, and the alternative — a student short by ten pesewas because the platform
could not find them a vehicle — is not a thing to defend.

The refunded sum is written onto the refund row as `amount`, split into
`fare_amount` and `fee_amount`, and `absorbed_fee` records the part the platform
eats.

## 3. The refund lifecycle

Cancelling never moves money. It ends the seat, releases it back to the ride, and
records what is owed; only a decision sends it.

| State | Meaning |
|-------|---------|
| `REQUESTED` | recorded, waiting for the desk — or for the sweep when automatic refunds are on |
| `APPROVED` | decided, handed to Paystack, not yet confirmed by the rail |
| `PAID` | the rail confirmed it, or an administrator recorded the transfer |
| `DECLINED` | an administrator refused it, with a reason kept on the row |
| `FAILED` | the rail refused it; the row stays visible so it is not lost |

Three roads lead to a refund, and all three end in the same queue:

- **The passenger cancels.** `POST /api/campus/queue/cancel`, authorised by the
  one-hour payment cookie or the signed-in account the booking was made under.
- **The driver cancels.** The passenger is refunded in full automatically at the
  moment of the cancel; a no-show is not.
- **The sweep.** Every five minutes the reconcile looks for paid seats that are
  stale — nobody took them inside the window, or the ride closed under them —
  and refunds them without the passenger having to ask.

Paystack settles a refund asynchronously, so `APPROVED` is a real state and not
a failure: `refund.processed` (webhook) or the next reconcile pass finishes it.
One refund reference is looked for in the hostel ledger first and the campus
ledger second, which is how a single webhook serves both products.

## 4. The sweeps and the two switches

| Setting | Meaning | Shipped default |
|---------|---------|-----------------|
| `campus_unmatched_refund_minutes` | how long a paid seat may wait for a driver before the sweep refunds it | 30 |
| `campus_auto_refund_unmatched` | whether the sweep may approve the refund it records | off |

The window measures from the moment the passenger paid. Thirty minutes is short
by design: a campus shuttle turns around in minutes, and a paid seat that is
earning nobody a ride is a queue full of money. It only touches a seat nobody has
taken; once a driver accepts, the seat is theirs and cancelling is the
passenger's own decision under section 1.

Automatic refunds are a **separate switch from the payout switches**, and that
separation is deliberate. Returning money the platform already holds for a
service it did not deliver is not the same act as releasing a payee's earnings,
and an operator who wants every refund reviewed can turn this off and lose only
the automatic part. Off, the sweep still records the refund and still tells the
passenger — it just waits for a person.

## 5. What the passenger sees

- The ticket's status payload now carries the quote (`cancellation`), so the
  Cancel button, the confirmation line and the amount are rendered from the
  ledger rather than recomputed in the browser.
- Cancelling is two taps: the first opens the policy in full, the second gives up
  the seat. Nobody loses a ride to a stray touch.
- The refund line stays up after the seat is gone, because that is exactly when a
  passenger wants to know where their money is. It speaks in **working days**
  ("usually within 3–5 working days") because the rail, not the platform,
  decides when a card or wallet shows the money.
- The queue timeline gained a `NO_DRIVER_FOUND` terminal state, and the
  cancellation states now say that any fare due back is shown below.

## 6. The refund desk

`/console/campus` carries **Campus refunds**, which is a queue rather than a
report: filter by status, approve and send, decline with a reason, record a
transfer made outside Paystack, ask Paystack about a sent refund, or run the
sweep on demand. A decline needs a reason, because a silent no is the thing that
turns a refund into a complaint — the passenger is told, and the reason is kept
on the row for whoever looks next.

## 7. What is deliberately not here

**Reversing the driver's accrual.** A refund must reverse the payee's accrual
exactly as the hostel side does. campusRide has no driver payout ledger yet, so
there is nothing to reverse: the commission and net on `campus_payments` are
recorded arithmetic until a payout rail exists. The moment a campus payout ledger
lands, `openCampusRefund` and `approveCampusRefund` acquire the reversal the
hostel module already has.

**Sending money at cancel time.** A cancel records; a person or the sweep
decides. That is what keeps a tap on a ticket from moving money.

## 8. Files

| Concern | Where |
|---------|-------|
| The policy, the quote and the lifecycle | `lib/campus-engine/refunds.ts` |
| The passenger's endpoint | `app/api/campus/queue/cancel/route.ts` |
| The quote on the ticket payload | `lib/campus-engine/queue-status.ts` |
| The terminal states and their copy | `lib/campus-engine/progress.ts` |
| The passenger's messages | `lib/campus-engine/notify-templates.ts` |
| The driver's cancel records the refund | `lib/campus-engine/driver.ts` → `updateDriverQueueEntry` |
| The webhook | `app/api/payments/webhook/route.ts` |
| The reconcile and the sweep | `lib/campus-engine/reconcile.ts` |
| The desk's API and panel | `app/api/console/campus/refunds/route.ts`, `components/campusRide/admin/CampusRefundsPanel.tsx` |
| The console route | `/console/campus` |

## 9. Tests

`tests/campus-cancellation.test.mjs` holds the whole path: the quote for each
seat state, a cancel that returns the seat and records the refund, a second
cancel that cannot open a second refund, a boarded seat that cannot be cancelled
at all, the sweep's two causes, the fare kept on a no-show, the refund that is
recorded but not sent, a decline that needs a reason, a hand-recorded transfer,
Paystack's word closing a refund, the settings' shipped defaults, the ticket's
terminal states, and the endpoint refusing a stranger.
