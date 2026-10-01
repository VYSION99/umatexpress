# Hostel Finder — Student feature milestones

**Created:** 30 September 2026
**Status:** M1–M2 and M3.1–M3.2 implemented behind default-off switches; pilots pending. M3.3 gated; M4–M6 planned
**Scope:** Six additions to Hostel Finder and the student residency workspace
**Related plan:** [Core phased rollout](HOSTEL_FINDER_PHASED_ROLLOUT.md)

This plan continues the core rollout's Phases 1–4. M1–M6 are the six new student feature milestones; they are not claims that all six features are deployed. Each milestone includes the student experience, staff workflow, authorization, and release checks.

## Roadmap at a glance

| Phase | Milestone | Student outcome | Main prerequisite | Status |
| --- | --- | --- | --- | --- |
| **5 — Resident care** | **M1: Maintenance requests** | Report a fault and track its resolution | Residency ownership and staff access | Implemented locally; pilot pending |
| 5 — Resident care | **M2: Move-in condition records** | Record room condition and inventory with staff acknowledgment | M1 private attachments and activity history | Implemented locally; pilot pending |
| **6 — Stay management** | **M3: Renewals and room-change requests** | Ask to stay another year or move to another bed | Existing audited transfers; availability scoped to academic year for renewals | M3.1–M3.2 implemented behind default-off switches; M3.3 gated; pilot pending |
| 6 — Stay management | **M4: Resident and visitor passes** | Verify residency at reception and request an approved visit | Current occupancy, staff verification screen, property visitor rules | Planned |
| **7 — Community and convenience** | **M5: Roommate matching** | Find a compatible roommate through mutual agreement | Verified student accounts, consent controls, available room information | Planned |
| 7 — Community and convenience | **M6: Parcel collection** | Know when a parcel arrives and collect it with a pickup code | Reception workflow and reusable verification controls from M4 | Planned |

**Delivery order:** M1 → M2 → M3 → M4 → M5 → M6. This is the preferred release order, not a claim that every milestone technically depends on the previous one. M5 can be developed independently once its account and privacy controls are ready; M6 should reuse M4's verification controls.

No delivery dates are committed here. Size and schedule each milestone when implementation starts, after its dependencies and property operating rules have been checked.

## Foundation and shared experience

The recent residency work supplies booking ownership, separate payment and occupancy statuses, audited check-in/checkout and equal-price transfers, paginated staff records, student current/history views, messages, and confirmation dialogs. At the time this plan was written, that work was implemented and tested locally but not yet committed or deployed. Verify its release before piloting these milestones.

- Keep the student's **Overview / Requests / Messages / Payments** navigation. Add a compact **Quick actions** sheet showing only features enabled for their property and account.
- Use a short form followed by a review step for each request. On phones, use bottom sheets with an internally scrolling body; on desktop, use dialogs or a detail drawer. Preserve drafts when a recoverable network error occurs.
- Group staff work by **Resident care**, **Stay requests**, and **Reception**. Use searchable, filtered pages with up to 20 records; record details and actions open in a panel.
- Provide an audited platform enable/disable control for each feature and a property setting for owners to opt in and configure supported workflows. Managers operate within their existing authorized hostel scope. Enforce enablement and access on the server.
- Disabling a feature stops new requests while retaining authorized access to existing records and the staff actions needed to close them.
- Reuse the existing notification outbox and supported delivery channels. Show request status in the app; do not make browser push delivery a prerequisite.
- Extend the AI assistant one milestone at a time: explain the workflow, help prepare a request, show only authorized records, and route unresolved questions to staff. The student reviews and confirms before a request is submitted. AI does not approve a transfer, change a price, or grant access.
- Update student help, staff help, AI reference content, and page captures when a milestone actually launches. Keep planned capabilities out of current-feature claims.

## Phase 5 — Resident care

### M1 — Maintenance requests

**Implementation record:** M1.1–M1.4 implemented. M1.5 local verification completed; physical-device checks, live delivery/storage verification and a property pilot remain pending. Both enablement switches default off. See [M1 guide and operations record](HOSTEL_MAINTENANCE_M1.md).

**Goal:** Give students a reliable way to report a building or room fault and follow the response.

**Student journey:** Quick actions → Report a problem → location and category → description and optional photos → review and submit → request timeline.

**Deliverables**

