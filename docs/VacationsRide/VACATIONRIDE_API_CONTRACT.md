# vacationRide — API Contract

**Version:** 2.2  
**Status:** Draft for Review — corrected against the implementation  
**Scope:** the public booking flow as built, plus the Phase 2–6 console endpoints

---

## 0. Conventions

- **Amounts.** `scheduled_trips.price` is GHS. Everything that touches Paystack
  (`payments.amount`, `payments.fare_amount`, `bookings.amount`, payout rows) is
  an integer in **pesewas** (GHS × 100). The payment layer converts.
- **Booking requires a student account.** Anyone may browse trips and seats;
  holding a seat and paying calls `requireStudent`, so a request without a valid
  student session gets `401`.
- **Console endpoints** live on the console origin, under `/api/console/*`, and
  require a `umx_console_session` cookie. The role is read from that signed
  session and never from the request.
- Errors are `{ "error": "..." }` with the status carrying the meaning
  (`400` validation, `401` no session, `403` wrong role, `404` not yours or not
  found, `429` rate limited). Console routes use the campus engine shape
  `{ ok: false, code, error }` where they reuse its handlers.

---

## 1. Public trip reads

### `GET /api/trips/schedule`

**Purpose:** the trips a visitor may book. Active, unarchived trips only.

**Response (200)**
```json
{
  "trips": [
    {
      "id": "1",
      "title": "UMaT → Accra",
      "from": "UMaT",
      "to": "Accra",
      "travelDate": "2026-09-05",
      "time": "06:30",
      "arrival": "11:30",
      "price": 180,
      "capacity": 50,
      "coachType": "VIP Coach",
      "tag": "Morning Express",
      "amenities": ["AC", "Wi-Fi", "USB power"],
      "notes": "",
      "active": true,
      "archived": false,
      "displayOrder": 1,
      "organizerName": "Mensah Travel",
      "createdAt": "2026-09-01T00:00:00.000Z"
    }
  ]
}
```

`?admin=1` additionally requires a staff session and includes inactive trips.

**Built (Phase 2/3):** this read filters `review_status = 'APPROVED'` and carries
the organizer's display name (`organization`, falling back to the contact name,
falling back to `UMaTeXPRESS`). It never carries a contact or payout field.

### `GET /api/trips/availability?tripId=&travelDate=`

**Response (200)**
```json
{ "unavailableSeats": [3, 7, 12], "availableCount": 47, "capacity": 50 }
```

Seats are unavailable when a `seat_holds` row is `BOOKED` or `HELD` and unexpired.
A missing or mismatched `travelDate` is a `400`.

### `GET /api/trips/display`

Display settings for the public page: `mode`, `morningDeparture`,
`morningArrival`, `eveningDeparture`, `eveningArrival`, `flyerPromo`,
`activeTripIds`, `notices`. It no longer returns the trip list itself.

**Phase 2 change:** the notice becomes per organizer (`trip_notices`), with the
platform notice as the fallback for trips that have no organizer.

`notices` is the public carousel feed: the platform notice first (when enabled
and non-empty), then every approved organizer's enabled notice ordered by name.
Each entry is `{ id, organizerName, platform, promo, routes }`, where `routes`
holds the live approved coaches the notice belongs to:

```json
{
  "id": "org_123",
  "organizerName": "Mensah Travel",
  "platform": false,
  "promo": { "enabled": true, "title": "Mensah Travel", "fare": "GH₵ 190", "…": "…" },
  "routes": [{ "from": "UMaT Main Campus", "to": "Kumasi" }]
}
```

Rules:

- The card composes its route line from `routes` (`UMaT Main Campus → Accra,
  Kumasi, Sunyani`), not from the saved `promo.route`, which is only the
  fallback while nothing is on sale.
- Drop-off points fall back to the distinct live destinations when the saved
  list is empty.
- Text that is only a placeholder (`---`, `GHS ---`) is dropped before the
  response, so it can never render as a fare or a departure.
- An organizer's notice is included only while that organizer has at least one
  live approved trip; the platform never amplifies a flyer nobody can book.
- `flyerPromo` still answers `?tripId=` for the single-trip preview, so the
  admin console keeps working.

### `POST /api/trips/ai-search`

"Find my trip" in the student's own words. The endpoint reads the same public,
approved trips the page shows (including the legacy morning/evening visibility
filter), then either the model or the deterministic matcher chooses one id.

**Request**
```json
{ "message": "I want to go to Accra next Friday" }
```

