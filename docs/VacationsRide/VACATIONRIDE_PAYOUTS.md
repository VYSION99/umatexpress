# vacationRide — Payout Architecture (Trip Organizers)

**Version:** 1.3  
**Status:** Phase 4 and Phase 5 built — sections 2 to 6 describe what now runs, including the automated transfer and its reconcile job

---

## 1. Overview

This document defines the **payout system** for trip organizers in the new marketplace model of vacationRide.

Key rules:
- Platform takes a **fixed 3% commission** per booking.
- Organizers receive **97%** of the booking amount.
- Payouts go to **mobile money only**. A bank transfer costs Paystack GHS 8.00
  against GHS 1.00, and the fee is the organizer's, so the ride side keeps the
  cheap rail. Hostels keep both rails; a landlord's payout is a term's rent.
- The **Paystack transfer fee is deducted from the payout**, not charged to the
  platform: an organizer owed GHS 174.60 to mobile money receives GHS 173.60.
  The organizer's business profile states this before they save an account.
- A payout becomes payable **20 minutes after the booking was paid**, a window
  the admin console can change (`organizer_payout_release_minutes`, including
  `0` for as-soon-as-settled). Paystack's mobile money transfers land in
  seconds, so this wait is the platform's own reversal window, not the rail's.
- All payouts go through **Paystack Transfers**.

Automated transfers are the end state, not the first step: Phase 4 ships the
ledger and admin-triggered batches, Phase 5 automates them (section 8).

Two safety rules override the schedule below:

1. **A payout waits out its release window after the payment that created it.**
   The anchor is the moment the booking was paid: `release_after` is paid + the
   configured window, computed when the ledger entry is written. That window is
   the reversal one — the only stretch in which a mistaken or duplicated
   payment can be undone by refusing the payout instead of clawing it back
   afterwards. It is twenty minutes by default and can be zero. Eligibility is
   deliberately **not** tied to the coach's departure: a seat sold a month
   before travel becomes payable at the same pace as one sold today.
2. **Release waits for settlement.** Paystack settles payments on its own
   schedule; a transfer attempted against unsettled funds can fail. The release
   job only picks up payouts whose funds are settled, and a failed transfer is
   retried, never dropped.

### What the commission is charged on

Amounts are integers in the smallest currency unit (**pesewas**), which is what
Paystack expects. `scheduled_trips.price` is the one exception: it is GHS, and
the payment layer multiplies it by 100.

`bookings.amount` is **not** the commission base. It is what the student was
charged: the fare *plus* the Paystack charge, which is a pass-through. The
commission base is the fare alone:

| Column | Meaning | Commissioned? |
|--------|---------|---------------|
| `payments.fare_amount` | the ticket price the organizer set | Yes — this is `gross_amount` |
| `payments.fee_amount` | Paystack's charge, passed to the student | No |
| `payments.amount` / `bookings.amount` | fare + pass-through fee | No |

```
commission_amount = round(gross_amount * commission_bps / 10000)
net_amount        = gross_amount - commission_amount
```

The two roundings are deliberately not independent: `net` is derived from
`gross - commission` so the split can never be a pesewa short or over.

---

## 2. Core Payout Entity

### `organizer_payouts` Table

```sql
organizer_payouts (
  id TEXT PRIMARY KEY,
  organizer_id TEXT NOT NULL,                    -- FK to trip_organizers
  booking_id TEXT NOT NULL,                      -- FK to bookings
  gross_amount INTEGER NOT NULL,                 -- payments.fare_amount, in pesewas
  commission_amount INTEGER NOT NULL,            -- round(gross * commission_bps / 10000)
  net_amount INTEGER NOT NULL,                   -- gross - commission
  release_after TEXT NOT NULL,                   -- paid_at + 24h; the reversal window
  status TEXT NOT NULL DEFAULT 'ACCRUED',        -- ACCRUED | PROCESSING | RELEASED | REVERSED | FAILED
  transfer_reference TEXT,
  released_at TEXT,
  transferred_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

This is the same table `ORGANIZER_SELF_SERVICE_ARCHITECTURE.md` sketches as
`organizer_payout_ledger`; `organizer_payouts` is the name of record. One row is
written per confirmed booking, at confirmation time, and the amounts are
append-only: releases and reversals change status and timestamps, never the
gross, commission or net.

`commission_bps` on `trip_organizers` (default `300`) is the rate. The resolved
`commission_amount` is copied onto the booking **and** onto this row, so a later
rate change cannot rewrite what an organizer already earned.

---

## 3. Payout Lifecycle

```
Booking confirmed
        ↓
