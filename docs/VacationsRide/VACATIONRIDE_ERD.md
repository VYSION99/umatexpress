# vacationRide — Entity Relationship Diagram (ERD)

**Version:** 2.0  
**Status:** Draft for Review — corrected against the implementation  
**Covers:** the shipped booking model and the Phase 2–4 organizer tables

---

## 1. Shipped entities

```
┌──────────────────────┐        ┌──────────────────────┐
│  console_accounts    │        │   trip_organizers    │
│──────────────────────│        │──────────────────────│
│ id (PK)              │        │ id (PK)              │
│ email (UQ)           │        │ name                 │
│ name, phone          │        │ phone (UQ)           │
│ password_hash/salt   │        │ email (UQ)           │
│ password_iterations  │        │ organization         │
│ role                 │        │ status               │
│ status               │        │ kyc_status           │  Phase 3 ✓
│ profile_id  ─────────┼───────►│ kyc_id_* / kyc_reason│  Phase 3 ✓ (sealed)
│ token_version        │        │ payout_*             │  Phase 3 ✓ (sealed)
│                      │        │ paystack_recipient_  │  Phase 4
│ created/updated_at   │        │   code               │
└──────────┬───────────┘        │ commission_bps       │
           │ 1                  │ created/updated_at   │
           │                    └──────────┬───────────┘
           │                               │ 1
           │                               │
           │                    ┌──────────▼───────────┐
           │                    │   scheduled_trips    │
           │                    │──────────────────────│
           │                    │ id (PK)              │
           │                    │ title                │
           │                    │ route_from, route_to │
           │                    │ travel_date          │
           │                    │ departure_time       │
           │                    │ arrival_time         │
           │                    │ price        (GHS)   │
           │                    │ capacity             │
           │                    │ coach_type, tag      │
           │                    │ amenities, notes     │
           │                    │ active, archived     │
           │                    │ display_order        │
           │                    │ organizer_id (FK) ───┘  NULL = platform
           │                    │ review_status        │  DRAFT | PENDING_REVIEW
           │                    │ created/updated_at    │  APPROVED | REJECTED | SUSPENDED
           │                    └──────────┬───────────┘
           │                               │ 1
           │                               │ N
           │                    ┌──────────▼───────────┐
           │                    │      bookings        │
           │                    │──────────────────────│
           │                    │ id (PK)              │
           │                    │ reference (UQ)       │
           │                    │ trip_id (FK)         │
           │                    │ organizer_id (FK)    │  Phase 4 attribution
           │                    │ commission_amount    │  Phase 4, pesewas
           │                    │ seat                 │
           │                    │ passenger_name       │
           │                    │ email, phone         │
           │                    │ amount      (pesewas)│  fare + Paystack fee
           │                    │ payment_status       │
           │                    │ booking_status       │
           │                    │ hold_expires_at      │
           │                    │ confirmed_at         │
           │                    │ departure_time       │
           │                    │ created_at           │
           │                    └──────────┬───────────┘
           │                               │ 1
           │                               │ N
           │                    ┌──────────▼───────────┐
           │                    │      payments        │
           │                    │──────────────────────│
           │                    │ id (PK)              │
           │                    │ booking_id (FK)      │
           │                    │ provider             │
           │                    │ reference_id (UQ)    │
           │                    │ external_id          │
           │                    │ financial_txn_id     │
           │                    │ payer_phone          │
           │                    │ amount      (pesewas)│  fare + fee
           │                    │ fare_amount (pesewas)│  ◄── commission base
           │                    │ fee_amount  (pesewas)│  ◄── pass-through
           │                    │ currency             │
           │                    │ status               │
           │                    │ access_token_hash    │
           │                    │ created/updated_at   │
           │                    │ completed_at         │
           │                    └──────────────────────┘

┌──────────────────────┐        ┌──────────────────────┐
│      seat_holds      │        │  organizer_payouts   │  Phase 4 ✓
│──────────────────────│        │──────────────────────│
│ id (PK)              │        │ id (PK)              │
│ booking_id (UQ, FK)  │        │ organizer_id (FK)    │
│ trip_id (FK)         │        │ booking_id (FK, UQ)  │
│ travel_date          │        │ booking_reference    │
│ seat                 │        │ trip_id (FK)         │
│ status               │        │ gross_amount         │  = payments.fare_amount
│ expires_at           │        │ commission_amount    │
│ created_at           │        │ net_amount           │  gross − commission
│ UQ(trip_id,          │        │ commission_bps       │  the rate in force at accrual
│    travel_date,      │        │ release_after        │  next midnight, never before departure + 24h
│    seat)             │        │ status               │  ACCRUED | RELEASED | REVERSED | FAILED
└──────────────────────┘        │ batch_id (FK)        │
                                │ transfer_reference   │  recorded by an admin in Phase 4
                                │ released_at          │  kept when reversed: proof money left
                                │ transferred_at       │
                                │ reversed_at, reason  │
                                │ created/updated_at   │
                                └──────────┬───────────┘
                                           │ N
                                           │ 1
                                ┌──────────▼───────────┐
                                │ organizer_payout_    │  Phase 4 ✓
                                │ batches              │
                                │──────────────────────│
                                │ id (PK)              │
                                │ organizer_id (FK)    │
                                │ total_amount         │
                                │ entry_count          │
                                │ transfer_reference   │  the hand-recorded one
                                │ note, created_by     │
                                │ created_at           │
                                └──────────────────────┘

┌──────────────────────┐        ┌──────────────────────┐
│     trip_notices     │  Phase 2│   admin_audit_logs  │
│──────────────────────│        │──────────────────────│
│ organizer_id (PK, FK)│        │ id (PK)              │
│ enabled              │        │ admin_email          │  actor (any console role)
│ title, route, fare   │        │ action                │
│ night_bus, day_buses │        │ target_type           │
│ drop_off_points      │        │ target_reference      │
│ amenities, contacts  │        │ details               │
│ updated_at           │        │ created_at            │
└──────────────────────┘        └──────────────────────┘

┌──────────────────────┐
│     trip_disputes    │  Phase 6 ✓
│──────────────────────│
│ id (PK)              │
│ organizer_id (FK)    │  copied from the booking, never the request
│ trip_id (FK)         │  copied from the booking
│ booking_reference    │
│ raised_by_role       │  STUDENT | ORGANIZER
│ raised_by            │  account email, or organizer id
│ raised_by_contact    │  reply address; the account's own email
│ category             │  BOOKING | REFUND | TRIP_CANCELLED | DELAY | CONDUCT | PAYMENT | OTHER
│ subject, details     │
│ status               │  OPEN | REVIEWING | RESOLVED | DISMISSED
│ resolution           │  REFUND | PARTIAL_REFUND | RELEASE_PAYOUT | NO_ACTION | OTHER
│ resolution_note      │  required once the status is RESOLVED
│ resolved_by          │  the administrator who decided it
│ resolved_at          │
│ created_at, updated_at│
└──────────────────────┘
```