**Response (200)**
```json
{ "ok": true, "tripId": "3", "reply": "Found the 07:00 coach from UMaT Main Campus to Accra on Fri 25 Sep. Fare GH₵ 45 per student. ..." }
```

`tripId` is always an id from the list the caller can see, and `reply` is always
composed from the real trip row — the model only chooses the id, so it cannot
invent a fare, a date or a coach. A hallucinated id, an unusable answer or a
missing model falls back to the deterministic matcher (route words plus a
parsed travel date), and a destination with no coach that day is reported
honestly instead of quietly choosing another day. 20 requests / 10 minutes per
address; empty messages are a `400`.

---

## 2. Booking and payment

There is no `POST /api/bookings`. Booking and payment are one call, which is
what keeps a seat hold and a payment reference from drifting apart.

### `POST /api/payments/initialize` — student session required

**Request**
```json
{
  "tripId": "1",
  "travelDate": "2026-09-05",
  "seat": 14,
  "name": "Ama Serwaa",
  "email": "ama@st.umat.edu.gh",
  "phone": "0241234567"
}
```

`email` must equal the signed-in student's address; the account address is what
is stored, so a booking can never be made under someone else's email.

**Response (202)**
```json
{
  "reference": "UMX-...-PAY",
  "status": "PENDING",
  "provider": "PAYSTACK",
  "authorizationUrl": "https://checkout.paystack.com/abc123",
  "fareAmount": 18000,
  "feeAmount": 300,
  "totalAmount": 18300,
  "message": "Redirecting to Paystack Checkout."
}
```

A `Set-Cookie` payment-access token accompanies the response. The token is the
guest's key to the ticket and expires after one hour; a passenger who is signed
in keeps access to their own booking without it (see below). A live hold exists
from this moment and expires in 10 minutes.

### `GET /api/payments/verify?reference=`

Returns the payment state, and the ticket once paid. Authorised by the payment
access cookie, or by a signed-in student whose account email matches the
booking's email — booking forces the receipt address to be the account's own,
so a signed-in passenger can reopen their ticket on any device after the
one-hour cookie expires. Everyone else is refused.

A ticket link opened without either gets a sign-in handoff rather than a dead
end: the page points at `/account?next=<the ticket URL>`, and the student lands
back on the ticket once signed in.

### `POST /api/payments/webhook`

Paystack calls this. `x-paystack-signature` is verified, `payment_events`
deduplicates deliveries, and a payment that lands after its hold expired moves
the booking to `PAYMENT_RECEIVED_REVIEW` rather than being accepted or dropped.

---

## 3. Staff endpoints (existing)

| Endpoint | Notes |
|----------|-------|
| `POST /api/console/session` | Unified sign-in for every console role |
| `GET /api/admin/auth` | Reports the staff session (console or legacy) |
| `GET /api/admin/bookings` | Booking list |
| `DELETE /api/admin/bookings` | Cancels a booking; the audit row is written before the delete |
| `POST /api/trips/schedule` | Create a trip (admin) |
| `PATCH /api/trips/display` | Display mode and platform notice (admin) |

---

## 4. Phase 2 console endpoints (built)

Ownership always comes from the session. An id in a body or query string never
selects the tenant.

### `POST /api/console/organizers/register` — no session, rate limited

```json
{ "name": "Kofi Mensah", "phone": "024...", "email": "kofi@example.com", "password": "...", "organization": "Mensah Travel" }
```

Creates `console_accounts` (role `ORGANIZER`, status `PENDING`) and
`trip_organizers` (status `PENDING`). Response `202`. A second application on the
same email or phone is refused.

### `GET /api/console/organizers` — ADMIN, MODERATOR

Applications and organizers with their status. `?status=PENDING` filters.

### `PATCH /api/console/organizers` — ADMIN, MODERATOR

```json
{ "organizerId": "...", "action": "APPROVE" | "REJECT" | "SUSPEND", "reason": "..." }
```

`APPROVE` sets `console_accounts.status = ACTIVE` and
`trip_organizers.status = APPROVED`. `SUSPEND` sets both to `SUSPENDED` and
bumps `token_version`, so live sessions stop working on the next request.
Every action writes one audit row.

### `GET /api/console/trips` — ORGANIZER

The signed-in organizer's trips only: id, route, date, times, capacity, seats
sold, review status. A `PENDING` account cannot reach this.

### `GET /api/console/trips/[tripId]/manifest` — ORGANIZER, ADMIN, MODERATOR

Passenger list for one of the organizer's own trips: name, seat, booking
reference, phone, booking status. Another organizer's trip id returns `404`.
Every read writes one audit row naming the account, the trip and the rows
returned.

