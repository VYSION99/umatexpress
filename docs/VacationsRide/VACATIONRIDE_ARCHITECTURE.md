# vacationRide — Architecture Overview (Marketplace Model)

**Version:** 2.0  
**Status:** Draft for Review  
**Model:** Marketplace (Trip Organizers + Platform Commission)

---

## 1. Overview

**vacationRide** is evolving from a pure B2C scheduled transport product into a **marketplace platform**. 

In this model:
- **Trip Organizers** (individuals or companies) create and manage their own scheduled long-distance trips.
- Students book seats directly through the platform.
- The platform handles payments, takes a **3% commission**, and transfers the remaining **97%** to the trip organizer via **Paystack Transfers**.
- A payout becomes payable **24 hours after the booking was paid**, and never
  against unsettled funds (see `VACATIONRIDE_PAYOUTS.md`).

This is a significant architectural shift that brings vacationRide closer in structure to the planned **Hostel Finder** (marketplace with payouts), while retaining its core strength in scheduled, seat-based bookings.

---

## 2. New Core Value Proposition

| Stakeholder | Value |
|-------------|-------|
| **Students** | Reliable seat booking on scheduled long-distance trips |
| **Trip Organizers** | Self-service trip creation + automated payout (minus 3% platform fee) |
| **Platform** | Commission revenue (3%) + trust layer (payments, safety, dispute resolution) |

---

## 3. Key Entities (Updated)

### New / Modified Core Tables

| Entity | Purpose |
|--------|---------|
| `trip_organizers` | Organizers who create and manage trips (with Paystack recipient details) |
| `scheduled_trips` | Now owned by an `organizer_id` (NULL for the legacy platform-owned trips) |
| `bookings` | Student seat reservations (unchanged core logic) |
| `seat_holds` | Temporary seat reservation during payment (unchanged) |
| `payments` | Inbound payments from students (unchanged) |
| `organizer_payouts` | **New** — one append-only row per confirmed booking carrying the commission split, the release rule and the transfer result |

There is deliberately **no** separate `organizer_audit_logs` table. Organizer
actions are written to the existing platform audit table with the console
account as actor, so one query answers "who did what" across admin, moderator,
organizer and driver activity instead of four partial histories.

### Commission & Payout Model

- **Commission Rate**: Fixed at **3%** per booking (platform keeps 3%, organizer receives 97%).
- **Payout Timing**: Payable 24 hours after the booking is paid; the release job
  sweeps every fifteen minutes.
- **Payout Method**: Paystack Transfers to organizer’s registered recipient account.

---

## 4. Architecture Characteristics

### Strengths (Retained from v1)

| Area | Assessment |
|------|------------|
| **Payment Safety** | Very strong. Uses 10-minute seat holds, webhook signature verification, event deduplication, and `PAYMENT_RECEIVED_REVIEW` fallback state. |
| **Auditability** | Good. Cancellations are logged to `admin_audit_logs` before deletion. |
| **Admin Control** | Strong. Admin can manage trips, prices, and manually resolve payment issues. |
| **Ticket Experience** | Mature. Generates printable image tickets. |
| **Code Reuse** | High. Shares Turso client, payment access tokens, observability, and rate limiting with campusRide. |

### New Architectural Requirements

| Area | Requirement |
|------|-------------|
| **Organizer Self-Service** | Organizers work inside the existing console (`/console/*`); no second portal and no second sign-in |
| **Commission Calculation** | Must be calculated and recorded at booking confirmation time |
| **Payout Ledger** | New `organizer_payouts` table + release job, every fifteen minutes |
| **KYC & Trust** | Organizers must complete verification before receiving payouts |
| **Permission Scoping** | Organizers can only manage their own trips |
| **Reconcile Job** | Failed or stuck transfers must be retried (similar to Hostel Finder) |

---

## 5. Booking + Payout Flow (New Model)

```
Student books seat
        ↓
System creates booking + seat_hold
        ↓
Student pays via Paystack
        ↓
Webhook confirms payment
        ↓
Booking confirmed
        ↓
System calculates:
   - Gross amount
   - 3% commission (platform)
   - 97% net amount (organizer)
        ↓
Creates record in organizer_payouts
        ↓
Release job runs every fifteen minutes:
   - Finds eligible payouts (confirmed, settled, and 24h past payment)
   - Initiates Paystack Transfer to organizer
   - Updates payout status
```