- Categories for water, electricity, plumbing, furniture, internet, and other faults; room/bed or shared-area location; urgency; preferred access times and entry permission where applicable.
- Private attachments linked to the report, with file validation, access checks, and short-lived authorized access. Reuse existing storage infrastructure without publishing maintenance photos in the property gallery.
- Staff queue filtered by property, category, urgency, assignee, and status. Owners/managers assign only authorized hostel staff and record acknowledgment, progress, and completion notes.
- Lifecycle: `SUBMITTED → ACKNOWLEDGED → IN_PROGRESS → RESOLVED → CLOSED`, with `WAITING_FOR_STUDENT`, reopening, and cancellation where appropriate. Preserve every transition and actor in the activity history.
- Student confirmation of resolution or reopening with an explanation. Reporters can continue an existing ticket after checkout; new resident fault reports require an eligible current stay.
- Host-configured service hours and acknowledgment targets, overdue indicators, and staff escalation. An urgency flag must not be presented as a guaranteed emergency response; show the hostel's verified urgent contact where configured.

**Implementation slices**

| Slice | Work | Reviewable result |
| --- | --- | --- |
| M1.1 | Request records, access rules, state transitions, and enablement | Student ownership and staff permissions enforced by the API |
| M1.2 | Student reporting form, private attachments, and request timeline | One complete report can be submitted and followed on mobile |
| M1.3 | Staff queue, assignment, notes, and resolution actions | Staff can process the report from arrival to closure |
| M1.4 | Notifications, AI guidance, and updated help | Students understand who is handling the issue and what happens next |
| M1.5 | Integration checks, responsive QA, and a controlled property pilot | The full workflow is ready for wider release |

**Done when**

- A student submits once even if they retry after a lost response; repeated submissions cannot create accidental duplicate tickets.
- Another student or another hostel cannot read the report or its photos, including through a guessed attachment URL.
- Staff changes are authorized, audited, and protected against conflicting edits. A student can reopen an unresolved report.
- The mobile form, staff queue, notifications, and upload-failure recovery work end to end.

**Boundary:** Maintenance reporting is a resident-support workflow. It does not activate the existing paid service add-on catalogue, which remains under its separate product-policy hold.

### M2 — Move-in condition records

**Implementation record:** Student and staff workflows, versioned evidence, private photos, atomic transfer handovers, checkout comparison and authenticated downloads are implemented. Local verification is complete; deployment, live storage/email checks, physical-device validation and a property pilot remain pending. See [M2 user and operations guide](HOSTEL_CONDITIONS_M2.md).

**Goal:** Give students and staff a shared record of the room's condition at handover and checkout.

**Deliverables**

- Staff-configured inventory/checklists covering the bed, mattress, furniture, locks, sockets, and relevant shared facilities.
- A move-in record linked to the booking and actual room/bed, with item condition, notes, private photos, and server-recorded submission times.
- Student submission, staff acknowledgment, requests for clarification, and a visible disagreement state. Acknowledgment records receipt; an unresolved disagreement remains visible.
- Versioned amendments so original evidence is preserved. Transfers create a new room handover record while retaining the old one.
- Checkout comparison with the earlier record and a downloadable summary for authorized participants. Closing the record does not create a charge or issue a refund.

**Done when**

- Both parties see the same version and can identify who submitted, acknowledged, or amended each item.
- A room transfer preserves the previous room's evidence and starts the correct destination record.
- Upload retries preserve form progress; private evidence is inaccessible outside the authorized booking/staff scope.

**Depends on:** M1 attachment authorization and activity-history patterns, plus the existing arrival and checkout records.

## Phase 6 — Stay management

### M3 — Renewals and room-change requests

**Implementation:** [M3 stay plans guide and release record](HOSTEL_STAY_PLANS_M3.md). Equal-price moves and renewals are implemented locally behind default-off switches. Different-price moves remain gated.

**Goal:** Let students request a change or another academic year without repeated messages or conflicting bookings.

**Deliverables**

- **M3.1 — Student room-change requests:** choose an available destination or explain a preference; staff review and approve/decline with a reason. Initially fulfill approved equal-price moves through the existing audited transfer workflow.
- **M3.2 — Next-year renewals:** show an owner-configured renewal window, the approved next-year rate and utilities, offer expiry, and a full confirmation summary. An accepted offer uses the normal verified checkout flow and creates a booking for the new academic year.
- **M3.3 — Different-price moves:** allow a quoted difference only after top-up, refund/credit, and payout-ledger handling are defined and implemented. Freeze the accepted quote; re-quote material changes and require the student's acceptance. Do not enable these offers before the money workflow is ready.
- Request states distinguish submission, staff review, offer, student acceptance, payment pending where needed, fulfillment, decline, cancellation, and expiry.
- Renewals require availability and claims scoped to the academic year. A bed occupied this year may be reserved for next year without being freed now; competing next-year bookings must still be blocked.

**Done when**

