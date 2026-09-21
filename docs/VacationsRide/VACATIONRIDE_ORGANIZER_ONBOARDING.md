# vacationRide — Trip Organizer Onboarding & KYC Flow

**Version:** 1.0  
**Status:** Draft for Review

---

## 1. Purpose

This document defines the onboarding and verification process for **Trip Organizers** in the new marketplace model of vacationRide. Organizers must go through a structured process before they can create trips and receive payouts.

---

## 2. Onboarding Stages

### Stage 1: Registration

- Organizer applies at the console (`/console/register`) with **name, phone,
  email, organization and password**. Email plus password is the credential, not
  phone: the console identity already works that way, and Resend is the
  platform's only messaging provider (there is no SMS channel).
- System creates a `console_accounts` row (role `ORGANIZER`, status `PENDING`)
  and a matching `trip_organizers` row (status `PENDING`).
- The application joins the review queue for an admin or moderator.

**Outcome:** A pending application. A `PENDING` account **cannot sign in**; the
console refuses it until a human approves it (decision D4). Approval sets
`console_accounts.status = ACTIVE` and `trip_organizers.status = APPROVED`
together, and suspension sets both to `SUSPENDED` and revokes live sessions.

---

### Stage 2: Payout Account Setup

- Organizer enters **mobile money** details. Rides pay out on the mobile money
  rail only: Paystack charges GHS 1.00 per mobile money transfer against
  GHS 8.00 per bank transfer, and the fee is deducted from the payout, so the
  cheaper rail is the one that leaves the organizer more of their fare.
  (Hostels keep both rails.)
- The form states the charges before the account is saved: the transfer fee that
  is deducted from each payout, the platform commission taken from each fare,
  and the fact that Paystack's checkout charge is paid by the passenger.
- Details are stored **masked** by default.
- Encryption is a single policy applied to every payout row, never an opt-in:
  a partly encrypted column means nobody can tell which rows are protected.
  The full number is shown only through an audited reveal action — built as
  ADMIN-only `POST /api/console/organizers/reveal`, which writes one audit row
  per call.
- System prepares for Paystack Recipient creation.

**Outcome:** Payout account is recorded but not yet active.

> **Storage note (decided; Phase 3 shipped).** No R2 or other file storage
> binding exists on this Worker today, so a document upload has nowhere to go.
> Until a bucket is bound, KYC records the ID type and number only, and any scan
> is handled out of band. Storing identity documents also needs a stated
> retention period, which does not exist yet — so the platform deliberately
> keeps no copy of the document.

---

### Stage 3: Trip Creation (Limited)

- Organizer can create scheduled trips (date, route, time, capacity, price).
- Trips are created in `DRAFT` state.
- Trips are **not visible** to students until approved.

**Outcome:** Organizer can prepare trips, but they are not live.

---

### Stage 4: KYC Verification

Organizers must submit:

- Ghana Card or Passport number (type + number until document storage exists)
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

Trip approval is **mandatory**, not optional: nothing an organizer writes is
bookable until a reviewer approves it.

**Built in Phase 3:** organizers create and submit their own trips (`POST
/api/console/trips`, `PATCH .../[tripId]`), a moderator or admin decides
(`PATCH .../[tripId]/review`), and editing an `APPROVED` trip returns it to
`PENDING_REVIEW` so a silent edit cannot bypass the review.

---

### Stage 6: Payout Activation

- Once `kyc_status = VERIFIED` and at least one trip has been approved, the organizer becomes eligible for payouts.
- The release job begins processing their earnings minutes after each booking is
  paid (twenty by default), as soon as the platform's settled balance can cover
  the transfer.

---

## 3. Trust Tiers

All four rows exist as data from Phase 3. `Can receive payouts` additionally
requires the Phase 4 ledger: KYC verification clears the eligibility gate but
does not move money on its own.

| Tier | Account status | KYC status | Can sign in | Can receive payouts | Notes |
|------|----------------|------------|-------------|---------------------|-------|
| Applicant | `PENDING` | — | No | No | Waiting for approval |
| Organizer | `APPROVED` | `PENDING` | Yes | No | Works own trips, prepares KYC |
| Verified | `APPROVED` | `VERIFIED` | Yes | Yes | Full access |
| Restricted | `SUSPENDED` | any | No | No | Ended live sessions, hides trips |

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
