# M2 — Move-in and checkout condition records

**Status:** Implemented on 30 September 2026 behind platform and property switches, which default off. Physical iOS/Android testing, live storage/email verification and a property pilot remain pending.

## Student guide

1. Sign in and open **My Hostel Residency → Requests → Room condition**. Choose the correct current or historical stay. Maintenance and paid services have separate views.
2. For a current paid stay, select **Open current checklist**. The platform and property owner must both enable new records. The server links the checklist to your actual booked room, bed and assignment; reopening the same checklist does not create a duplicate.
3. Choose **Submit move-in record**. Inspect three items at a time. For each, select Good, Worn, Damaged, Missing, Not checked or Not applicable. Explain wear, damage, missing items and anything you could not inspect. Do not guess.
4. Add optional private photos. Identify the relevant checklist item or choose **Whole room / general evidence**. Review the inspection before saving.
5. Follow staff acknowledgment or requests for clarification. Use **Amend move-in record** to correct your current-room submission, with an explanation. Every saved inspection version remains available; amendments never overwrite the original evidence.
6. At checkout, compare the staff inspection with the original or an amended move-in version. **Acknowledge checkout** records receipt of that version. It does not mean you accept every observation.
7. Raise a disagreement with a reason when needed. It remains visible and blocks closure. Only the side that raised it can withdraw it, with a reason. Raising a disagreement after closure reopens the review.
8. Use **Download condition summary** for a readable text file containing all inspection versions, receipt versions, disagreement state, activity and photo references. Open the authenticated record to view the photos themselves.

If an upload or connection fails, the unsent inspection, selected photos and retry key remain in the open panel. Retry the same submission, or remove photos and add evidence in a later note. Unsaved edits are not stored across closing the panel, changing views or leaving the page. Opening a checklist creates its server record; saving the reviewed inspection commits its evidence.

## Owner and manager guide

Open **Residents & Services → Condition records**. Search the record reference, resident or room; filter by property, status and open disagreements. Records are paged in groups of 20, and activity is displayed in groups of ten inside the detail drawer.

Only the owner can change **Checklist settings**. Configure 1–20 unique inventory labels, up to 60 characters each, and enable the property. Suggested inventory covers the bed frame, mattress, furniture, locks, sockets, lighting, walls, bathroom and relevant shared facilities. The platform administrator must also enable **Hostel condition records**. Template changes apply to new handovers; existing records keep their frozen checklist.

Owners and active managers can:

- Review student submissions and **Acknowledge receipt** of the current move-in version.
- **Request clarification**, add a shared note or raise a disagreement. Clarification must be acknowledged again before closure.
- **Record checkout inspection** while the resident is checked in, after checkout, or for a previous transferred room. Use the same checklist so observations are comparable. An amended checkout creates another version that needs a new student acknowledgment.
- Compare any move-in and checkout versions. A changed condition is an observation, not a finding of responsibility.
- Close a record only after departure/transfer, current move-in and checkout receipts, completed clarification review and no open disagreement. Closure does not create a charge, withhold money or issue a refund. Additional notes remain possible; a later disagreement reopens review.

Notes, versions and photos are shared with the reporter and authorized hostel staff. There is no private staff-note field. Each change records the actor, server timestamp and version. Conflicting updates are refused; refresh and review the latest record before retrying.

## Room transfers and continued access

When a stay with an existing condition record moves to another bed, the occupancy transaction also marks the old handover as a previous room, retains its inspections and photos, and opens a separate destination checklist. Returning to the same bed creates another assignment record rather than reusing the old one. If creating the new handover fails, the room transfer rolls back.

A transfer without any existing condition record does not manufacture historical move-in evidence. The student can open the current assignment checklist when eligible and enabled. New records require a paid stay in Expected arrival or Checked in status within its academic-year dates, an active host and a property that is not suspended.

After transfer or departure, the original move-in inspection cannot be rewritten. Participants can still add notes/evidence, clarify, acknowledge, dispute and complete checkout review. Existing records and their destination handovers continue when new-record enablement is turned off. Closing a residency and closing its condition record are separate operations.

## Photos, exports and notifications