The platform-wide notice stays in `trip_settings` (single row, `id = 1`) and is
the fallback for trips with no organizer. `trip_notices` only ever holds
organizer rows.

## 2. Relationships

| Relationship | Cardinality | Description |
|--------------|-------------|-------------|
| `console_accounts` → `trip_organizers` | 1:0..1 | An organizer account links to its business record by `profile_id` |
| `console_accounts` → `campus_drivers` | 1:0..1 | A driver account links to its campus driver record |
| `trip_organizers` → `scheduled_trips` | 1:N | An organizer owns many trips; `NULL` owner means the platform's legacy trips |
| `scheduled_trips` → `bookings` | 1:N | One trip has many seat bookings |
| `bookings` → `payments` | 1:N | One booking can have several payment attempts |
| `bookings` → `seat_holds` | 1:1 | At most one active hold per booking |
| `bookings` → `organizer_payouts` | 1:1 | A confirmed booking accrues exactly one payout row, enforced by a unique index on `booking_id` |
| `organizer_payouts` → `organizer_payout_batches` | N:1 | Entries sent together share the attempt that carried them; the link is cleared when an attempt fails and the entries return to the ledger |
| `bookings` → `trip_disputes` | 1:N | A dispute names a booking by reference, and the trip and organizer are copied from it at open time, so a dispute can never be pointed at another organizer's row |
| `scheduled_trips` → `trip_notices` | N:1 | A trip uses its organizer's notice, or the platform fallback |

