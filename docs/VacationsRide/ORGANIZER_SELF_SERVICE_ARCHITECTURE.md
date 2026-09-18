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

### Implementation status

Phase 1 shipped as described in `docs/CONSOLE_ARCHITECTURE.md`:

- `console_accounts`, `lib/console-auth.ts` and `lib/console-signin.ts` — one
  identity, four roles, session-derived role checks.
- `lib/console-hosts.ts` + `worker/index.ts` — the console origin serves console
  surfaces only, and console paths are refused on the public host.
- `app/console/*` — the console entry, sign-in and password screens, with the
  service list scoped by role.
- Existing admin endpoints and the driver guard accept a console session, so
  both surfaces already run on the unified identity.

Still open in Phase 1: retiring the legacy admin and driver sign-ins, and
binding `console.umatexpress.com` to the Worker (see section 5).

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
  commission_bps INTEGER NOT NULL DEFAULT 300,  -- 300 bps = the platform's 3%
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

scheduled_trips (
  ...existing columns...,
  organizer_id TEXT,                       -- NULL only for legacy seeded trips
  review_status TEXT NOT NULL DEFAULT 'DRAFT'     -- DRAFT | PENDING_REVIEW | APPROVED | REJECTED | SUSPENDED
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
  gross_amount INTEGER NOT NULL,           -- the fare only (payments.fare_amount), in pesewas
  commission_amount INTEGER NOT NULL,
  net_amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACCRUED',  -- ACCRUED | RELEASED | REVERSED | FAILED
  created_at TEXT NOT NULL, released_at TEXT
);
```

`bookings` gains `organizer_id` and `commission_amount`, both written at booking time so historical revenue never has to be recomputed from a rate that has since changed.

`commission_amount` is charged on the **fare** (`payments.fare_amount`), never on
`bookings.amount`, which is the fare plus Paystack's pass-through charge. Full
definition in `VACATIONRIDE_PAYOUTS.md`.

Three corrections to the shape above, agreed during the document review:

1. **One payout table, not two.** `organizer_payout_ledger` and the
   `organizer_payouts` table in `VACATIONRIDE_PAYOUTS.md` describe the same rows.
   `organizer_payouts` is the name of record, and it carries the transfer fields
   (`release_after`, `transfer_reference`, `transferred_at`) as well. The states
   above are the ledger lifecycle; `VACATIONRIDE_PAYOUTS.md` owns the transfer
   lifecycle. This table is Phase 4 work.
2. **`review_status` defaults to `DRAFT`, never `APPROVED`.** A default of
   `APPROVED` would publish a trip the moment an insert forgot the column. The
   migration backfills the existing seeded trips to `APPROVED` explicitly.
3. **`commission_bps` defaults to 300.** A default of `0` means the organizer
   keeps 100%, which is the opposite of the product rule. The per-organizer
   value is copied onto the booking at confirmation, so a later rate change
   never rewrites history.

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

`scripts/deploy-cloudflare.sh` now writes a `routes` entry with `custom_domain: true` whenever `CLOUDFLARE_CONSOLE_HOST` is set, so a redeploy cannot drop the console domain. Remaining before the console is reachable on its own name:

1. Confirm `umatexpress.com` is in the same Cloudflare account, then deploy with `CLOUDFLARE_CONSOLE_HOST=console.umatexpress.com`.
2. Set the `CONSOLE_SESSION_SECRET` Worker secret.
3. Add `console.umatexpress.com` (and, until step 1 lands, the workers.dev host) to `CONSOLE_HOSTS`.

Until the DNS record exists, run the console on the workers.dev host or locally.

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

**Status:** built. One identity, role guards, the origin boundary, console sign-in and the role-scoped console home are in place; admin endpoints and the driver guard accept a console session. Legacy sign-ins still work, as required.

### Phase 2 — Organizer accounts and ownership (no money)
Organizer registration, `PENDING → APPROVED` by admin/moderator, `scheduled_trips.organizer_id`, `/console/trips` listing **only** the organizer's own trips and manifest with phone numbers, per-organizer notice.

**Status:** built. `lib/organizers.ts` owns the two records and keeps them in
step, `/console/register` takes applications, `/console/organizers` is the
review queue, `/console/trips` is the organizer workspace, and an admin panel on
the queue assigns trips because this phase has no trip creation. The public
notice read resolves a trip's organizer notice and falls back to the platform
notice. Three notes where the build settled a question the plan left open:

1. **`trip_organizers.status` gains `REJECTED`.** The API contract has always
   listed a `REJECT` action, but the enum here had no state for it. `REJECT` is
   terminal for the application and leaves `console_accounts.status` at
   `PENDING`, so a rejected applicant still cannot sign in and the console
   vocabulary stays three-valued.
2. **Staff reading a manifest must name the organizer** (`?organizerId=`), so an
   admin or moderator can read a manifest without an organizer session and the
   audit row still records whose trip it was. An organizer's own read ignores
   that parameter entirely.
3. **Trip assignment has a UI.** `PATCH /api/console/trips` was specified as an
   admin-only endpoint with no screen; without one, approving an organizer left
   no way to give them a trip.

Isolation is covered by `tests/organizer-isolation.test.mjs`, which drives the
real route handlers: organizer B gets `404` for organizer A's trip, a forged
`organizerId` in a query string changes nothing, a moderator is refused the
trip mutation, an unapproved organizer cannot be assigned a trip, a pending or
suspended account cannot reach the workspace, and a manifest read writes an
audit row.

Concrete scope, so the phase has no missing half:

| # | Deliverable | Where |
|---|-------------|-------|
| 1 | Organizer application (name, phone, email, password, organization) creating a `console_accounts` row with role `ORGANIZER` and status `PENDING` plus a `trip_organizers` row | `POST /api/console/organizers/register`, `/console/register` |
| 2 | Application queue: approve, reject with a reason, suspend | `GET/PATCH /api/console/organizers`, `/console/organizers` (ADMIN + MODERATOR) |
| 3 | Account and business record kept in step: approval sets `console_accounts.status = ACTIVE` and `trip_organizers.status = APPROVED`; suspension sets both to `SUSPENDED` and bumps `token_version` so live sessions die | `lib/organizers.ts` |
| 4 | Admin assigns an existing trip to an organizer (`scheduled_trips.organizer_id`), because Phase 2 has no trip creation | `PATCH /api/console/trips`, admin-only |
| 5 | Organizer trip list + passenger manifest with phone numbers, every read audited | `GET /api/console/trips`, `GET /api/console/trips/[id]/manifest` |
| 6 | Per-organizer trip notice replacing the global notice for their trips | `PUT /api/console/trips/notice`, `trip_notices` |
| 7 | Console service cards split so a moderator reviews applications and an organizer works on their own trips | `components/admin/console-services.ts` |

**Acceptance:** an organizer registers, is approved, signs in, sees only their own trips and passenger contacts, and edits only their own notice. A second organizer cannot see or mutate the first organizer's data by any request. A `PENDING` organizer cannot sign in. A suspended organizer's live session stops working on the next request. No money moves.

**Test requirements:** organizer B gets `404` for organizer A's trip id, booking reference and notice; a forged `organizer_id` in a body or query string changes nothing; a moderator session can approve an application but is refused every admin-only trip mutation; every manifest read writes one audit row.

### Phase 3 — Self-service trip publishing — **Shipped**
Organizers create and edit trips (route, date, times, capacity, price, coach type, amenities), submit for review, and an admin or moderator approves or rejects with a reason. The public page lists approved trips grouped by organizer, labelled with the organizer's display name (falling back to `UMaTeXPRESS` for platform trips).
**Acceptance:** an organizer publishes a bookable trip without admin data entry; an unapproved trip is never publicly bookable; an edit to a live trip re-enters review; another organizer's trip id returns `404` on every read and write; KYC and the payout account are stored for the money phases without ever being returned in the clear.

**Carried forward to Phase 4:** the payout release rule (never before departure + 24h, settled funds only) and every question about how a payout batch is assembled. Phase 3 captures the account; it pays nothing.

### Phase 4 — Money and attribution — **Shipped**
Commission per organizer, `bookings.organizer_id` + `commission_amount`, `organizer_payouts` ledger accrued on confirmed payment, `organizer_payout_batches` recorded by an administrator, organizer statement at `/console/earnings` and the money console at `/console/payouts`.
**Acceptance:** every confirmed booking produces exactly one ledger entry; a statement reconciles to the bookings behind it; refunds reverse the correct entry. All three are covered by `tests/organizer-payouts.test.mjs`, including a payment confirmed through the real verify route.

**Decided here:** the ledger is append-only (status and timestamps change, never an amount); a reversal of a released entry becomes a debt that blocks the next batch until it is settled, rather than being silently netted; and recording a payout is ADMIN-only, because it is the last human step before money moves.

### Phase 5 — Automated payouts — **Shipped**
Paystack Transfers, a release job that drains what is due, a reconcile job for a
webhook that never arrived, and a settlement gate that reads Paystack's own
balance instead of assuming the money is there.

**Acceptance:** a due entry with no destination is never sent; the settled
balance is the ceiling; an in-flight transfer is not sent twice; a failed
transfer returns its entries to the ledger; an entry is released only when
Paystack says the money arrived; and a reversal is not a debt. Covered by
`tests/payout-transfers.test.mjs`, plus the cron-collision test in
`tests/cloudflare-bindings.test.mjs`.

**Decided here:** unattended transfers are opt-in (`PAYOUT_AUTO_ENABLED`), while
a run from the console is attended and is audited to the administrator who
started it; a transfer fee is budgeted per transfer rather than assumed away;
and a transfer that reverses puts the money back on the ledger instead of
creating a debt, because the platform still holds it.

### Phase 6 — Trust and insight
Suspension and dispute handling, route-overlap warnings, organizer analytics, rate limits on public trip reads. Suspension itself exists; the dispute trail around it does not.

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

Resolved during the document review:

1. **Commission format** — per-organizer rate in basis points (`commission_bps`, default `300`), copied onto the booking at confirmation. Whether an admin may override the default per organizer is a Phase 4 decision; the Phase 2 schema already carries the column.
2. **Booking model** — one booking covers one seat on one trip, and only a signed-in student may create one (`POST /api/payments/initialize` calls `requireStudent`). A single payment spanning two organizers' coaches is therefore out of scope.
3. **Organizer surface** — vacationRide only. A campusRide driver is a separate role with a separate profile id; the two never share a record.

Still open, and deliberately parked until the phase that spends money:

| Question | Needed by |
|----------|-----------|
| ~~Payout release rule: is `release_after` the next 12:00 AM, or after the coach has departed?~~ | **Decided: never before departure + 24h, on settled funds only — enforced in Phase 4** |
| ~~Are KYC documents stored, or is only the ID type and number recorded?~~ | **Decided: ID type and number only. No scan is uploaded; storing documents needs an R2 binding and a retention policy first** |
| ~~Manual payout batches before automated Paystack Transfers?~~ | **Decided: ledger and hand-recorded batches in Phase 4 (shipped); Paystack Transfers in Phase 5** |
| ~~Refund after a payout: the affected organizer's balance goes negative and the next payout absorbs it?~~ | **Decided: the reversal is a carried debt that blocks the next batch until settled. Phase 5 automates the netting** |
