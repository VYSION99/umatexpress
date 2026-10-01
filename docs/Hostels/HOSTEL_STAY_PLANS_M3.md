# M3 — Stay plans: room changes and renewals

**Implemented:** 1 October 2026. Platform and property switches default off; a property pilot remains pending.

M3.1 equal-price room changes and M3.2 next-year renewals are implemented. M3.3 different-price moves remain disabled: top-up, refund/credit and ledger policy must be agreed and implemented before those offers can be made. This is an explicit roadmap checkpoint, not an available payment feature.

## Student guide

1. Open **My Hostel Residency → Requests → Stay plans** for your current paid stay.
2. Choose **Request room change** or **Request renewal**. A renewal also needs an open hostel renewal window. Choose an available bed or describe a preference. Review before sending.
3. Open the request to read staff's offer: destination, academic year and dates, annual rent per student, utilities, total, and acceptance deadline. The request and offer do not hold a bed.
4. Review and accept before expiry. Staff must send a fresh offer if the price, assignment or relevant configuration changes. Only the student can accept.
5. For a room change, arrange key handover with staff. Both rent and utilities must match the existing booking. Staff complete the audited transfer; no new charge or refund is created.
6. For a renewal, accept and use **Continue to secure payment**. Normal checkout holds the new-year bed for ten minutes. Only verified payment completes the renewal. It creates a separate booking and payout accrual; the current-year stay continues.

Cancel a request before checkout or completed handover. Once renewal checkout starts, use that booking's payment status and existing cancellation/refund workflow. Do not pay twice while verification is pending. A late or mismatched payment goes to platform review. An expired hold can release only its own academic-year claim.

The existing cancellation schedule is reused: 100% at least 30 days before the booked year, 50% at 7–29 days, and 0% within the final 7 days or after commencement. Administrator exceptions require review and a reason. Approval and completed refund settlement remain separate.

Requests and history remain accessible after checkout or disabling new requests. A recoverable error preserves the draft while the popup remains open. Repeating an unchanged submission uses the same mutation key; reload or closing the form does not persist unsent drafts.

## Hostel staff guide

- Open **Residents & Services → Stay plans**. Choose a property and filter open/all requests. The queue has 20 records per page; details and actions open in a drawer.
- The owner opens **Request settings** to enable moves and/or renewals. Choose an active future academic year and dates that close before it starts. Dates use Ghana time (UTC). Managers operate requests, but cannot change these settings.
- Set the room's uniform annual rate for the target year and submit its listings for approval. Single-room and bulk pricing/submission support beds occupied in a different, earlier year.
- Review the student's requested bed or written preference. Search approved destinations, choose a bed, add a reason and set an offer expiry within 14 days and before the renewal window/current year ends.
- An offer is not a reservation. Another student can take the bed before acceptance or handover. A failed availability check requires a new offer or destination; never promise a guaranteed bed from an unaccepted offer.
- Staff may replace an offer, including an accepted room-change offer. This resets it to **Offer ready** and requires fresh student acceptance.
- Complete accepted moves with a handover note, confirmation that an issued old key was returned, and the new key reference if one is issued. Transfer, assignment history, room condition handover and request completion commit together.
- Renewal checkout belongs to the student. Staff cannot accept or pay on their behalf through this workflow. Do not request another payment while the booking needs verification or review.

## State and financial safeguards

| State | Meaning / next step |
| --- | --- |
| Submitted / Under review | Staff review the preference; no inventory held. |
| Offer ready | Frozen destination/rent/utilities and deadline; student must accept. |
| Accepted | Equal-price move accepted; staff arrange and record handover. |
| Payment pending | Renewal checkout started; verification is required. |
| Payment needs review | Late/mismatched payment needs platform resolution. |
| Completed | Move completed atomically, or renewal payment verified. |
| Declined / Cancelled / Expired | Terminal request history; another request may be made if eligible. Payment review can reopen an expired renewal's financial attention state. |

`hostel_bed_claims` owns the academic-year reservation. Database constraints enforce one claim per bed/year and per identified student/year, including normal booking entry points. Booking/stay triggers acquire, move and release claims in the same transaction as the underlying booking or departure.

Physical status remains on `hostel_spaces`. Reserving or paying for a future year leaves current occupancy intact; checking out this year preserves a future claim. Check-in cannot overlap another actual checked-in occupant. Discovery, watchlists, pricing, checkout, settlement, transfers and refunds use the appropriate year and physical-occupancy guards. Future-only residents cannot receive current private notices, request current-stay services or publish a lived-in review before their year starts.