- JPEG, PNG and WebP only; up to three files per update, 6 MB each, and 30 files per condition record. Convert HEIC to JPEG first.
- Photos use the existing private R2 binding under `hostel-conditions/`. They never enter the public property gallery.
- Links expire after five minutes and are bound to the account, staff scope and condition-record namespace. A live authorized session is still required. Refresh the record to renew links.
- File type/signature, size, body length, record ownership and total attachment count are checked on the server. Known failed writes attempt storage cleanup; uncertain commits preserve evidence. As in M1, failed storage deletion can leave orphan objects; no automatic retention/orphan sweeper is included.
- Summary exports are authenticated and use `private, no-store`. Text is the normal student/staff download; `format=json` supports structured export. Neither format includes signed photo URLs or storage keys. Downloaded files are private evidence and remain on the downloading device.
- Saved review actions and inspection submissions queue email notifications to the student and property owner through the existing outbox. Delivery follows the configured sweep/retry policy. Opening an empty checklist and transfer-created drafts appear in the workspace without a separate M2 email. Messages do not contain inspection notes or photos.
- Student/staff help and AI reference content explain the workflow. The assistant cannot read live private records, assess evidence, decide liability, submit an inspection or settle a disagreement.

## API and data

| Endpoint | Methods | Authorization |
| --- | --- | --- |
| `/api/hostel/conditions` | GET list/detail, POST open current checklist, PATCH action | Signed-in student; own booking/records |
| `/api/console/hostel/conditions` | GET list/detail, PATCH action | Active owner/manager of the owning hostel |
| `/api/console/hostel/conditions/settings` | GET, PATCH | Same hostel; owner-only writes |
| Either base + `/files/:attachmentId` | GET | Scoped live session plus signed token |
| Either base + `/export?id=…` | GET | Scoped live session; text by default, optional `format=json` |

List queries: `reference` (student), `propertyId` (staff), `status`, `q`, `disputed=1`, `page`. Detail query: `id`. Opening accepts `{ reference }`; the server enforces one record per booking assignment. Actions accept the current `version`, UUID `mutationId`, action, note and inspection items where required. Multipart writes use JSON `data`, repeated `photos`, and a matching `photoItems` array of checklist keys or empty strings for whole-room evidence.

Migration: [032_hostel_conditions.sql](../../sql/032_hostel_conditions.sql). It adds an assignment identifier to stays and creates property checklist settings, condition records, immutable application events, inspection revisions and private-photo metadata. Runtime initialization checks the column and applies repeatable schema setup; the standalone SQL's `ALTER TABLE` is a one-time migration.

Inspection items are validated against the record's frozen checklist. Photos, event, revision, version update and outbox rows commit in one SQL transaction. Identical mutation retries return the committed result; conflicting or changed payloads are refused. A transfer and both handovers share the existing occupancy transaction. M2 uses the existing M1 session, private bucket, signed-file and bounded-upload infrastructure.

## Pilot and verification record

1. Deploy the reviewed code and migration with `HOSTEL_CONDITIONS_ENABLED=false`.
2. Confirm the private bucket, session signing configuration and email sweep work in the target environment.
3. The owner prepares the checklist and property opt-in. The administrator enables the platform switch for the controlled rollout. There is no separate administrator property allowlist; property opt-in supplies the second gate.
4. Test on physical Safari/iOS and Chrome/Android: inspection pagination, camera/photo selection, weak-connection retry, version comparison, summary downloads, staff review and actual transfer/checkout.
5. Pilot with one prepared property. Review incomplete inspections, clarifications, disagreements, stale edits, upload errors and notification delivery before wider enablement. No damage-billing or deposit-deduction policy is introduced by M2.

Local validation:

- Production build, TypeScript and lint checks.
- Full regression run: 755 tests passed before the final clarification-state safeguard; the final M2 integration suite passed all 17 tests, including that case and the photo-cap regression.
- Real SQLite integration covers scoped access, immutable versions, idempotent/concurrent writes, disagreement preservation and reopening, checkout receipts, upload rollback, transfer rollback and return-to-bed assignments, checklist settings, pagination and authenticated exports.
- Headless Chrome with fictional API fixtures at 320, 390, 768, 1024 and 1440 pixels: no horizontal overflow or runtime exceptions; tested three-item batches, review-before-save, failed-response retry without another revision, visible disagreements, focus restoration, settings and pagination.
- Real device testing, live storage/email checks and a property pilot require release verification.

## Interface captures

These captures use fictional residents, rooms and observations.

- [Staff condition queue — desktop](captures/conditions-staff-desktop.png)
- [Move-in / checkout comparison — desktop](captures/conditions-comparison-desktop.png)
- [Inspection checklist — mobile](captures/conditions-inspection-mobile.png)
- [Review before saving — mobile](captures/conditions-review-mobile.png)
- [Open disagreement — mobile](captures/conditions-disagreement-mobile.png)
