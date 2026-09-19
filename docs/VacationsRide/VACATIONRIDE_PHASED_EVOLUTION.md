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
| 4 | Money and attribution | Commission at booking time, `organizer_payouts` ledger, organizer statement, admin-triggered payout batches | **Shipped** |
| 5 | Scale | Paystack Transfers, release + reconcile jobs, settlement gate | **Shipped** |
| 6 | Reach | Suspension and dispute handling, route-overlap warnings, analytics, rate limits on public trip reads | **Shipped** |

Phase 5 shipped the money-moving half of the original phase and the rest moved
to a new Phase 6, because "automate the transfers" and "build the trust and
insight surfaces" are different kinds of change: one moves money and needs the
strictest possible review, the other does not.

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

**Phase 4, as built.** One ledger row per confirmed booking, written at
confirmation time by whichever path confirms first — verification or the
Paystack webhook — with a unique booking index making the second write a no-op.
The commission base is the fare (`payments.fare_amount`), never
`bookings.amount`, which carries Paystack's pass-through charge; the rate is
copied onto the booking and the ledger row, so a later rate change cannot
rewrite what an organizer earned, and the owner is copied onto the booking at
creation for the same reason. `release_after` is the later of the next midnight
and departure + 24 hours. An administrator makes the transfer by hand and
records the reference, which releases every ready entry in one batch; Phase 5
replaces the human transfer with Paystack Transfers. Cancelling a booking
reverses its entry — un-earned if it was never released, a carried debt if it
was — and a batch is refused while a debt stands.

**Phase 5, as built.** The ledger now pays out. An entry in flight is its own
status (`PROCESSING`), because money that has left for Paystack has not arrived
yet and must not be released twice. The release job runs every fifteen minutes,
which cannot pay anyone early: `release_after` is still the gate, so running
more often only drains a backlog faster and keeps each run inside one
invocation's subrequest budget. Only the settled Paystack balance, less a
budgeted transfer fee, decides how much can go out in a run.

Unattended transfers are opt-in via `PAYOUT_AUTO_ENABLED`; a run started from
the console is attended and is not gated by it. A failed transfer returns its
entries to the ledger rather than turning them into a debt — the platform still
holds the money — and an entry that fails three times is parked as `FAILED`
until an administrator reopens it. A reversed transfer is likewise returned to
the ledger, because a reversal means the money came back, not that the
organizer stopped earning.

Because a Paystack recipient is addressed by a `bank_code`, Phase 5 also had to
capture one: `trip_organizers.payout_bank_code` and `payout_bank_name`, chosen
from Paystack's own catalogue with an offline fallback, and saving a different
account now retires the stored recipient so the next payout is re-addressed.

**Phase 6, as built.** Disputes now have a record of their own. A passenger may
open one against a booking made with their own account, an organizer against a
booking on one of their own trips, and only an administrator may resolve one —
a moderator reads the queue, because deciding it is a money-shaped judgement.
The route, the organizer and the trip are copied from the booking rather than
taken from the request, so a dispute cannot be pointed at someone else's row.

A decision records a decision, not a payment: `REFUND`, `PARTIAL_REFUND`,
`RELEASE_PAYOUT`, `NO_ACTION` and `OTHER` are resolution labels on the record,
and the money is still moved by the booking-cancel or payout paths, which own
the ledger. The console therefore never claims a refund happened; it says what
was decided and who decided it, with the note required whenever the dispute is
resolved.

Route overlaps are a warning, never a refusal. An organizer saving a trip is
shown every other live or pending departure on the same route and date within
three hours, their own included and marked as theirs, because a second coach on
a route is a real service but an organizer who does not know they are second is
being set up to run an empty one. The comparison is done on a normalised route
name in SQL, and a departure time that cannot be parsed produces no warning.

Analytics read the same ledger as the statement, so the numbers agree by
construction: seats sold against seats offered, and gross, net, accrued and
released money per trip. A trip with no recorded capacity reports no
sell-through rather than 100% sold. Finally, the three public trip reads carry
their own rate limits — 240/min for the schedule and display reads, 300/min for
the seat map — chosen so a campus address full of students is never metered,
only a flood is.

---

## 3. Dependencies Between Phases

```
Phase 1 ──► Phase 2 ──► Phase 3 ──► Phase 4 ──► Phase 5 ──► Phase 6
(shipped)   accounts   publish     money       automation  trust
            ownership  + KYC       ledger                  & insight
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
