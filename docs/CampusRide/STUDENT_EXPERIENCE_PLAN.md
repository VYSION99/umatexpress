# CampusRide — the Student Experience Plan, and Where It Stands

**Goal:** a student should be able to reach a seat without anxiety, without
guesswork, and without losing money to a ride that never happened. Every item
below was chosen against that one test.

---

## 1. Status of the five items

| # | Item | Status |
|---|------|--------|
| 1 | Free cancel while unmatched, and an automatic refund when nobody takes the seat | **implemented** — `docs/CampusRide/CANCELLATION_POLICY.md` |
| 2 | Arrival estimates and a self-building trip manifest | **implemented** — `docs/CampusRide/BOARDING_AND_ARRIVAL.md` |
| 3 | Route-first entry, and "notify me" when nothing is live | **implemented** — `docs/CampusRide/DEPARTURE_BOARD_AND_WATCH.md` |
| 4 | Ride pass (a student prepaid balance) | **designed, deliberately not built** — section 3 |
| 5 | Post-trip ratings and a report path | **implemented** — `docs/CampusRide/RIDE_FEEDBACK.md` |

Items 1–3 are the comfort items and they are shipped together because they are
one story: a student can find a route, join it knowing what it costs, watch a
driver approach to the minute, and get their money back untouched if the ride
never happens.

## 2. Why 1–3 came first

Each of them removes a specific moment of anxiety rather than adding a feature:

- **The seat that was paid for and never sold.** The old code had a
  `CANCELLED_BY_STUDENT` state nothing could reach, so a passenger who changed
  their mind had no door and a passenger nobody collected had no refund. The
  policy is one line — a seat nobody has taken must not be paid for — and it is
  now enforced, announced and reversible.
- **The driver who is "on the way" with no number attached.** A queue-batch
  estimate is honest while nobody has claimed the seat and wrong afterwards.
- **The gate with nothing live.** The platform used to learn nothing from a
  student who walked up and found no ride, which is exactly the demand signal a
  campus operation needs. Now the wish is recorded and settled.

## 3. The ride pass, and why it is deliberately not built yet

A ride pass is a balance a student tops up once and spends per ride, instead of
a Paystack checkout per trip. It is a good idea and it is not safe to build
today, for one reason:

**A prepaid balance is money the platform holds for someone else.** It is a
liability from the moment a student tops up, it must be reconciled against real
cash, and it must be refundable on demand. Building it while payouts cannot
settle — Paystack auto-settling every collection to the bank leaves the balance
at GH₵ 0.00, so transfers are refused for insufficient funds — would create a
product where students can pay in and drivers cannot be paid out. That is worse
than a checkout per ride.

It also would not remove the work it appears to remove. The ledger already is
the wallet: every collection, commission split and net amount is recorded per
ride on `campus_payments`. What a ride pass adds is a second store to reconcile,
not a first one.

**The order that makes it safe:**

1. Fix settlement so a driver payout can actually fire (stop auto-settlement,
   keep a working float, or move to Paystack splits/subaccounts).
2. Build the driver payout ledger, so a ride's net is a payable rather than an
   arithmetic record — and so a refund has an accrual to reverse, which
   `lib/campus-engine/refunds.ts` already notes as the missing half.
3. Then the pass: a per-student balance table, top-up through the same rail,
   spend at reserve time, refund-to-balance, and a float reconciliation that
   ties the balance total to a bank balance every day.

Until step 1 is done, a ride pass is a promise the platform cannot keep.

## 4. Ratings and reports — what shipped, and what is still staged

The smallest honest version shipped, in the order that makes each step useful:

1. **A report that lands where someone is already looking** — one field plus a
   category, filed as a dispute carrying the campusRide reference, so a person
   reads it and a decision can be recorded against it.
2. **A score the driver sees only as an average** — one row per seat, one to
   five, with the average withheld below three rated trips so the number is
   never a verdict nobody earned.
3. **A rankings view for operations** — the per-driver table sorted weakest
   average first, because the only question a rating desk answers is which run
   needs a look.

Still staged, deliberately:

- **A threshold that takes a route off the board.** That is a suspension, and it
  belongs beside driver suspension where a reason is recorded, not inside a
  scoring function.
- **Ratings as demand signal.** Which corridors are rated worst is not the same
  as which need a different vehicle, and that judgement needs more data than one
  term of ratings can carry.

## 5. Invariants the whole plan rests on

- A cancellation never moves money; a decision or the sweep does.
- A refund returns what the passenger paid, including the rail's fee.
- A fare is kept only when the passenger is the cause.
- An estimate is labelled with what it is built from, and a stale fix is a
  fallback with a visible caveat, never a silent one.
- A promise to a student ("we will tell you") is settled once, by a job, and
  recorded.
