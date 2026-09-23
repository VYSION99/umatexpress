# Driver Self-Service

**Status:** implemented — a driver applies from `/console/register/driver` and an administrator decides
**Applies to:** campusRide drivers, the driver console and the campus operations console

---

## 1. What changed

Driving was the last role only the operations team could create: a candidate had
to reach a person before they could exist as an applicant, and the account and
the driver record appeared together with a temporary password. A driver now
applies like an organizer or a landlord, and the same two records are written by
the form and moved by the decision.

What did **not** change is where the road begins. Approval opens the console and
activates the driver record; the vehicle, zone and corridor still come from
operations, exactly as they do for a driver added by hand. An approved driver
with no vehicle can sign in and wait.

## 2. The two records

| Record | Written by the form | Moved by the decision |
|--------|--------------------|-----------------------|
| `console_accounts` — what the person signs in with | role `DRIVER`, status `PENDING`, `profile_id` = driver id, the password they chose | `ACTIVE` on approval, `SUSPENDED` on suspension |
| `campus_drivers` — the operator | `application_status = 'PENDING'`, `active = 0`, no vehicle, no zone | `APPROVED` + `active = 1` on approval, `REJECTED` or `SUSPENDED` with the reason otherwise |

`campus_drivers.application_status` is new, and its default is `APPROVED`: every
driver that existed before self-service was created by the team, which is the
same decision. A self-service applicant is written as `PENDING` explicitly, so
no migration has to guess which rows were applications.

The password chosen on the form is stored in both records. The console is the
door a new driver is handed, and the legacy `/api/driver/*` endpoint still exists
during the migration, so the same password opens either one rather than one of
them silently refusing the person who just chose it.

## 3. The decision

| Move | Allowed from | What it does |
|------|--------------|--------------|
| Approve | any state that is not already an active driver | driver `APPROVED` and active, console account `ACTIVE`, the applicant is emailed |
| Reject | an applicant who was never approved | driver `REJECTED` with the reason, account stays `PENDING`, the applicant is emailed what to fix |
| Suspend | an approved driver only | driver `SUSPENDED`, account `SUSPENDED`, live sessions retired, any open ride ended, location cleared, the driver is emailed why |

A rejection requires a reason and a suspension requires a reason: both end with
someone being told what happened, and a refusal with no reason is a dead end.
Suspending an applicant who was never approved is refused with a message saying
so, because rejecting is the move that fits.

Deciding is an **administrator** action, on the same page that manages vehicles
and zones, since approving a driver and putting them in a vehicle are one job.
The notices come from the shared two-party notice book
(`driver_application_approved|rejected|suspended`), so they read the same way as
every other provider decision — see `docs/PLATFORM_NOTICES.md`.

## 4. What the form deliberately does not collect

No vehicle, no plate, no zone and no corridor. Those are operational
assignments, they are checked against rows that already exist, and a public form
must not be able to put a stranger in front of passengers. The form collects a
name, a phone number, an email address and a password, which is exactly what is
needed to open a parked account and make a decision against a person.

## 5. Files

| Concern | Where |
|---------|-------|
| The programme the form renders | `lib/console-applications.ts` |
| Apply: register and park | `lib/campus-engine/driver-onboarding.ts` → `registerDriverApplication` |
| Decide: the queue and the review | `lib/campus-engine/driver-onboarding.ts` → `listDriverApplications`, `reviewDriverApplication` |
| The endpoint every form posts to | `app/api/console/applications/[programme]/route.ts` |
| The console API | `app/api/console/campus/drivers/route.ts` |
| The console panel | `components/campusRide/admin/DriverApplicationsPanel.tsx` on `/console/campus` |
| The driver console itself | `/console/driver` (`components/campusRide/driver/DriverOperationsPanel.tsx`) |

## 6. Tests

`tests/driver-onboarding.test.mjs` holds the whole path: the application writes
a parked account and an inactive driver, a pending applicant cannot sign in,
approval opens the console without assigning a vehicle, a rejection keeps the
account parked with a reason, suspension ends the ride and retires the sessions,
and the queue is an administrator's.
