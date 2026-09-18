# Organizer Self-Service — Architecture Plan

**Status:** Draft for Review
**Scope:** vacationRide trip organizing, moving from a single operator to many self-service organizers

---

## 0. Decisions recorded

| # | Decision | Consequence |
|---|----------|-------------|
| D1 | **One console identity system covering every console service** | A single sign-in for admin, organizer and driver. Roles, not separate auth stacks. |
| D2 | **The console lives on its own origin**, e.g. `console.umatexpress.com` | Console code and console cookies never share an origin with the public site. |
| D3 | **Organizers can see passenger phone numbers** | Manifests expose contact details to the owning organizer. Auditing and read controls carry more weight as a result. |
| D4 | **Open registration with a mandatory approval gate** | Anyone may apply to become an organizer, but a `PENDING` account cannot publish a trip, be bookable, or take money until a human approves it. This matches the Hostel Finder landlord flow (`DRAFT → PENDING_REVIEW → APPROVED`) so both systems behave alike, and it scales onboarding without letting a stranger publish a coach in minutes. |
| D5 | **The console hosts every console, existing and future** | Campus admin, vacation admin, driver and organizer all move onto the one console identity and the console origin. New console services are added as roles on `console_accounts`, never as another credential store. |

### Why D4 rather than invite-only

Invite-only is safer on day one but does not scale: every organizer becomes a manual admin task, which is the problem this work exists to solve. Open registration moves the cost to one review decision per organizer instead of an onboarding conversation, and the approval gate makes publishing the trust boundary rather than signing up. If abuse appears, the gate that already exists is where to tighten — raise the bar for approval, or require a deposit — rather than closing registration.

---

## 1. Why this is a tenancy change, not a UI change

Today exactly one group organizes every trip. The code reflects that:

| Area | Current state | Consequence for many organizers |
|------|---------------|--------------------------------|
| Trip ownership | `scheduled_trips` has no owner column | Nothing distinguishes one organizer's coach from another's |
| Public notice | `trip_settings` is a single row (`id = 1`) | Every organizer would overwrite the same notice |
| Identity | `admin_credentials` + `campus_drivers` + `ADMIN_EMAILS` | Three credential stores, no account that means "organizer" |
| Console | `/admin/vacation` and `/driver` on the public origin | Console sessions ride on the same origin as the booking site |
| Bookings | `bookings.trip_id` → `scheduled_trips` | Revenue cannot be attributed to an organizer |
| Legacy trips | Seeded ids `"1"`/`"2"` still bookable | Two trip systems must both carry ownership |

The booking page, seat availability, holds and Paystack flow are already trip-shaped and need no redesign. What is missing is **ownership**, **isolation**, and **one console identity**.

---

## 2. Console architecture (D1 + D2)

### One Worker, two hostnames

The Worker entry already owns `fetch(request)` outright, so host-based branching is a small change:

```
public host  → booking, tickets, student account, public APIs
console host → /console/*, /api/console/*, nothing else
```

Requests to console paths on the public host, or public paths on the console host, are rejected rather than redirected. A console route must never be reachable at a public URL, because that is where an attacker can get a victim's browser to issue a request.

### One identity, many roles

```sql
console_accounts (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  password_hash TEXT, password_salt TEXT, password_iterations INTEGER,
  role TEXT NOT NULL,                      -- ADMIN | MODERATOR | ORGANIZER | DRIVER
  status TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING | ACTIVE | SUSPENDED
  profile_id TEXT NOT NULL DEFAULT '',     -- organizer id or campus driver id
  token_version INTEGER NOT NULL DEFAULT 0,
  last_login_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
```

- **ADMIN / MODERATOR** — platform staff. Moderators review trips and organizer applications but do not touch money.
- **ORGANIZER** — `profile_id` → `trip_organizers.id`.
- **DRIVER** — `profile_id` → `campus_drivers.id`. Replaces the campus driver password entirely.

Guards are role-based: `requireConsoleRole(request, ["ADMIN"])`. An organizer session must never satisfy an admin check, and the check reads the role from the **session**, never from a header, body or query parameter.

### Sessions

One cookie, `umx_console_session`, **host-only on the console origin** so it is never attached to public-site requests. It reuses the primitives already proven in `lib/student-auth.ts` and `lib/admin-auth.ts`: PBKDF2 hashing, HMAC-signed payload, `token_version` revocation, and the `auth_failures` lockout.

### Migration

Admin and driver auth do not vanish on day one. Both keep working, and the console accounts are introduced alongside, then the old paths are removed once every console surface runs on the new identity. `TRUST_PLATFORM_IDENTITY` stays opt-in as it is today.

---

## 3. Data model

```sql
trip_organizers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  organization TEXT,                       -- public display name
  status TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING | APPROVED | SUSPENDED
  payout_method TEXT, payout_account_name TEXT,
  payout_account_number TEXT,              -- masked by default, audited on read
  paystack_recipient_code TEXT,
  commission_bps INTEGER NOT NULL DEFAULT 0,
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
  day_buses TEXT NOT NULL DEFAULT '', drop_off_points TEXT NOT NULL DEFAULT '',
  amenities TEXT NOT NULL DEFAULT '', contacts TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

organizer_payout_ledger (
  id TEXT PRIMARY KEY,
  organizer_id TEXT NOT NULL,
  booking_reference TEXT NOT NULL,
  gross_amount INTEGER NOT NULL,
  commission_amount INTEGER NOT NULL,
  net_amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACCRUED',  -- ACCRUED | RELEASED | REVERSED
  created_at TEXT NOT NULL, released_at TEXT
);
```

