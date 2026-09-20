# Hostel Finder — Phase 1 Build Plan

**Version:** 1.0  
**Status:** Ready to build — three decisions at the end need a call  
**Progress:** M4 shipped 2026-09-20 — the public browse page and the hostel map
(`/hostel`, `/hostel/[propertyId]`, `GET /api/hostel/properties`), filters for year,
distance, budget, beds and utilities, and the launcher entry flipped live. Distance
is the landlord's declared figure when there is one and the haversine distance from
the dropped pin otherwise, so the distance filter works before anyone fills
`campus_distance_m` in. The landlord KYC verify/reject decision also landed early
(see M5). M3 shipped the same day — an academic-year catalogue, the listing
lifecycle (`DRAFT → PENDING_REVIEW → APPROVED → SUSPENDED`, with edits and rejections
returning a listing to draft), a review queue for ADMIN/MODERATOR, and the public read
that shows only approved beds. M2 (property → room → bed-space, beds kept in step with
capacity) and M1 (schema, `LANDLORD` role, open landlord application) shipped earlier
the same day. Photos and the notification rails are M4/M5.
**Photo gate:** R4 keeps photos mandatory for `APPROVED`, but the upload lands in M5;
until then approval has nothing photographic to check, and the checklist gains it when
the upload does.
**Sources:** the seven design docs in this folder + the platform as shipped (Sep 2026)

This plan does not replace the design docs. It records where the design meets the
code that exists today, so Phase 1 can start without re-litigating decisions that
were already made elsewhere.

---

## 1. Product model locked by the design docs

| Dimension | Decision |
|-----------|----------|
| Inventory | Bed-space, 1–6 per room. A space is a physical bed. |
| Booking grain | One booking = one space. Two beds = two bookings. |
| Period | Annual academic year, an admin-managed catalogue. A landlord prices against a period. |
| Price | On the listing, in pesewas. |
| Money | Platform is merchant of record. Paystack collects; Transfers pay landlords. |
| Payout timing | `starts_on − 3 days` by default, admin override. Percentage commission stored per booking. |
| Publishing | `DRAFT → PENDING_REVIEW → APPROVED → SUSPENDED`, edits send a listing back to draft. |
| Gender | Mixed. No gender filter. |
| Utilities | Landlord toggle per property; fee per room. |
| Photos | R2, required before a listing can be approved. |
| Refunds v1 | Admin-mediated, no automated policy. |
| Chat | Phase 4. |
| AI assistant | Phase 4. |

---

## 2. Reconciliation with the shipped platform

The docs were written before the unified console and the vacationRide
self-service stack landed. These are the deltas the build must respect.

| # | Doc assumption | Platform today | Build instead |
|---|----------------|----------------|---------------|
| R1 | A separate landlord app (`app/landlord/…`) with its own auth | One console on its own origin; `CONSOLE_ROLES = ADMIN, MODERATOR, ORGANIZER, DRIVER`; `console_accounts` holds credentials; a `landlord` entry already sits in `console_applications` with `role: null` | Add `LANDLORD` to `CONSOLE_ROLES`; build the landlord workspace under `app/console/…`; the application entry flips to `OPEN` with `role: "LANDLORD"` |
| R2 | `hostel_landlords` carries `password_hash`, `password_salt`, `password_iterations` | Credentials and sessions live in `console_accounts`; the business lives in a profile table keyed by `profile_id` (see `trip_organizers`) | `hostel_landlords` is the business profile only: identity, phone, KYC, commission, status. `console_accounts.profile_id → hostel_landlords.id` |
| R3 | Migrations `sql/014_…` and `sql/015_…` | `sql/000_umatexpress_full_migration.sql` is the one manual-run, idempotent file; numbered files remain as history | Add a hostel section to `000` and a canonical `sql/014_hostel_foundation.sql`. Payout tables (`015`) arrive with Phase 3. |
| R4 | Photos are mandatory for `APPROVED`, but R2 upload is a Phase 3 deliverable | The `PRIVATE_BUCKET` R2 binding is configured and bound in the Worker | Move basic photo upload into Phase 1. A listing cannot pass a moderation checklist without photos, so approval would be blocked or meaningless otherwise |
| R5 | "Atomic claim: `UPDATE hostel_spaces SET status='BOOKED' WHERE status='AVAILABLE'`" | A space persists across academic years, so its status cannot be globally `BOOKED` | Claim against the listing for the period: at most one active booking (`HELD` or `CONFIRMED`) per listing, enforced by a partial unique index, with the guarded-transition and expiry-release helpers ported from `lib/campus-engine/queue.ts` |
| R6 | The booking form collects name, phone and email | Students sign in with `@st.umat.edu.gh`; the rule is "browse everything, sign in to book" | Phase 2 takes identity from the signed student session. The form prefills it; only the phone stays editable |
| R7 | Chat runs on Ably | The Worker already has Durable Objects, Queues, Turso and an in-app notification feed on Resend | Before Phase 4, evaluate a Durable Object chat (or Turso polling) against Ably. Do not add a third-party dependency by default |
| R8 | `hostel_audit_logs` | `console_audit_logs` + `lib/console-audit.ts` | Log hostel decisions through `consoleAudit` with `targetType: hostel_*`. No new audit table |
| R9 | Paystack Transfers are new work in Phase 3 | `lib/paystack.ts` already exposes `createPaystackRecipient`, `initiatePaystackTransfer`, `verifyPaystackTransfer`; organizer payouts run daily release and reconcile crons | Phase 3 reuses the transfer machinery, status vocabulary and reconcile pattern. Commission stays per booking |
| R10 | Student-facing pages exist only after login in later phases | Public pages are open; `CampusMap` (maplibre + OpenFreeMap) already renders campus data | `/hostel` is public. Only booking requires the student session |
| R11 | `status = BOOKED` on a listing | The queue engine models holds as rows with expiry, not as status flips | Keep listing status for publishing. Holds and bookings are rows with `expires_at`; the listing stays `APPROVED` until the period ends |