### `PUT /api/console/trips/notice` — ORGANIZER

Per-organizer notice: `enabled`, `title`, `route`, `fare`, `nightBus`,
`dayBuses`, `dropOffPoints`, `amenities`, `contacts`. Partial updates merge onto
the stored notice.

### `PATCH /api/console/trips` — ADMIN only (Phase 2 stopgap)

Assigns an existing trip to an organizer (`{ "tripId": "...", "organizerId": "..." }`),
because organizer-created trips arrive in Phase 3.

---

## 5. Phase 3 console endpoints (built)

`POST /api/console/trips` (ORGANIZER) creates a trip for the signed-in
organizer. The owner is the session's profile id, never a body field. The trip
is written `DRAFT` and inactive, so an approval is the only thing that can make
it bookable.

`PATCH /api/console/trips/[tripId]` and `DELETE` (ORGANIZER) edit and archive a
trip the session owns. Ownership is part of the `WHERE` clause, so another
organizer's id returns `404` rather than `403`. **Editing an `APPROVED` trip
sends it back to `PENDING_REVIEW`** and turns `active` off in the same
statement — nothing an organizer writes reaches students unreviewed. `DELETE`
refuses a live trip; ask an admin to pull it first.

`PATCH /api/console/trips/[tripId]/review` — one endpoint for the whole state
machine:

```json
{ "action": "SUBMIT" | "APPROVE" | "REJECT" | "SUSPEND", "reason": "..." }
```

`SUBMIT` is ORGANIZER-only, for the caller's own trip, and allowed from
`DRAFT`, `REJECTED` or `SUSPENDED`. `APPROVE`/`REJECT` are ADMIN and MODERATOR
and only leave `PENDING_REVIEW`. `SUSPEND` is ADMIN-only: it takes down a trip
students can currently buy. `REJECT` and `SUSPEND` require a reason, which is
stored as the trip's `reviewReason` and shown to the organizer. An approval
sets `active = 1`; every other decision sets `active = 0`.

`GET /api/console/trips/review` (ADMIN, MODERATOR) is the queue: every trip in
`PENDING_REVIEW`, oldest submission first, with `platformOwned: true` when the
trip has no organizer.

`GET /api/console/organizers/profile` (ORGANIZER) returns the caller's KYC and
payout record with the ID and account numbers **masked**. There is no query
parameter that widens it, so the response is safe to render anywhere.

`PUT /api/console/organizers/profile/kyc` (ORGANIZER) captures
`{ idType, idNumber }`. The number is sealed with AES-GCM before it is stored.
No scan is uploaded: the Worker has no object-storage binding, and identity
documents need a retention policy before they are kept.

`PUT /api/console/organizers/profile/payout` (ORGANIZER) captures
`{ method: "BANK" | "MOMO", accountName, accountNumber }`. The number is sealed;
only the last four digits are stored in the clear, for the mask. **Capturing a
payout account is not the same as being eligible to be paid** — KYC
verification and the Phase 4 ledger are separate gates.

`POST /api/console/organizers/reveal` — ADMIN only. `{ "organizerId": "..." }`
returns the full payout account and ID number, and **every call writes an audit
row** naming the actor and the fields opened. This is the only path that returns
an unsealed value.

`PATCH /api/console/organizers` also accepts `VERIFY_KYC` and `REJECT_KYC`
(ADMIN, MODERATOR). KYC is the money gate, not the account gate: it is decided
on its own and never changes whether an organizer can sign in or publish.
`REJECT_KYC` requires a reason; a fresh submission clears the previous decision.

---

## 6. Phase 4 endpoints (built)

Every amount in a payout response is an integer in **pesewas**.

`GET /api/console/payouts/statement` (ORGANIZER) returns the caller's own
statement: `totals` (`accrued`, `ready`, `released`, `reversed`, `debt`,
`balance`, `entries`), up to 200 ledger entries and up to 50 recorded batches.
The organizer id comes from the signed session; a `?organizerId=` is ignored.

`GET /api/console/payouts` (ADMIN) lists every organizer with their totals.
`?organizerId=` returns one organizer — account details are the **masked** ones
from the profile read — plus their statement.

`POST /api/console/payouts` (ADMIN) records a payout the administrator has
already made by hand:

```json
{ "organizerId": "...", "reference": "TRF-2026-01", "note": "January batch" }
```

Every `ACCRUED` entry whose `release_after` has passed moves to `RELEASED` in
the same statement, carrying the reference. The batch is refused with `409`
when KYC is not `VERIFIED`, when the organizer is not `APPROVED`, when nothing
is ready yet, or when a refund after payout left the balance in debt. Two
admins recording the same batch cannot release one entry twice: the status
check is part of the `UPDATE`.