---

## 6. Trip Organizer Capabilities (Self-Service)

Organizers will be able to:

- Register and complete KYC
- Add payout account (bank/MoMo) → stored masked + optional encryption
- Create scheduled trips (date, time, route, capacity, price)
- Manage their trips (edit, cancel, view bookings)
- View their earnings and payout history
- Receive automated payouts a day after each booking is paid

---

## 7. Trust & Moderation Model

Similar to the Hostel Finder approach:

- New organizers start in **PENDING** KYC status.
- A `PENDING` account cannot sign in at all: approval (not KYC) is the account
  gate, and it is mandatory.
- Once approved, an organizer can prepare trips; every trip needs approval
  before it becomes bookable.
- Payouts are blocked until KYC reaches `VERIFIED`.
- Every organizer action is written to the platform audit table with the console
  account as actor.

---

## 8. Technology & Reuse

vacationRide will continue to share the platform’s core infrastructure:

- Turso client, payment access tokens, observability, rate limiting.
- Paystack integration patterns (already used in campusRide and planned for Hostel Finder).
- New payout logic will closely mirror the `hostel_payouts` design.

### Passenger notifications (built)

Booking messages reuse the campusRide notification outbox rather than growing a
second one. One `notification_outbox` row is both the email (Resend) and the
in-app message the student's feed reads, and the unique `(reference, template)`
index makes the write idempotent: verification and the Paystack webhook can both
confirm one booking, and whichever arrives first queues the single confirmation
the passenger receives. The `vacation_` template prefix selects the vacation
ticket link (`/payment/callback`) at send time.

Because those messages link straight to the ticket, ticket access cannot rest
on the one-hour payment cookie alone. `GET /api/payments/verify` accepts the
payments access token or a signed-in passenger whose account email matches the
booking's. Guests keep the token as their key; a signed-in student keeps their
own ticket on any device, even after the cookie expires.

The in-app feed resolves its "Open ticket" link from the message's template
prefix, so a vacationRide message opens the boarding pass and a campusRide
message opens the queue ticket. A link opened by a guest or by the wrong
account shows a sign-in handoff that returns to the same ticket instead of
reporting a payment failure.

`vacation_booking_confirmed` is queued on confirmation, and
`vacation_booking_cancelled` when an administrator cancels a booking the
passenger actually paid for. Both are written on the payment path, so they log
their own failures and never turn a successful payment into an error. Messages
never promise a refund, because a refund is a decision the ledger makes, not the
message.

---

## 9. Recommended Phased Rollout

`ORGANIZER_SELF_SERVICE_ARCHITECTURE.md` owns the phase list. It is:

| Phase | Focus | Key Deliverables |
|-------|-------|------------------|
| 1 | Console identity (shipped) | `console_accounts`, one sign-in, console origin boundary, role guards |
| 2 | Organizer accounts and ownership | Registration + approval, `trip_organizers`, trip ownership and manifest, per-organizer notice |
| 3 | Self-service publishing | Organizer trip create/edit, review workflow, KYC and payout-account capture |
| 4 | Money and attribution | Commission at booking time, `organizer_payouts` ledger, statement, admin-triggered batches |
| 5 | Automated payouts | Paystack Transfers, release + reconcile jobs, settlement gate |
| 6 | Trust and insight (shipped) | Disputes, route-overlap warnings, analytics, public read rate limits |

---

## 10. Open Decisions

| Decision | Status |
|----------|--------|
| Exact KYC requirements for organizers | **Decided: ID type and number only, sealed at rest. No document scans are stored, so there is no retention policy to write yet** |
| Whether trips need admin approval before going live | **Decided: yes, mandatory** (D4) |
| Payout release rule | **Decided: 24h after the booking was paid, and only on settled funds** |
| Maximum payout retry attempts and backoff strategy | Open — Phase 5 |
| One audit table or one per role | **Decided: one platform audit table, actor + role columns** |

---

This revised architecture positions **vacationRide** as a true marketplace while preserving its existing payment safety strengths.

---

**End of Revised vacationRide Architecture Overview**
