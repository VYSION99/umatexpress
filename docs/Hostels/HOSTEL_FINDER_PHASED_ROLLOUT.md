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

### Deliverables
- Chat system (Ably + Turso persistence)
- AI assistant (property recommendations, availability questions)
- Student reviews and ratings
- Fraud detection signals
- Cancellation / refund policy engine
- Analytics dashboard for admin
- Push notifications for new messages and booking updates

### Acceptance Criteria
- Students and landlords can communicate in real-time via chat.
- AI can answer basic questions about properties.
- Students can leave reviews after their stay.
- Admin has visibility into key platform metrics.

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