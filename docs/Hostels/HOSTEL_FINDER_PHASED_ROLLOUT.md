# Hostel Finder — Phased Rollout Plan

**Version:** 1.0  
**Status:** Draft for Review

---

## Overview

This document breaks down the delivery of the Hostel Finder into clear, sequential phases with specific goals and acceptance criteria.

---

## Phase 1 — Foundation (No Money)

**Goal:** Enable landlords to create and manage properties, and allow students to discover listings.

### Deliverables
- Database schema (migration 014)
- Landlord authentication (registration, login, session)
- Property, Room, and Space CRUD (landlord-scoped)
- Global Academic Period catalogue (admin only)
- Listing creation with `DRAFT → PENDING_REVIEW → APPROVED` workflow
- Admin approval interface
- Student-facing read-only discovery (browse, filter, map)
- Basic landlord console UI

### Acceptance Criteria
- A landlord can register, log in, and create a property with rooms and spaces.
- A landlord can create a listing attached to a period.
- An admin can review and approve the listing.
- A student can browse approved listings on a map and see details.
- No payment or booking functionality exists yet.

**Estimated Complexity:** Medium

---

## Phase 2 — Booking & Inbound Payments

**Goal:** Allow students to book bed-spaces and complete payment.

### Deliverables
- Atomic space claiming logic (`claimHostelSpace`)
- Booking creation with 10-minute payment hold
- Paystack integration (initialize, webhook, verification)
- Payment record + access token pattern (reused from campusRide)
- Image ticket generation on successful payment
- Expiry release job (releases unpaid holds)
- Utilities fee calculation when enabled

### Acceptance Criteria
- A student can select a space and initiate a booking.
- The system prevents overselling of spaces (atomic claim).
- Payment via Paystack works end-to-end.
- Successful payment confirms the booking and generates a ticket.
- Expired unpaid bookings release the space automatically.

**Estimated Complexity:** High (most critical phase)

---

## Phase 3 — Payouts & Trust

**Goal:** Enable landlords to receive money and establish trust mechanisms.

> **Status (as built).** This phase is complete. The ledger, the release policy,
> KYC gating, payout account masking with an audited reveal, and the admin
> release interface are implemented: `/api/console/hostel/payouts`,
> `/api/console/hostel/payout-account` and `/api/console/hostel/statement`, with
> the landlord's money tab in the residents workspace and the admin payout desk
> under Hostel Finder → Payouts. Money leaves through Paystack: `action: "SEND"`
> claims the payable entries, creates a transfer recipient once per account,
> initiates the transfer, and releases the entries when it settles — inline,
> through the `transfer.*` webhook, or through the reconcile job on the payout
> cron. A refused transfer returns the entries to the ledger with the reason and
> an attempt count, and an unattended release only runs when the switch is on:
> an administrator turns it on under **Console > Platform settings**
> (`platform_settings.hostel_payout_auto`, audited), and
> `HOSTEL_PAYOUT_AUTO_ENABLED` remains the fallback for a deployment that never
> opens that page. Recording a transfer by hand stays available.
> Listing photos upload to the private R2 bucket and are moderated before
> anything public shows them (`018_hostel_photos`, `lib/hostel-engine/photos.ts`).

### Deliverables
- Payout ledger (`hostel_payouts`)
- Paystack Transfer / Recipient integration
- Payout release policy (`starts_on − 3 days` + admin override)
- Reconcile job for failed/stuck transfers
- Landlord KYC + recipient onboarding flow
- Payout account masking + audited reveal
- R2 photo upload for listings
- Admin payout release interface

### Acceptance Criteria
- A confirmed booking automatically creates a payout record.
- Admin can release funds to the landlord via Paystack Transfer.
- Failed transfers are retried automatically.
- Landlord payout accounts are masked by default.
- Photos can be uploaded and moderated.

**Estimated Complexity:** High

---

## Phase 4 — Polish & Advanced Features

**Goal:** Improve user experience and add advanced capabilities.

**Status: delivered.** The chat transport is a bounded server-sent event stream
over the durable Turso thread rather than Ably — the same observable behaviour
(a reply appears within seconds) without a second vendor, a second credential
or a second bill. Every refund is a request a person decides, never an
automatic payout.

### Deliverables
- Chat system (Turso persistence + bounded SSE stream; Ably not needed)
- AI assistant (public "ask about this hostel" over the listing's own facts)
- Student reviews and ratings (one per paid stay, hostel replies once)
- Fraud detection signals (seven rules, reviewed by a person)
- Cancellation / refund policy engine (30-day / 7-day tiers, admin override)
- Analytics dashboard for admin (`/console/hostels/analytics`)
- Push notifications for new messages, bookings, refunds, reviews and payouts
  (Resend email plus the in-app outbox; no SMS provider)

### Acceptance Criteria
- Students and landlords can communicate in real-time via chat. ✅ The stream
  pushes a change event within seconds; the thread itself stays the source of
  truth and the fallback is the page's own refresh.
- AI can answer basic questions about properties. ✅ Bounded to one listing's
  public facts, rate-limited, and answered from a written summary when Workers
  AI is not configured.
- Students can leave reviews after their stay. ✅ Paid stay only, one review per
  booking, staff may hide with a reason and the audit records why.
- Admin has visibility into key platform metrics. ✅ Occupancy, the booking
  pipeline, money in/out, reviews and supply signals.

### As-built surfaces
- Tables: `hostel_reviews`, `hostel_risk_signals`, `hostel_refunds`.
- Student: `/api/hostel/reviews`, `/api/hostel/refunds`, `/api/hostel/ask`,
  `/api/hostel/messages/stream`.
- Console: `/console/hostels/reviews`, `/refunds`, `/analytics`, `/signals`,
  and the `/api/console/hostel/*` routes behind them.
- Refunds ride the payout reconcile cron (`runHostelRefundReconcile`) and the
  `refund.*` Paystack webhook; the booking reaches `REFUNDED` only when the
  money is back.

**Estimated Complexity:** Medium

---

## Phase Dependencies

```
Phase 1 ──► Phase 2 ──► Phase 3 ──► Phase 4
     │           │           │
     └───────────┴───────────┘
         (Chat can start here)
```

Chat integration can begin during **Phase 2** (once bookings exist) but is not required until Phase 4.

---

## Risk & Mitigation

| Risk | Phase | Mitigation |
|------|-------|------------|
| Atomic claim race condition | Phase 2 | Reuse proven `claimCampusQueueSlot` pattern + tests |
| Paystack transfer failures | Phase 3 | Reconcile job + manual retry path from day one |
| Fake listings | Phase 1 & 3 | Mandatory photo upload + approval workflow |
| Payout disputes | Phase 3 | Full audit trail + chat history preserved |

---

**End of Phased Rollout Plan**