An open refund blocks occupancy changes and new stay-plan acceptance. Renewal amounts and commission/payout entries belong to the new booking; original payment rows are preserved. Different-price moves are rejected on the server.

Concurrent updates require the current request version. Mutations carry a unique key and payload hash. A successful retry returns the saved result; changed data with the same key conflicts. Checkout is linked to the accepted offer inside the inventory transaction, before provider initialization. Provider failure/expiry leaves the current residency intact. A late payment remains reviewable even if a replacement request exists.

Staff and students use authenticated, scoped endpoints. A manager's active account/membership is checked at the route boundary. Another student/hostel cannot read or change a request. Responses are private/no-store. The notification outbox links to the appropriate **Stay plans** workspace; delivery is asynchronous, so the in-app record is authoritative.

## Enablement and rollout

The administrator's **Hostel stay plans** switch defaults off (`HOSTEL_STAY_REQUESTS_ENABLED=false`). Each owner separately enables the property and sets a renewal window. Disabling new requests also stops new offers and acceptance, while retaining accepted handovers, verification, cancellation and history.

Apply [033 inventory](../../sql/033_hostel_year_inventory.sql) and [034 requests](../../sql/034_hostel_stay_requests.sql) after the existing hostel migrations, or use the application's memoized schema passes. Inventory backfill fails closed if legacy active bookings conflict; do not discard a paid claim to make migration succeed. Reconcile conflicts before deployment. A read-only preflight can identify them:

```sql
SELECT b.space_id, b.period_id, COUNT(*) AS active_count
FROM hostel_bookings b LEFT JOIN hostel_stays st ON st.booking_id=b.id
WHERE b.status IN ('PENDING_PAYMENT','PAID','PAYMENT_REVIEW')
  AND COALESCE(st.status,'EXPECTED') IN ('EXPECTED','CHECKED_IN')
GROUP BY b.space_id,b.period_id HAVING COUNT(*)>1;

SELECT lower(b.student_email) AS student_email,b.period_id,COUNT(*) AS active_count
FROM hostel_bookings b LEFT JOIN hostel_stays st ON st.booking_id=b.id
WHERE b.student_email<>'' AND b.status IN ('PENDING_PAYMENT','PAID','PAYMENT_REVIEW')
  AND COALESCE(st.status,'EXPECTED') IN ('EXPECTED','CHECKED_IN')
GROUP BY lower(b.student_email),b.period_id HAVING COUNT(*)>1;
```

Pilot with one property, reviewed next-year listings and an explicit window. Verify payment initialization/return/webhook/reconciliation, ledger/refund behavior, current-year departure with a future reservation, owner/manager revocation, keys and M2 evidence. Keep the platform switch off until that pilot is ready. The default-off release does not activate any property.

## Help, assistant and captures

The public help page, role-specific staff guide and their AI reference/fallback answers explain M3. The assistant cannot see live requests, promise availability, accept offers or perform payments.

These captures use fictional records and a local component preview. They demonstrate layout and interaction, not live production inventory or a real payment:

- [Staff queue, desktop](captures/stay-plans-staff-desktop.png)
- [Student entry, mobile](captures/stay-plans-student-mobile.png)
- [Request review, mobile](captures/stay-plans-request-review-mobile.png)
- [Renewal offer, mobile](captures/stay-plans-offer-mobile.png)
- [Renewal confirmation, mobile](captures/stay-plans-confirmation-mobile.png)
- [Owner settings, mobile](captures/stay-plans-settings-mobile.png)

## Local verification

Real SQLite/Turso-protocol tests exercise authorization, owner-only configuration, duplicate and stale actions, offer expiry/replacement, equal-price enforcement, refund guards, atomic transfer rollback, competing renewals, late payments, separate payout accrual, year-scoped availability, future-only access and bulk next-year pricing/submission. Existing residency, conditions, listing, discovery, payout and refund suites are retained.

Chromium component checks cover 320, 390, 768, 1024 and 1440px widths, pagination, owner settings, confirmation before mutation, lost-response retry without duplicate records, checkout link, Escape focus restoration and runtime errors. Real iOS Safari/Android device checks and a live property/payment pilot remain pending.
