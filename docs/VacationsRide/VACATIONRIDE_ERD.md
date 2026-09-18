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
│ status               │        │ kyc_status           │  Phase 3
│ profile_id  ─────────┼───────►│ payout_*             │  Phase 3
│ token_version        │        │ paystack_recipient_  │  Phase 3
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
│      seat_holds      │        │  organizer_payouts   │  Phase 4
│──────────────────────│        │──────────────────────│
│ id (PK)              │        │ id (PK)              │
│ booking_id (UQ, FK)  │        │ organizer_id (FK)    │
│ trip_id (FK)         │        │ booking_id (FK)      │
│ travel_date          │        │ gross_amount         │  = payments.fare_amount
│ seat                 │        │ commission_amount    │
│ status               │        │ net_amount           │
│ expires_at           │        │ release_after        │
│ created_at           │        │ status               │
│ UQ(trip_id,          │        │ transfer_reference   │
│    travel_date,      │        │ released_at          │
│    seat)             │        │ transferred_at       │
└──────────────────────┘        │ created/updated_at   │
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
