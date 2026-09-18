# Organizer Self-Service — Architecture Plan

**Status:** Draft for Review
**Scope:** vacationRide trip organizing, moving from a single operator to many self-service organizers

---

## 1. Why this is a tenancy change, not a UI change

Today exactly one group organizes every trip. The code reflects that:

| Area | Current state | Consequence for many organizers |
|------|---------------|--------------------------------|
| Trip ownership | `scheduled_trips` has no owner column | Nothing distinguishes one organizer's coach from another's |
| Public notice | `trip_settings` is a single row (`id = 1`) | Every organizer would overwrite the same notice |
| Identity | Only `admin_credentials` + `ADMIN_EMAILS` | There is no account that means "organizer" |
| Console | `/admin/vacation` behind admin auth | Giving organizers access grants full platform admin |
| Bookings | `bookings.trip_id` → `scheduled_trips` | Revenue cannot be attributed to an organizer |
| Legacy trips | Seeded ids `"1"`/`"2"` still bookable | Two trip systems must both carry ownership |

The public booking page, seat availability, holds and Paystack flow are already trip-shaped and need no redesign. What is missing is **ownership** and **isolation**.

---

## 2. Target model

| Dimension | Decision | Rationale |
|-----------|----------|-----------|
| Tenant | One organizer account owns many trips | Matches how buses are actually organized |
| Platform role | Merchant of record: Paystack settles to the platform, platform pays organizers | Keeps refunds and disputes controllable, same decision as Hostel Finder |
| Commission | Percentage, stored per booking at sale time | Rate changes stay historical-safe |
| Organizer onboarding | `PENDING → APPROVED → SUSPENDED` | Self-service signup without letting anyone publish instantly |
| Trip publishing | Organizer drafts, admin approves before it is publicly bookable | A coach that does not exist is a real-world failure |
| Notice | Per organizer | Each organizer advertises their own departures |
| Payouts (v1) | Admin-triggered, recorded as ledger entries | Same v1 posture as Hostel Finder refunds |
| Identity | Separate `trip_organizers` table | Never conflate a tenant with a platform admin |

---

## 3. Data model

```sql
trip_organizers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,              -- login identity
  password_hash TEXT, password_salt TEXT, password_iterations INTEGER,
  status TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING | APPROVED | SUSPENDED
  organization TEXT,                       -- display name on the public site
  payout_method TEXT, payout_account_name TEXT,
  payout_account_number TEXT,              -- masked by default, audited on read
  paystack_recipient_code TEXT,            -- set once transfers are automated
  commission_bps INTEGER NOT NULL DEFAULT 0, -- platform cut, basis points
  token_version INTEGER NOT NULL DEFAULT 0,  -- revokes live sessions
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

scheduled_trips (
  ...existing columns...,
  organizer_id TEXT,                       -- NULL only for legacy seeded trips
  review_status TEXT NOT NULL DEFAULT 'APPROVED'  -- DRAFT | PENDING_REVIEW | APPROVED | REJECTED
);

trip_notices (
  organizer_id TEXT PRIMARY KEY,           -- replaces the global trip_settings.flyer_promo
  enabled INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL DEFAULT '', route TEXT NOT NULL DEFAULT '',
  fare TEXT NOT NULL DEFAULT '', night_bus TEXT NOT NULL DEFAULT '',
  day_buses TEXT NOT NULL DEFAULT '',      -- JSON arrays, as today
  drop_off_points TEXT NOT NULL DEFAULT '',
  amenities TEXT NOT NULL DEFAULT '',
  contacts TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

organizer_payout_ledger (
  id TEXT PRIMARY KEY,
  organizer_id TEXT NOT NULL,
  booking_reference TEXT NOT NULL,
  gross_amount INTEGER NOT NULL,           -- kobo/cents
  commission_amount INTEGER NOT NULL,
  net_amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACCRUED',  -- ACCRUED | RELEASED | REVERSED
  created_at TEXT NOT NULL, released_at TEXT
);
```

`bookings` gains `organizer_id` and `commission_amount`, both written at booking time so historical revenue never has to be recomputed from a rate that may since have changed.

