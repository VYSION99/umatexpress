# M1 — Hostel maintenance requests

**Implementation:** 30 September 2026. Implemented behind platform and property switches, which default to **off**. A real-property pilot and physical iOS/Android checks remain pending.

## Student guide

1. Sign in and open **My Hostel Residency → Requests** for the relevant stay. New reports require a paid booking, an Expected arrival or Checked in stay within its academic-year dates, an active host, a property that is not suspended, and both maintenance switches enabled.
2. Select **Report a problem**. Choose Water, Electricity, Plumbing, Furniture, Internet or Other; select Routine or Urgent; identify the room/bed or shared area and exact location.
3. Describe what happened, when it started and its impact. Choose whether staff must arrange access, enter only while you are present, or may enter for this report. Add a preferred access time if useful.
4. Optionally attach up to three JPEG, PNG or WebP photos of 6 MB each. A report can contain ten photos in total. Convert HEIC photos to JPEG first. Avoid personal documents and images of other people.
5. Review the summary, then submit. If the connection fails, retry the same draft: repeated submissions use an idempotency key. The draft and selected files remain available while the request list stays mounted; they are not saved across navigation, tab changes or browser closure.
6. Open the report to read replies, assigned staff and activity. Reply when staff ask for details. Confirm a successful repair or reopen with a reason. **All reports** includes closed and cancelled cases. Cancellation requires a reason and is final for that report.

Existing reports remain available to their reporter after checkout or when new reporting is disabled. Use History to find a previous stay. **Escalate to owner** flags the report and queues an owner notification; it is not a guarantee of immediate attention.

Service hours are informational. First-response targets count elapsed hours continuously, including outside service hours, and do not promise completion by that time. Urgent is a priority flag, not emergency dispatch. For immediate danger, contact local emergency services. The hostel contact is shown only when its owner profile and identity are approved.

## Staff guide

Open **Residents & Services → Maintenance**. Search the reference, issue, room or student name. Filter by property, category, urgency, status, assigned staff, overdue first response or escalation. Pages contain up to 20 reports; the summary covers the selected property, independently of the remaining queue filters.

Open a report in the detail drawer. Choose an action, enter any explanation and save:

| Action | Result |
| --- | --- |
| Acknowledge | Submitted → Acknowledged; records the acknowledgment time |
| Assign staff | Assign an active owner or manager of this hostel, or leave unassigned |
| Start work | Acknowledged / Waiting for student → In progress |
| Ask for details | Acknowledged / In progress → Waiting for student; explanation required |
| Add reply | Records a shared reply; a student reply while waiting returns the report to Acknowledged |
| Mark resolved | Acknowledged / In progress / Waiting for student → Resolved; repair note required |
| Confirm resolved | Student confirms Resolved → Closed |
| Reopen | Resolved / Closed → Submitted; explanation and a fresh response target |
| Escalate to owner | Records the reason, flags an active report and queues an owner notification |
| Cancel request | Ends an active report with an explanation |

Photos can accompany a reply, resolution or reopening. All notes are shared with the reporter and authorized hostel staff; there is no private staff-note field. The timeline shows the newest 100 events. Earlier events remain stored; this milestone does not include a full-history export.

Only the owner can change **Property settings**: opt-in, service hours and a first-response target from 1 to 168 elapsed hours. Managers can process reports but cannot change these settings. Turning off either switch stops new reports while preserving existing follow-up. A version check prevents overwriting another person's update; refresh details and review the latest state before retrying a conflict.

## Notifications and AI help

Each saved report/action creates student and staff email-outbox entries in the same database transaction. Staff delivery goes to the active assignee, otherwise the owner; escalation goes to the owner. Revoked assignees do not receive later updates. The existing notification sweep picks up these entries, with its normal retry policy; delivery is not instantaneous. Subjects/messages contain a report reference and status, not the description, photos or access instructions. Links open the maintenance workspace, not payment verification or a ride ticket.

Student and role-specific staff help pages include maintenance instructions and AI reference content. The guide assistant helps explain the process and structure a description using known facts. It cannot inspect live reports, submit a form, change status or promise a response. A deterministic maintenance answer is available when live AI is unavailable.

## API and storage

