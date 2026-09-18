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
- Payouts are released daily at **12:00 AM**.

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
| `scheduled_trips` | Now owned by a `trip_organizer_id` |
| `bookings` | Student seat reservations (unchanged core logic) |
| `seat_holds` | Temporary seat reservation during payment (unchanged) |
| `payments` | Inbound payments from students (unchanged) |
| `organizer_payouts` | **New** — Tracks commission split and payout to organizers |
| `organizer_audit_logs` | Tracks organizer actions (trip creation, modifications, cancellations) |

### Commission & Payout Model

- **Commission Rate**: Fixed at **3%** per booking (platform keeps 3%, organizer receives 97%).
- **Payout Timing**: Daily batch at **12:00 AM**.
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
| **Organizer Self-Service** | Organizers need their own console (`/organizer`) to create/manage trips |
| **Commission Calculation** | Must be calculated and recorded at booking confirmation time |
| **Payout Ledger** | New `organizer_payouts` table + daily release job at 12:00 AM |
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
Daily job runs at 12:00 AM:
   - Finds all eligible payouts (confirmed + release time reached)
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
- Receive automated payouts at 12:00 AM

---

## 7. Trust & Moderation Model

Similar to the Hostel Finder approach:

- New organizers start in **PENDING** KYC status.
- They can create trips, but payouts are blocked until `VERIFIED`.
- Trips require admin approval before becoming bookable (optional but recommended for trust).
- All organizer actions are logged in `organizer_audit_logs`.

---

## 8. Technology & Reuse

vacationRide will continue to share the platform’s core infrastructure:

- Turso client, payment access tokens, observability, rate limiting.
- Paystack integration patterns (already used in campusRide and planned for Hostel Finder).
- New payout logic will closely mirror the `hostel_payouts` design.

---

## 9. Recommended Phased Rollout

| Phase | Focus | Key Deliverables |
|-------|-------|------------------|
| **Phase 1** | Organizer Foundation | `trip_organizers` table, organizer auth, KYC flow, payout account setup |
| **Phase 2** | Trip Self-Service | Organizer console, trip creation & management, commission calculation |
| **Phase 3** | Payouts | `organizer_payouts` table, daily 12:00 AM release job, Paystack Transfers, reconcile logic |
| **Phase 4** | Polish | Admin oversight tools, analytics, dispute handling |

---

## 10. Open Decisions

| Decision | Status |
|----------|--------|
| Exact KYC requirements for organizers | To be defined |
| Whether trips need admin approval before going live | Recommended but not yet confirmed |
| Maximum payout retry attempts and backoff strategy | To be defined in payout reconcile design |

---

This revised architecture positions **vacationRide** as a true marketplace while preserving its existing payment safety strengths.

---

**End of Revised vacationRide Architecture Overview**