## 3. Design notes

- **`seat_holds` owns inventory.** The unique key is
  `(trip_id, travel_date, seat)`, which is trip-scoped and stays trip-scoped:
  seat inventory is never organizer-scoped.
- **`dynamic_trips` is not a table.** Earlier drafts listed it as an entity;
  "dynamic trips" are rows in `scheduled_trips`, read through
  `lib/dynamic-trips.ts`. There is one trip table, and the organizer columns go
  on it.
- **Amounts.** `scheduled_trips.price` is GHS; every amount that reaches
  Paystack is an integer in pesewas. The commission base is
  `payments.fare_amount`, never `bookings.amount` (which adds Paystack's
  pass-through charge).
- **`organizer_payouts` is append-only.** A release or a reversal changes
  `status` and the timestamps, never the gross, the commission or the net, so a
  statement always reconciles to the bookings behind it. `released_at` is kept
  when a released entry is reversed: that timestamp is the only evidence money
  left the platform, and therefore the only reason a reversal creates a debt
  instead of quietly cancelling a row.
- **`organizer_payout_batches` records attempts, not intentions.** `mode` says
  whether an administrator made the transfer by hand (`MANUAL`) or Paystack did
  (`AUTO`), and `status` says how that attempt ended. An entry carries a
  `batch_id` only while the money is in flight (`PROCESSING`); a failed or
  reversed transfer clears it and returns the entry to `ACCRUED`, so the batch
  row is the record of what was tried and the ledger is the record of what is
  owed. A debt is created by a refund of an already-paid booking, never by a
  transfer that did not arrive.
- **A payout account is an address, not just a number.** Paystack addresses a
  transfer by `bank_code`, so `trip_organizers.payout_bank_code` and
  `payout_bank_name` sit beside the sealed account number. Changing any of
  them clears `paystack_recipient_code`, which is what stops the next payout
  from being sent to the previous account.
- **`admin_audit_logs` is the platform audit table**, not an admin-only one:
  driver, moderator, organizer and admin actions all land there with the actor
  and role in `details`. There is no `organizer_audit_logs`.
- **`payments.access_token_hash`** allows a ticket to be read with a bearer
  cookie instead of exposing passenger details to anyone who knows a reference.
- **`console_accounts.status`** is the account gate (`PENDING | ACTIVE |
  SUSPENDED`) and `trip_organizers.status` carries the application's own
  decision (`PENDING | APPROVED | REJECTED | SUSPENDED`). The two move together
  on approval and suspension; a `REJECTED` application leaves its console
  account `PENDING`, which is already a state that cannot sign in, so the
  console vocabulary stays three-valued. `kyc_status` is a separate, later gate
  that only decides whether money may be paid out.
- **`trip_disputes` records decisions, not money.** The resolution labels
  (`REFUND`, `PARTIAL_REFUND`, `RELEASE_PAYOUT`) say what an administrator
  decided; the ledger rows that move money are still written by the
  booking-cancel and payout paths alone. Keeping the two apart means a dispute
  can never claim a refund that no ledger row supports, and an organizer's
  dispute list never exposes the passenger's contact — the reply address is
  the account email the dispute was filed from.