| Endpoint | Methods | Access |
| --- | --- | --- |
| `/api/hostel/maintenance` | GET list/detail, POST create, PATCH action | Signed-in student; own booking/reports only |
| `/api/console/hostel/maintenance` | GET list/detail, PATCH action | Active landlord console account and owner/manager membership |
| `/api/console/hostel/maintenance/settings` | GET, PATCH | Same hostel; owner-only writes |
| `/api/hostel/maintenance/files/:attachmentId` | GET | Owning student and valid signed token |
| `/api/console/hostel/maintenance/files/:attachmentId` | GET | Authorized hostel staff and valid signed token |

List queries: `reference` (student), `propertyId` (staff), `status`, `category`, `urgency`, `assignee` (staff, including `UNASSIGNED`), `q`, `overdue=1`, `escalated=1`, `page`. Detail query: `id`. Default page size: 20.

Writes accept JSON or multipart form data with a JSON `data` field and repeated `photos` file fields. Creation requires a UUID `clientRequestId`; actions require UUID `mutationId` and current numeric `version`. Clients retain these keys when retrying unchanged submissions. The server validates text lengths, photo count, MIME/signatures, action permissions, current occupancy and switches. Upload bodies are limited to 19 MiB, including streamed requests without Content-Length. Cross-origin mutations are rejected. Per-account/IP rate limits apply.

Migration: [031_hostel_maintenance.sql](../../sql/031_hostel_maintenance.sql). Runtime schema initialization is repeatable and follows existing hostel schemas, including residency/stays. Tables: property settings, requests, append-only application events, and private attachment metadata. Request creation snapshots the actual booked room and bed; later transfers do not rewrite the location originally reported.

Photos use the existing private R2 binding under `hostel-maintenance/`. They never enter the approved/public gallery. Access links expire in five minutes, are bound to the requesting account, and still require a current authorized session. Responses use `private, no-store`. Signing uses the configured console session secret (with existing administrator/student aliases); keep at least 32 characters. The existing private bucket must remain inaccessible through public bucket URLs.

Photos are staged before the SQL transaction. Confirmed failures attempt cleanup; uncertain commits preserve objects to avoid deleting committed evidence. If storage deletion fails, unreferenced objects can remain. There is no automatic orphan sweeper or retention policy in M1: inspect that prefix against attachment metadata before deleting old unreferenced objects, and never purge referenced report evidence as routine cleanup.

## Controlled release

1. Deploy the reviewed code and migration. Verify private R2, session secrets, email delivery and the existing notification cron in the target environment.
2. Keep `HOSTEL_MAINTENANCE_ENABLED=false` as the default. In audited platform settings, enable **Hostel maintenance requests** only for a prepared pilot. Property opt-in remains a separate gate; there is no separate administrator property allowlist in M1.
3. The participating owner selects the property, sets service hours and a realistic elapsed-hour acknowledgment target, enables reports and assigns responsibility for checking the queue.
4. Test on physical Safari/iOS and Chrome/Android: sign-in, photos, review/submit, weak-connection retry, replies, resolution and reopening. Headless viewport checks are not a substitute for these device checks.
5. Pilot with one property. Track failed/retried submissions, first-response delays, escalation, reopened cases and notification failures. Confirm actual email delivery and private bucket isolation before wider enablement.
6. To stop new reports, turn off the platform switch or the property opt-in. Existing tickets and authorized actions remain available.

Maintenance does not activate paid service add-ons. That catalogue remains under its separate product-policy hold.

## Verification and interface captures

- Production build, TypeScript and lint pass.
- Full regression suite: 737 tests passed before the final revoked-assignee notification safeguard; the final maintenance suite passed all 20 tests, including that additional regression.
- Real SQLite integration checks cover ownership, revocation, state transitions, optimistic conflicts, idempotent retry, atomic event/notification writes, switches, multipart validation, photo privacy and upload/database rollback.
- Headless Chrome component checks with fictional API fixtures cover widths 320, 390, 768, 1024 and 1440; no horizontal overflow or runtime exceptions; filters/pagination, staff assignment/resolution, review-before-submit, failed-submit draft retention, retry, modal focus and Escape restoration.
- Live R2/email delivery, physical-device checks and the property pilot require release verification.

Captures use fictional names, rooms and requests:

- [Staff maintenance queue on desktop](captures/maintenance-staff-desktop.png)
- [Staff report detail on desktop](captures/maintenance-detail-desktop.png)
- [Student reporting form on mobile](captures/maintenance-report-mobile.png)
- [Student review popup on mobile](captures/maintenance-review-mobile.png)
