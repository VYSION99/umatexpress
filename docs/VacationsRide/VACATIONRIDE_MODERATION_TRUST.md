# vacationRide — Moderation & Trust Model (Marketplace)

**Version:** 1.0  
**Status:** Draft for Review

---

## 1. Trust Philosophy

In the new marketplace model, **vacationRide** operates on a "Trust but Verify" principle:

- Trip organizers are empowered to create and manage their own trips.
- The platform acts as a **gatekeeper** through KYC, trip approval, and payout controls.
- All financial movements are **auditable** and reversible where necessary.

---

## 2. Organizer Trust Tiers

There are **two gates, not one**, and they belong to different phases:

| Gate | Values | Decided by | Applies from |
|------|--------|-----------|--------------|
| Account approval | `PENDING → ACTIVE → SUSPENDED` on `console_accounts`, mirrored as `PENDING → APPROVED → SUSPENDED` on `trip_organizers` | Admin or moderator | Phase 2 |
| Payout readiness (KYC) | `PENDING → VERIFIED / REJECTED` on `trip_organizers.kyc_status` | Admin (moderator may also review) | Phase 3 — built |

A `PENDING` account cannot sign in at all, so "limited trip creation while
pending" does not exist. Once approved, the organizer works their own trips; KYC
only ever decides whether money may leave. This keeps one trust decision per
phase instead of two at once.

Recording a payout is a third, narrower decision and it is **ADMIN-only**: a
moderator may approve an organizer and verify KYC, but only an administrator
can release money, and only for an organizer whose KYC is `VERIFIED`.

The tier table lives in `VACATIONRIDE_ORGANIZER_ONBOARDING.md` and is not
duplicated here.

---

## 3. Trip Lifecycle & Moderation

```
DRAFT          → PENDING_REVIEW   (organizer submits)
PENDING_REVIEW → APPROVED         (reviewer approves)
PENDING_REVIEW → REJECTED         (reviewer rejects, with a reason)
REJECTED       → PENDING_REVIEW   (organizer edits and resubmits)
APPROVED       → SUSPENDED        (an admin pulls a live trip)
SUSPENDED      → PENDING_REVIEW   (re-review, never straight back to APPROVED)
```

| State | Description | Visible to Students? | Can Receive Bookings? |
|-------|-------------|----------------------|-----------------------|
| `DRAFT` | Organizer is editing | No | No |
| `PENDING_REVIEW` | Submitted for admin review | No | No |
| `APPROVED` | Live and bookable | Yes | Yes |
| `REJECTED` | Sent back with a reason; the organizer edits and resubmits | No | No |
| `SUSPENDED` | Temporarily removed | No | No |

`REJECTED` and `SUSPENDED` are different states on purpose: a rejected trip was
never live and needs edits, while a suspended trip was live and was pulled. A
suspended trip returns to `PENDING_REVIEW`, never straight to `APPROVED`.

**Moderation Triggers:**
- New organizer’s first trip
- Significant price changes
- Multiple complaints
- High booking volume in short time

---

## 4. Fraud Prevention Measures

### 4.1 Duplicate Detection
- Phone number uniqueness on `trip_organizers`.
- Same organizer creating many similar trips triggers review.

### 4.2 Pricing Abuse
- Sudden large price increases on popular routes are flagged.
- Unrealistically low prices (potential bait-and-switch) are reviewed.

### 4.3 Booking Abuse
- One phone number can only hold a limited number of active bookings per organizer.
- Rapid booking + cancellation patterns are monitored.

### 4.4 Payout Monitoring
- High volume of payouts to the same recipient in a short period triggers manual review.
- Sudden change in payout account requires re-verification.

---

## 5. Admin Intervention Capabilities

Admins can:

| Action | Scope | Audit Required? |
|--------|-------|-----------------|
| Approve / Reject trip | Trip | Yes |
| Suspend organizer | Organizer + all trips | Yes |
| Hold or release payout | Payout | Yes |
| View full payout account | Organizer | Yes (masked by default) |
| Force-cancel booking | Booking | Yes |
| Refund student | Booking | Yes |

All actions are logged in the platform audit table (`admin_audit_logs`) with the
console account, its role and the target as columns. There is one audit history,
not one per role.

## 5.1 Passenger contact data

Decision D3 lets an organizer see the phone number of the student who booked a
seat. Bookings are student-only (`requireStudent`), so that number is the
**booking student's**, which is not necessarily the person travelling. The
following rules travel with the data:

- A manifest read returns contacts for the organizer's own trips only, and every
  read writes an audit row naming the console account and the trip.
- The console shows the number for the working manifest, never as a bulk export.
- Suspending an organizer removes manifest access immediately, because the
  session is revoked and the trip list is scoped from the session.
- Contacts are retained only while the trip record is, and are deleted with it.
  They are never used for marketing.

---

## 6. Dispute Resolution (as built)

1. A student raises a dispute against a booking made with their own account
   (`POST /api/disputes`), or an organizer against a booking on one of their
   own trips (`POST /api/console/disputes`, `action: "OPEN"`).
2. The record copies the trip and organizer from the booking rather than from
   the request, and the ownership check runs before anything is written, so a
   dispute cannot be filed against someone else's row.
3. An administrator reviews the record and decides it, with the note required
   whenever the status becomes `RESOLVED`. A moderator reads the queue and
   cannot decide it.

Categories are `BOOKING`, `REFUND`, `TRIP_CANCELLED`, `DELAY`, `CONDUCT`,
`PAYMENT` and `OTHER`; statuses are `OPEN`, `REVIEWING`, `RESOLVED` and
`DISMISSED`; resolutions are `REFUND`, `PARTIAL_REFUND`, `RELEASE_PAYOUT`,
`NO_ACTION` and `OTHER`.

**A decision is not a payment.** The resolution records what was decided, and
money is still moved by the paths that own the ledger — cancelling the booking
for a refund, a payout run for a release. Keeping the two apart means the
dispute trail can never claim a refund that no ledger row supports.

---

## 7. AI-Assisted Moderation (Future)

- Detect suspicious pricing patterns
- Flag duplicate or low-quality trip descriptions
- Auto-translate organizer communications
- Summarize long dispute threads

---

**End of vacationRide Moderation & Trust Model**