`bookings` gains `organizer_id` and `commission_amount`, both written at booking time so historical revenue never has to be recomputed from a rate that has since changed.

---

## 4. Isolation rules (the part that must not be got wrong)

1. **Every organizer query is scoped by `organizer_id` taken from the session**, never from a request body, query string or path.
2. A missing or unknown `organizer_id` on an organizer route is a `401`, not an empty list.
3. Trip mutations verify ownership with `UPDATE ... WHERE id = ? AND organizer_id = ?` and treat a zero-row result as `404`, so a probe cannot distinguish "not yours" from "does not exist".
4. Console routes are only mounted on the console host, and `/api/console/*` requires a console session even there.
5. **Passenger phone numbers (D3) are returned only to the owning organizer and to admin/moderator roles.** Every manifest read is written to `admin_audit_logs` with the console account as actor.
6. Role checks read from the signed session; a role claim in a request body is ignored.

---

## 5. Prerequisite: the console hostname does not exist yet

`scripts/deploy-cloudflare.sh` rewrites the generated config and sets only `name`, `main` and `assets`. There is **no `routes` entry**, so the Worker is reachable on `workers.dev` and nowhere else. Before any console work is reachable:

1. Bind a custom domain (or route) for `console.umatexpress.com` to the same Worker in Cloudflare.
2. Add that route in `scripts/deploy-cloudflare.sh` so a redeploy does not drop it.
3. Add the public origin to `CAMPUS_APP_URL`-style configuration so links resolve per host.

Until step 1 is done, host-based branching is untestable in production.

---

## 6. What changes in existing code

| File | Change |
|------|--------|
| `worker/index.ts` | Host-based branching: console host serves console surfaces only |
| `lib/console-auth.ts` | New: one identity, role guards, console session cookie |
| `lib/trip-settings.ts` | Notice becomes per organizer; `flyerPromoFromEnv()` stays as the platform fallback |
| `app/api/trips/display/route.ts` | `GET` returns the organizer's notice; `PATCH` moves to the console |
| `app/api/trips/schedule/route.ts` | Public reads return approved trips only |
| `app/admin/vacation/page.tsx` | Flyer editor leaves; gains organizer approval and trip moderation |
| `lib/trips.ts` | Trip reads gain an optional `organizerId` filter |
| `sql/000_...` | New tables and additive columns, idempotent, self-healing at read time |
| `scripts/deploy-cloudflare.sh` | Preserve the console route on deploy |

Legacy seeded trips keep working: `organizer_id` stays `NULL` and they belong to the platform until an admin assigns them.

---

## 7. Phases

### Phase 1 — Console identity (no money)
`console_accounts`, `lib/console-auth.ts`, host-based branching, console sign-in, and migration of the existing admin and driver sign-ins onto the unified identity. No organizer features yet.
**Acceptance:** admin and driver both sign in at the console origin; a public-host request to a console route is rejected; an organizer session cannot satisfy an admin guard; the old sign-in paths still work.

### Phase 2 — Organizer accounts and ownership (no money)
Organizer registration, `PENDING → APPROVED` by admin/moderator, `scheduled_trips.organizer_id`, `/console/trips` listing **only** the organizer's own trips and manifest with phone numbers, per-organizer notice.
**Acceptance:** an organizer registers, is approved, signs in, sees only their own trips and passenger contacts, and edits only their own notice. A second organizer cannot see or mutate the first organizer's data by any request. No money moves.

### Phase 3 — Self-service trip publishing
Organizers create and edit trips (route, date, times, capacity, price, coach type, amenities), submit for review, admin or moderator approves or rejects with a reason. The public page lists approved trips grouped by organizer.
**Acceptance:** an organizer publishes a bookable trip without admin data entry; an unapproved trip is never publicly bookable.

### Phase 4 — Money and attribution
Commission per organizer, `bookings.organizer_id` + `commission_amount`, payout ledger accrued on confirmed payment, admin-triggered payout batches, organizer statement view.
**Acceptance:** every confirmed booking produces exactly one ledger entry; a statement reconciles to the bookings behind it; refunds reverse the correct entry.

### Phase 5 — Scale
Paystack Transfers for automated payouts, suspension and dispute handling, route-overlap warnings, organizer analytics, rate limits on public trip reads.

---

## 8. Risks

| Risk | Mitigation |
|------|------------|
| Cross-tenant data leak | Session-derived scoping; ownership in the `WHERE` clause; tests asserting organizer B gets `404` for organizer A's ids |
| Phone-number exposure (D3) | Owning organizer plus admin/moderator only; every manifest read audited |
| Console reachable on the public host | Host check rejects tenant routes outright; test both hosts |
| Role escalation | Role read from the signed session only; one guard helper; tests that an organizer session fails every admin endpoint |
| Session cookie leaking to the public site | Host-only cookie on the console origin; verify it is absent from public requests |
| Payout disputes | Append-only ledger; releases recorded, never edited |
| Two organizers, same route and time | Warn on overlap; do not block, duplicate departures are legitimate |
| Seat inventory races | Existing hold path is trip-scoped; keep it that way, never organizer-scoped |
| Legacy trips orphaned | `organizer_id NULL` = platform-owned; admin assignment screen in Phase 2 |

---

## 9. Open questions

1. Is commission per organizer, per trip, or a platform default an admin can override?
2. Do students book one trip at a time, or can a single payment cover seats on two organizers' coaches?
3. Should an organizer also run campusRide trips, or is vacationRide the only surface?