- A student cannot hold two active beds for the same academic year or accept an expired/stale offer.
- Simultaneous acceptance/payment cannot sell a destination twice. Failed or abandoned payment leaves the current residency intact.
- A future-year renewal does not change current physical occupancy. Checkout from the current stay does not erase the future reservation.
- Same-year transfers preserve history, record key handover, and update occupancy atomically.
- Any enabled price-difference workflow reconciles payment, refund/credit, commission, and landlord ledger entries without overwriting the original payment record. Bed pricing within a room continues to follow the shared annual rate rule.

**Policy checkpoint:** Resolve renewal windows, cancellation treatment, and price-difference settlement before enabling the affected offer types. M3.1 can ship while renewal inventory and money changes are being completed.

### M4 — Resident and visitor passes

**Goal:** Make reception verification quick while keeping access under hostel control.

**Deliverables**

- A resident card with a short-lived QR token. An authorized reception screen verifies current residency and displays only the information needed for that check.
- Visitor requests with host resident, visitor details, visit window, and the property's approval rules. Staff can approve, decline, revoke, and record arrival/departure.
- Signed or opaque verification tokens with expiry and server-side revocation. QR contents must not expose a student's phone number, email, or room details directly.
- A staff lookup fallback for students who cannot display the code. Unavailable verification must not be shown as successful verification.
- Checkout, cancellation, suspension, and visitor expiry revoke the relevant permissions.

**Done when**

- An expired or revoked pass cannot verify successfully, and a visitor arrival action cannot be redeemed twice.
- Another hostel or an unsigned scanner cannot retrieve resident details.
- Staff can record visitor arrival/departure and revoke a visit with an audit trail.

**Boundary:** These are reception verification passes. Physical door unlocking would require a separate access-control integration and project.

## Phase 7 — Community and convenience

### M5 — Roommate matching

**Goal:** Help students make an informed, voluntary roommate choice.

**Deliverables**

- An optional profile using student-entered preferences such as sleep schedule, study environment, tidiness, and quiet-time expectations.
- Explainable suggestions, starting with straightforward preference matching. Show why a suggestion appears and which preferences remain unknown.
- Mutual interest requests, controlled introduction/contact sharing, blocking, reporting, and withdrawal from matching.
- Limit discovery to eligible students and the selected academic year/property pool. Exact room location and contact details remain private until the appropriate consent step.
- A shared-room preference request for staff review. Matching does not reserve a bed, override a hostel rule, change a price, or bypass individual booking/payment.

**Done when**

- A student can opt out and disappear from new discovery results.
- Contact details are disclosed only after mutual agreement; blocked users cannot continue matching or contacting through this feature.
- Suggestions handle unavailable rooms and unmatched preferences without promising a guaranteed placement.
- Staff can process reports within their authorized scope and record moderation decisions.

**Depends on:** Verified accounts, defined discovery/consent rules, and accurate available-room information. Staff staffing and reporting ownership must be agreed before the pilot.

### M6 — Parcel collection

**Goal:** Let students know when reception receives a delivery and make collection traceable.

**Deliverables**

- A reception register for recipient, arrival time, parcel reference, storage location, and collection status.
- A notification and private collection screen with opening hours and a one-time pickup code stored securely and scoped to the parcel/property.
- Lifecycle: `RECEIVED → READY_FOR_COLLECTION → COLLECTED`, with exception states for an unknown recipient, returned parcel, or collection issue.
- Atomic code redemption, code reissue with invalidation of the old code, and an audited staff fallback verification process.
- Overdue reminders and a retained collection record showing the staff member and collection time. Release only at properties with a staffed parcel reception process.

**Done when**

- Two simultaneous redemption attempts cannot collect the same parcel twice.
- Expired/replaced codes and codes from another property fail without exposing recipient information.
- Students see only their parcels; staff can correct a mistaken recipient before collection with an audit record.
- An unknown or departed recipient enters an exception workflow rather than an unrelated student's inbox.

**Depends on:** Reception access and verification patterns from M4. A resident's permanent card is not itself a parcel pickup code.

## Release and completion record

For each milestone, record implementation, verification, pilot, and deployment separately. A local build is not a production launch.

A milestone is ready to pilot when its student and staff journeys work together, required database changes are repeatable, permission and conflicting-update cases pass, and mobile and desktop flows have been checked. Test at 320/390, 768, 1024, and 1440 pixels; include actual Safari on iOS and Chrome on Android before broad mobile release. Viewport emulation alone does not establish device compatibility.

Pilot with an enabled property that has named staff responsible for the queue. Track completion rates, response times, failed/retried submissions, reopened cases, and operational exceptions. Review the pilot before enabling additional properties. Turning off a feature must preserve records and allow existing work to be resolved.

The next M1 release task is a controlled deployment and property pilot after review, including physical-device and live delivery/storage checks. M2 is also implemented locally with its rollout gates off; complete its pilot checks before wider enablement. M3 remains the next feature implementation milestone.