---

## 3. Reuse inventory

- **Console**: `lib/console-auth.ts`, `lib/console-applications.ts`, `components/admin/console-services.ts`, `ConsoleShell`, `ConsoleSessionGate`, `lib/console-audit.ts`, `app/console/register/[programme]` (one generic form for every application).
- **Ownership pattern**: `lib/organizers.ts` — profile table + `console_accounts.profile_id`, ownership id always read from the signed session and put in every `WHERE`.
- **Claim + expiry**: `lib/campus-engine/queue.ts` (`claimCampusQueueSlot`, `releaseExpiredCampusHolds`, guarded transitions).
- **Payments**: `lib/paystack.ts`, `lib/payment-access.ts`, `lib/payment-events.ts`, `lib/mtn-momo.ts` (not used for hostel v1), `lib/paystack-banks.ts`, `lib/secret-box.ts` (seal/open/mask for payout accounts).
- **Delivery**: `lib/notifications.ts` + `lib/resend.ts` (email + in-app feed), `lib/rate-limit.ts`, `lib/observability.ts`.
- **Schema**: `lib/turso.ts` (`runSchemaPass` self-healing columns), `sql/000_umatexpress_full_migration.sql`.
- **UI**: `components/campusRide/shared/CampusMap.tsx`, `components/campusRide/shared/CampusAiAssistant.tsx` (Phase 4), `components/launcher/*` for the front door.
- **Tests**: `tests/*.test.mjs` (node:test + vite ssrLoadModule), `scripts/check-interfaces.mjs`, `scripts/check-console-origin.mjs`.

---

## 4. Phase 1 milestones

Each milestone is shippable and testable on its own.

### M1 — Foundation schema + landlord role

Files:
- `sql/014_hostel_foundation.sql` — tables and indexes, idempotent; hostel section added to `sql/000_umatexpress_full_migration.sql`
- `lib/hostel-engine/landlord.ts` — `ensureHostelTables()` + landlord profile helpers (schema version constant, self-healing columns)
- `lib/console-auth.ts` — `LANDLORD` in `CONSOLE_ROLES`
- `lib/console-applications.ts` — landlord entry: `role: "LANDLORD"`, `status: "OPEN"`, handler registered
- `app/api/console/applications/[programme]/route.ts` — `case "landlord"` calling `registerLandlord`
- `components/admin/console-services.ts` + `app/console/page.tsx` — role map and landing copy
- tests: `tests/hostel-schema.test.mjs`, extend `console-applications` / `console-ia`

Acceptance: a landlord applies, the account signs in directly (`DIRECT` activation), and the console home is scoped to LANDLORD services. Nothing is visible to students yet.

### M2 — Landlord workspace: property → room → space

Files:
- `lib/hostel-engine/landlord.ts` — property/room/space CRUD, every query scoped by `landlord_id`
- `app/api/console/hostel/properties/route.ts`, `…/rooms/route.ts`, `…/spaces/route.ts`
- `app/console/hostels/page.tsx` + `components/console/hostel/*` — the property builder
- Landlord service entries (`/console/hostels`) in the console registry

Acceptance: a landlord creates a property with rooms and beds; nobody else can read or write those rows (test proves cross-landlord 404).

### M3 — Periods, listings and review

Shipped 2026-09-20.

