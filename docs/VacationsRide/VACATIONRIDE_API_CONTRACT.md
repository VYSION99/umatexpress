# vacationRide — API Contract

**Version:** 2.0  
**Status:** Draft for Review — corrected against the implementation  
**Scope:** the public booking flow as built, plus the Phase 2 console endpoints

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
      "createdAt": "2026-09-01T00:00:00.000Z"
    }
  ]
}
```

`?admin=1` additionally requires a staff session and includes inactive trips.

**Phase 2 change:** with organizers in the picture this read must also filter
`review_status = 'APPROVED'` and carry `organizerId` / organizer display name.

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
`activeTripIds`. It no longer returns the trip list itself.

**Phase 2 change:** the notice becomes per organizer (`trip_notices`), with the
platform notice as the fallback for trips that have no organizer.

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

A `Set-Cookie` payment-access token accompanies the response; the ticket cannot
be read without it. A live hold exists from this moment and expires in 10
minutes.

### `GET /api/payments/verify?reference=`

Returns the payment state, and the ticket once paid. Requires the access cookie.

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

## 4. Phase 2 console endpoints (to build)

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

## 5. Phase 3+ endpoints (not yet built)

Organizer trip create/edit and review submission, moderator approve/reject with a
reason, KYC submission and review, payout account capture, organizer statement
and payout batches. Amounts in every payout response are pesewas.