System calculates:
   - gross = payments.fare_amount (never bookings.amount: it carries Paystack's fee)
   - commission = round(gross * commission_bps / 10000)
   - net = gross - commission
        ↓
Insert into organizer_payouts with:
   - release_after = paid_at + organizer_payout_release_minutes
        ↓
Release job runs on nearly every minute of the hour:
   - Finds all ACCRUED payouts where release_after <= now
   - Initiates a Paystack Transfer for the organizer's ready total
   - Sets the batch to SUCCESS (entries RELEASED) or PENDING while in flight,
     and to FAILED for a transfer Paystack rejects
```

---

## 4. Payout Release Job

**Responsibilities:**
- Query all eligible payouts.
- Call Paystack Transfer API for each.
- Handle success / failure.
- Log all transfer attempts.
- Retry failed transfers on subsequent runs (with backoff).

**Idempotency:** The job must be safe to run multiple times without creating duplicate transfers.

**As built.** The job runs on every minute the other triggers leave free (a cron list computed
from theirs, so no two triggers share a minute) because
`release_after` is the gate, not the schedule: running more often only drains a
backlog sooner, and the query that picks entries up already refuses one whose
window has not passed. Each run takes at most four organizers, which keeps it
inside the free plan's fifty subrequests per invocation, and it stops when the
settled balance runs out of headroom — every transfer also costs a fee, which is
deducted from the payout (`PAYOUT_TRANSFER_FEE_MOMO_PESEWAS`).

Idempotency is the claim, not a check: the batch row is written first, then a
conditional `UPDATE ... WHERE status = 'ACCRUED' AND batch_id = ''` moves the
entries to `PROCESSING`. Only the run that moved rows sends anything, so a cron
run overlapping an administrator's run cannot pay a booking twice.

An entry is released only when Paystack says the transfer arrived. The webhook
is the fast path; the reconcile job, which waits two minutes before looking, is
what notices a delivery that never came. A transfer that fails returns its
entries to `ACCRUED` — the platform still holds the money — and one that
reverses does the same rather than creating a debt. Only a refund of a booking
whose payout already arrived creates a debt.

Unattended runs are off unless the switch is on: **Console > Platform
settings** holds the audited override, and `PAYOUT_AUTO_ENABLED` remains the
fallback for a deployment that never opens that page. Running the job
from `/console/payouts` is an attended act and is not gated by the switch.

---

## 5. Error Handling & Recovery

| Scenario | Handling |
|----------|----------|
| Transfer fails | Entries return to `ACCRUED` with the failure recorded; retried by the next run |
| Transfer fails three times | Entries park as `FAILED`; an administrator reopens them from the console |
| Organizer recipient is invalid | Recipient creation fails, the batch is marked `FAILED`, nothing is sent |
| Paystack transfer is pending | The reconcile job polls it; the webhook settles it if it arrives first |
| Platform balance does not cover a payout | The organizer is skipped this run and picked up when the balance settles |
| Organizer KYC revoked | Block future payouts until re-verified |
| Refund after the payout was released | The organizer's balance goes negative and the next payout absorbs it; the ledger row moves to `REVERSED` |
| Transfer reversed by Paystack | Entries return to the ledger, not to debt: the money came back, so it is still owed |
| Organizer balance is negative at payout time | No transfer; the balance carries forward and the organizer statement shows why |

---

## 6. Security & Audit

- All payout actions are logged in the platform audit table (`admin_audit_logs`) with the acting console account, including every reveal of a full payout account number.
- Payout account details are **masked** in admin views.
- Full account details require an audited "reveal" action.
- Organizers can only see their own payout history.

---

## 7. Relationship with Other Modules

This payout system is intentionally designed to be **similar** to the planned `hostel_payouts` system in Hostel Finder. This allows future code sharing between the two modules.

## 8. Staging

Automated transfers move money with no human in the loop, so the phases keep
them apart:

| Phase | What ships |
|-------|-----------|
| 4 ✓ | Accrual ledger, organizer statement, admin-triggered payout batch that records the transfer reference by hand |
| 5 ✓ | Paystack Transfers API, the release job, the reconcile job, and the settlement feed that replaced the administrator's judgement with Paystack's balance |

**As built.** The ledger is `organizer_payouts`, written once per confirmed
booking at confirmation time (verification and the webhook both call
`accrueForBooking`, and a unique index on `booking_id` makes the second write a
no-op). `release_after` is the configured release window after the moment the booking was paid,
anchored on `bookings.confirmed_at`, then `payments.completed_at`, then
`payments.created_at`, then `bookings.created_at` for entries whose payment row
has not recorded a confirmation. An administrator records a payout from
`/console/payouts`, which moves every ready entry to `RELEASED` in one batch and
stores the transfer reference they were given. Organizers read their own
statement at `/console/earnings`.

Two rules this document set out, as implemented:

1. **A payout is never released before its reversal window has closed**:
   `release_after` is the payment time plus the configured window, computed when
   the entry is written, so a booking is never payable in the same breath as its
   payment. The window is a console setting (`0` pays as soon as the settled
   balance allows) and it is written onto each entry, so shortening it pays
   future bookings sooner and never re-times money already earned.
2. **Release waits for settlement.** The release job reads Paystack's balance
   and stops when it cannot cover what the ledger owes, so a payout is only
   attempted against money that has actually settled. The transfer fee is
   deducted from the payout itself, so Paystack's debit — the amount sent plus
   its own fee — is exactly the amount the ledger owed, and the balance never
   has to carry the fee on top. An administrator recording a manual batch is
   still their own settlement check for that batch.

A refund before release reverses the entry and nothing else happens. A refund
after release reverses the entry and leaves a debt, because `released_at` is
kept as the evidence that money left. The debt blocks the next batch until it
is settled: the release job skips any organizer carrying one, so a debt is
never silently netted against what they are owed next.

Before Phase 5 moved real money, the Paystack account was checked for the
transfer permission, which is separate from collecting payments: the recipients,
transfers and balance endpoints all answer on the live account.

---

**End of vacationRide Payout Architecture**