Files:
- `lib/hostel-engine/periods.ts` — admin catalogue, overlap guard, and `hostelReleaseAfter()` (`max(starts_on − 3 days, confirmed_at + 7 days)`, decision #3)
- `lib/hostel-engine/listings.ts` — draft → submit → approve/reject/suspend; edits reset to draft; `listPublicSpaces()` is the one public gate
- `app/api/hostel/periods/route.ts`, `app/api/hostel/spaces/route.ts` (public reads), `app/api/admin/hostel/periods/route.ts`, `app/api/console/hostel/listings/route.ts`, `…/[listingId]/route.ts`, `…/[listingId]/review/route.ts`, `…/listings/review/route.ts`
- `components/console/hostel/HostelReviewQueue.tsx` + the listings panel in `app/console/hostels/page.tsx`
- `consoleAudit` on every period, listing and decision

**Delta from this plan:** the review queue is a staff component rendered by `/console/hostels`
instead of a separate `app/console/hostel-listings` page, because the console IA test pins
single-word service ids and `/console/hostels` already had a dead end for MODERATOR. One
Accommodation service now answers by role: landlords build, ADMIN/MODERATOR review.
**Visible publicly** means `listing.status = 'APPROVED'` **and** a live bed, an active room
and a property that is not suspended — and only for an open year. Approving the first bed
of a building also moves the property from `DRAFT` to `APPROVED`.

Acceptance: a landlord lists a bed for a period; a moderator approves or rejects with a reason; only `APPROVED` listings are visible publicly.

### M4 — Student discovery

Shipped 2026-09-20. The two pages read the engine directly (the same public gate
the API serves), the map is a hostel-specific component modelled on `CampusMap`,
and the filters are a real GET form that also applies on change.

**Delta from this plan:** the landlord KYC approve/reject action was pulled
forward from M5, because a landlord's `kyc_status` could never leave `PENDING`
and the hostel payout gate is built on it. The M5 item below keeps the document
capture that a decision should eventually be made against.

Files:
- `app/hostel/page.tsx` (browse, filters: period, distance, price, utilities, availability), `app/hostel/[propertyId]/page.tsx`
- `app/api/hostel/properties/route.ts`, `app/api/hostel/spaces/route.ts`
- Hostel map reusing the `CampusMap` patterns (maplibre + OpenFreeMap), pins from approved properties
- `components/launcher/services.ts` — Hostel Finder flips to available, `destination: "/hostel"`

Acceptance: with one approved listing, a signed-out visitor finds the property on the map and sees its available spaces; a suspended property disappears.

### M5 — Photos and trust rails

Files:
- R2 upload for property photos (private bucket + signed read), photo moderation
- Landlord KYC sheet in the console profile (documents + admin verify/reject);
  the verify/reject **decision** already shipped with M4, so this milestone adds
  the documents the decision is made against
- Approval/rejection notifications (Resend + in-app feed)
- Rate limits on landlord writes and public reads where needed

Acceptance: a listing without a photo cannot be submitted; a rejected listing tells the landlord why; approval sends a notification.

### Phase 2 preview (for sequencing only)

`hostel_bookings` + `hostel_payments`, the hold + expiry job, Paystack initialize/webhook/verify, image ticket, and `release_after = starts_on − 3 days` computed at confirmation. The expiry sweep should ride the existing reconcile cron trigger rather than adding a fifth schedule.

---

## 5. Data model to write in 014

Delta from the ERD, after R2 and R5:

- `hostel_landlords` — drop `password_*` (console owns credentials). Add `commission_bps`, `status`, `kyc_status`. The link is one-directional, exactly like `trip_organizers`: `console_accounts.profile_id → hostel_landlords.id`, so no `account_id` column. Payout columns arrive with 015.
- `hostel_properties`, `hostel_rooms`, `hostel_spaces`, `hostel_periods`, `hostel_listings` — as the ERD, plus `updated_at` everywhere and `CHECK (capacity BETWEEN 1 AND 6)`.
- `hostel_property_photos` — new (Phase 1 per R4): `id, property_id, r2_key, caption, sort_order, status, created_at`.
- Indexes: the ERD list, plus `idx_hostel_properties_landlord (landlord_id, status)` and `idx_hostel_rooms_property (property_id, status)`.
- `hostel_bookings`, `hostel_payments`, `hostel_payouts`, `hostel_messages` — deferred to 015 / Phase 2–3.

---

## 6. Decisions needed before the first line of code

1. **Photos in Phase 1 (R4).** Recommended: yes. Without photos, "approve a listing" has nothing to check and the student map is blind. The R2 binding already exists.
2. **When landlord applications open.** Recommended: at M2. `DIRECT` activation lets landlords build drafts while M3/M4 land; visibility stays gated by listing review, so nothing can go live early.
3. **Commission rate (Phase 3).** Deferred by the docs. Recommended: `commission_bps` per landlord like organizers, default decided before Phase 3 (5% suggested, landlord-side).

One release-timing edge worth deciding with #3: a booking made after `starts_on − 3 days` would be instantly releasable. Recommended rule: `release_after = max(starts_on − 3 days, confirmed_at + 7 days)` so the escrow window is never zero.

---

## 7. First commit (M1)

Schema + role + application only. It changes no existing behaviour: the console
gains a role it does not hand out to anyone until a landlord applies, and the
migration is additive and idempotent. Validation: `npm run typecheck`,
`npm run lint`, `npm test`, then the migration runs clean twice against a fresh
SQLite database.
