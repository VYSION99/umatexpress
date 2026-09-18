# vacationRide — Trip Organizer Onboarding & KYC Flow

**Version:** 1.0  
**Status:** Draft for Review

---

## 1. Purpose

This document defines the onboarding and verification process for **Trip Organizers** in the new marketplace model of vacationRide. Organizers must go through a structured process before they can create trips and receive payouts.

---

## 2. Onboarding Stages

### Stage 1: Registration

- Organizer registers using phone number + password.
- System creates a `trip_organizers` record with `kyc_status = PENDING`.
- Organizer gains access to a limited organizer console.

**Outcome:** Basic login access, but cannot receive payouts.

---

### Stage 2: Payout Account Setup

- Organizer enters bank or MoMo details.
- Details are stored **masked** by default.
- Organizer may opt-in to encryption of their payout account.
- System prepares for Paystack Recipient creation.

**Outcome:** Payout account is recorded but not yet active.

---

### Stage 3: Trip Creation (Limited)

- Organizer can create scheduled trips (date, route, time, capacity, price).
- Trips are created in `DRAFT` state.
- Trips are **not visible** to students until approved.

**Outcome:** Organizer can prepare trips, but they are not live.

---

### Stage 4: KYC Verification

Organizers must submit:

- Ghana Card or Passport
- Proof of business / transport operation (optional but recommended)
- Any additional compliance documents required by the platform

Admin reviews and updates `kyc_status` to `VERIFIED` or `REJECTED`.

**Outcome:** 
- If verified → Organizer can receive payouts.
- If rejected → Organizer is notified with reason.

---

### Stage 5: Trip Activation

- Organizer submits a trip for review.
- Admin reviews the trip details (route, pricing, schedule).
- If approved, trip status changes to `APPROVED` and becomes bookable.

**Outcome:** Trip is live and students can book.

---

### Stage 6: Payout Activation

- Once `kyc_status = VERIFIED` and at least one trip has been approved, the organizer becomes eligible for payouts.
- Daily payout job (12:00 AM) begins processing their earnings.

---

## 3. Trust Tiers

| Tier | KYC Status | Can Create Trips | Can Receive Payouts | Notes |
|------|------------|------------------|---------------------|-------|
| New | `PENDING` | Yes (limited) | No | Must complete KYC |
| Verified | `VERIFIED` | Yes | Yes | Full access |
| Trusted | `VERIFIED` + Good history | Yes | Yes + Faster release | Reduced admin oversight |
| Restricted | Flagged / Rejected | No | No | Requires manual review |

---

## 4. Re-verification Triggers

Organizers may be asked to re-verify if:

- Multiple student complaints or disputes
- Sudden change in payout account
- High volume of bookings in a short period
- Platform detects suspicious activity

---

## 5. Admin Oversight

Admins should have dedicated views for:

- Pending KYC reviews
- Pending trip approvals
- Flagged organizers
- Payout account change requests (with audit trail)

---

**End of Trip Organizer Onboarding Document**