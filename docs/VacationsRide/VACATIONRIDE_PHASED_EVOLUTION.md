# vacationRide — Phased Evolution (Marketplace Model)

**Version:** 1.0  
**Status:** Draft for Review

---

## 1. Current State vs. Target State

| Aspect | Current (v1) | Target (Marketplace v2) |
|--------|--------------|--------------------------|
| Trip Creation | Admin-managed | Organizer self-service |
| Revenue Model | Platform keeps 100% | Platform takes 3%, organizer gets 97% |
| Payouts | None | Ledger + manual admin batches, then daily Paystack Transfers at 12:00 AM |
| Trust Model | Basic admin control | KYC + trip approval + payout gating |
| Organizer Console | None | Organizer surfaces inside the existing `/console/*` console |

---

## 2. Phased Rollout

**One phase numbering, defined once.** `ORGANIZER_SELF_SERVICE_ARCHITECTURE.md`
owns the phase list; this document and `VACATIONRIDE_ARCHITECTURE.md` refer to
it instead of keeping a second, conflicting set of numbers. Earlier drafts of
this file numbered the phases differently, which made "Phase 2" mean two things.

| Phase | Focus | Key deliverables | Status |
|-------|-------|------------------|--------|
| 1 | Console identity | `console_accounts`, one sign-in, host boundary, role guards | **Shipped** |
| 2 | Organizer accounts and ownership | Registration + approval, `trip_organizers`, trip ownership and manifest, per-organizer notice | **Shipped** |
| 3 | Self-service trip publishing | Organizer trip create/edit, review workflow, KYC and payout-account capture, public listing by organizer | **Shipped** |
| 4 | Money and attribution | Commission at booking time, `organizer_payouts` ledger, organizer statement, admin-triggered payout batches | Planned |
| 5 | Scale | Paystack Transfers, daily job + reconcile, suspension and disputes, analytics | Planned |

The 3% commission is calculated and stored at booking confirmation from Phase 4
on. KYC and payout-account capture sit in Phase 3 because they are prerequisites
for money, not for publishing a trip.

**Phase 3 decisions, as built.** A trip is written `DRAFT` and inactive;
`active = 1` is set by the approving statement and by nothing else. Organizers
submit, admins and moderators approve or reject with a reason, and only an admin
may suspend a live trip. Editing an `APPROVED` trip returns it to
`PENDING_REVIEW` and turns `active` off in the same statement, because a review
rule that exempts edits is not a review rule. KYC records an ID type and number
only — no scan is uploaded, since no object storage is bound and identity
documents need a retention policy first. Payout accounts are captured sealed
(AES-GCM) with the last four digits stored for the mask, and the full number is
read back only through an audited admin reveal. Capturing a payout account is
not payout eligibility: KYC and the Phase 4 ledger remain separate gates.

---

## 3. Dependencies Between Phases

```
Phase 1 ──► Phase 2 ──► Phase 3 ──► Phase 4 ──► Phase 5
(shipped)   accounts   publish     money       automation
            ownership  + KYC       ledger
```

The order is a safety property, not a preference: money must not be attributed
before ownership exists, KYC and payout accounts must exist before any payout,
and manual payout batches must be proven before transfers run unattended.

---

## 4. Risk Mitigation

| Risk | Phase | Mitigation |
|------|-------|------------|
| Organizer fraud | 2 & 3 | Approval gate, trip review, KYC + payout account verification |
| Incorrect commission calculation | 4 | Store commission per booking at confirmation time |
| Failed transfers | 5 | Reconcile job + manual retry path |
| Admin overload | Phase 2 & 3 | Tiered trust model + auto-approval for trusted organizers |

---

## 5. Non-Goals (This Evolution)

- Real-time matching (belongs to campusRide)
- Bed-space / annual bookings (belongs to Hostel Finder)
- Chat system (can be added later, shared with Hostel Finder)

---

**End of vacationRide Phased Evolution**