`POST /api/console/payouts/backfill` (ADMIN) rebuilds ledger rows for confirmed
bookings that a failed write left without one. Idempotent, bounded to 20
bookings per call (each costs a couple of subrequests), and audited like the
rest.

---

## 7. Phase 5 endpoints (built)

`GET /api/console/payouts` gained an `automation` block: whether unattended
runs are enabled, the payment provider, the budgeted per-transfer fee, and the
settled Paystack balance (or `null` when Paystack cannot be reached). The
organizer detail gained `payoutBankName` and `recipientReady` so the console can
say why a payout cannot be addressed.

`POST /api/console/payouts/run` (ADMIN) is the attended path:

```json
{ "action": "RELEASE" | "RECONCILE" | "RETRY", "organizerId": "required for RETRY" }
```

- `RELEASE` sends what is due, up to six organizers, in the order the entries
  were earned, and stops when the settled balance (less the transfer fee) would
  be exceeded. It is not gated by `PAYOUT_AUTO_ENABLED`, because a person
  pressing the button is the deliberate act; it is audited to them.
- `RECONCILE` verifies up to four in-flight transfers and settles the ones
  Paystack has completed.
- `RETRY` reopens an organizer's parked `FAILED` entries so the next run tries
  again.

The cron jobs call the same functions. `PAYOUT_RELEASE_CRON` (`7,22,37,52 * * * *`)
is gated by `PAYOUT_AUTO_ENABLED`; `PAYOUT_RECONCILE_CRON` (`9,39 * * * *`) is
not, since it only ever reads and settles what was already sent.

`POST /api/payments/webhook` now also accepts `transfer.success`,
`transfer.failed` and `transfer.reversed`, matching the batch by our own
reference and falling back to Paystack's transfer code. A settlement that the
webhook already applied makes a later reconcile a no-op, and vice versa.

---

## 8. Phase 6 endpoints (built)

### `GET /api/disputes` — student session required

Returns `{ ok: true, disputes: [...] }` for the signed-in student's own
disputes, newest first. The account comes from the session, never the request,
so one student cannot read another's.

### `POST /api/disputes` — student session required

```json
{ "bookingReference": "UMX-AB12CD", "category": "DELAY", "subject": "Coach left early", "details": "..." }
```

`subject` is 4–120 characters and `details` at least 20; `category` defaults to
`OTHER`. The booking must have been made with the signed-in account's email
(`403` otherwise) and the trip and organizer are copied from that booking. The
reply contact is the account email, never a field in the request. Rate limited
to 5 per hour. Returns `201` with the created dispute.

### `GET /api/console/disputes` — ADMIN, MODERATOR, ORGANIZER

An organizer receives only the disputes about their own trips. An administrator
receives the queue with per-status `counts`, optionally filtered by
`?status=OPEN`; a moderator receives the same list with `readOnly: true`,
because a moderator may read the queue but not decide it.

### `POST /api/console/disputes`

```json
{ "action": "OPEN" | "RESOLVE" }
```

- `OPEN` — ADMIN or ORGANIZER. An organizer must supply a `bookingReference` on
  one of their own trips (or a `tripId` they own); an administrator may open on
  any of them. Rate limited to 10 per hour.
- `RESOLVE` — ADMIN only. Body: `{ "disputeId", "status", "resolution", "note" }`,
  where `status` is `REVIEWING`, `RESOLVED` or `DISMISSED` and `note` is
  required once the status is `RESOLVED`. The action is audited as
  `DISPUTE_RESOLVED` with the administrator's email.

A resolution records a decision; it does not move money. The refund and payout
paths remain the only writers of the ledger.

### Changed in Phase 6

- `GET /api/console/payouts/statement` now returns `insights` and `trips` beside
  the statement: seats sold over seats offered and gross/net/accrued/released
  per trip, all read from the same ledger as the statement. A trip with no
  recorded capacity reports `sellThrough: 0`.
- `POST /api/console/trips` and `PATCH /api/console/trips/[tripId]` return an
  `overlaps` array in the response: other live or pending departures on the same
  route and date within three hours, `own` marking the organizer's own. Saving a
  trip is never blocked by one.
- `GET /api/trips/schedule` (240/min), `GET /api/trips/display` (240/min) and
  `GET /api/trips/availability` (300/min) are rate limited per address; the
  AI search is 20/10 min because it can call Workers AI; the
  schedule's limit does not apply to the signed-in `?admin=1` view.