---

## 4. Isolation rules (the part that must not be got wrong)

1. **Every organizer query is scoped by `organizer_id` taken from the session cookie**, never from a request body, query string or path.
2. A missing or unknown `organizer_id` on an organizer route is a `401`, not an empty list.
3. Trip mutations verify ownership with a single `UPDATE ... WHERE id = ? AND organizer_id = ?` and treat a zero-row result as `404`, so a probe cannot distinguish "not yours" from "does not exist".
4. Admin routes keep their own auth; an organizer session must never satisfy `adminEmailFromRequest`.
5. Manifests expose passenger PII only to the owning organizer, and every read is written to `admin_audit_logs` with the organizer as actor.
6. Reuse the existing session primitives rather than inventing new ones: PBKDF2 hashing, HMAC-signed cookie, `token_version` revocation and the `auth_failures` lockout already used by `student_accounts` and `campus_drivers`.

---

## 5. What changes in existing code

| File | Change |
|------|--------|
| `lib/trip-settings.ts` | Notice becomes per organizer; `flyerPromoFromEnv()` remains the platform fallback |
| `app/api/trips/display/route.ts` | `GET` returns the organizer's notice; `PATCH` moves to the organizer console |
| `app/api/trips/schedule/route.ts` | Public reads return approved trips only |
| `app/admin/vacation/page.tsx` | Flyer editor leaves; gains organizer approval and trip moderation |
| `lib/trips.ts` | Trip reads gain an optional `organizerId` filter |
| `sql/000_...` | New tables and additive columns, idempotent, with self-healing at read time |

Legacy seeded trips keep working: `organizer_id` stays `NULL` and they belong to the platform until an admin assigns them.

---

## 6. Phases

### Phase 1 — Foundation (no money)
Organizer registration and login, `PENDING → APPROVED` via admin, `scheduled_trips.organizer_id`, `/organizer` console listing **only** the organizer's own trips and manifest, per-organizer notice, admin approval screen.
**Acceptance:** an organizer registers, is approved, signs in, sees only their own trips and passengers, and edits only their own notice. A second organizer cannot see or mutate the first organizer's data by any request. No money moves.

### Phase 2 — Self-service trip publishing
Organizer creates and edits trips (route, date, times, capacity, price, coach type, amenities), submits for review, admin approves or rejects with a reason. Public page lists approved trips grouped by organizer.
**Acceptance:** an organizer can publish a bookable trip without admin data entry; an unapproved trip is never publicly bookable.

### Phase 3 — Money and attribution
Commission per organizer, `bookings.organizer_id` + `commission_amount`, payout ledger accrued on confirmed payment, admin-triggered payout batches, organizer statement view.
**Acceptance:** every confirmed booking produces exactly one ledger entry; an organizer statement reconciles to the bookings behind it; refunds reverse the correct entry.

### Phase 4 — Scale
Paystack Transfers for automated payouts, organizer suspension and dispute handling, per-route overlap warnings, organizer-level analytics, and rate limits on public trip reads.

---

## 7. Risks

| Risk | Mitigation |
|------|------------|
| Cross-tenant data leak | Session-derived scoping, ownership checked in the `WHERE` clause, tests that assert organizer B gets `404` for organizer A's ids |
| Unapproved or fraudulent trips | `PENDING_REVIEW` gate plus admin approval before public listing |
| Payout disputes | Ledger is append-only; releases are recorded, never edited |
| Two organizers, same route and time | Warn on overlap; do not block, since duplicate departures are legitimate |
| Seat inventory races | Existing hold and confirmation path already serialises per trip; keep it trip-scoped, never organizer-scoped |
| Legacy trips orphaned | `organizer_id NULL` = platform-owned; admin assignment is a Phase 1 screen |

---

## 8. Open questions

1. Should organizers sign up freely, or be invite-only until trust is established?
2. Is the commission per organizer, per trip, or a platform default an admin can override?
3. Do students book one trip at a time, or can a single payment cover seats on two organizers' coaches?
4. Should an organizer be able to run trips on the campusRide side too, or is vacationRide the only surface?
