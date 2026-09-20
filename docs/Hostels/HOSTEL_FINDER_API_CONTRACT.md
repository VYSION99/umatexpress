# Hostel Finder — API Contract (v1)

**Version:** 1.0  
**Status:** Draft for Review

---

## Overview

This document defines the request and response shapes for the core Hostel Finder endpoints in **Phase 1 and Phase 2**.

All monetary values are in **pesewas** (GHS × 100).

### As-built surface (current)

The routes below are what the deployed Worker serves today. The design paths in
sections 1–4 are kept for shape reference where they differ; the console is one
origin for every service, so admin and landlord endpoints live under
`/api/console/hostel/*` and are gated by the signed console session and role.

| Method | Route | Role | What it does |
| --- | --- | --- | --- |
| `GET` | `/api/hostel/properties` | public | Approved beds grouped per property, with pin, distance and cheapest total |
| `GET` | `/api/hostel/spaces` | public | The beds inside one property for the open year |
| `GET` | `/api/hostel/periods` | public | Academic years a price can be quoted against |
| `POST` | `/api/hostel/bookings` | student session | Hold a bed for 10 minutes and start Paystack checkout |
| `GET` | `/api/hostel/bookings/verify` | payment cookie / owner | Confirm a checkout and turn it into a residency |
| `GET` | `/api/hostel/resident` … | student session | The resident page: bed, host contact, services, thread, notices |
| `GET/POST` | `/api/console/hostel/residents`, `/services`, `/messages`, `/announcements`, `/managers` | landlord | The host workspace |
| `GET/POST` | `/api/console/hostel/plugins` | landlord | Switch a service on for the year |
| `GET/POST` | `/api/console/hostel/plugins/catalogue` | admin | The platform price list behind every landlord's services |
| `GET/POST` | `/api/console/hostel/payouts` | admin | Who is owed what; `action: "SEND"` pays through Paystack, `"RECORD"` records a manual transfer, `"RECONCILE"` settles in-flight ones |
| `GET/POST` | `/api/console/hostel/payout-account` | landlord owner | The masked destination a payout is addressed to |
| `GET` | `/api/console/hostel/statement` | landlord | The landlord's own accrual statement and recorded transfers |
| `GET/POST` | `/api/hostel/reviews` | public read / paid student | Published reviews for a building; a paid stay writes exactly one |
| `GET/POST` | `/api/console/hostel/reviews` | landlord, admin, moderator | The hostel answers its own reviews once; staff may hide with a reason |
| `GET/POST` | `/api/hostel/refunds` | student session | The policy price of cancelling a bed, and the request to cancel |
| `GET/POST` | `/api/console/hostel/refunds` | admin | The refund queue: `APPROVE` (optionally overridden with a reason), `DECLINE`, `RECORD`, `RECONCILE` |
| `GET/POST` | `/api/console/hostel/analytics` | admin | Occupancy, the booking pipeline, money and trust in one read |
| `GET/POST` | `/api/console/hostel/signals` | admin, moderator | The trust desk: `SCAN` raises rule-based signals, `REVIEW`/`DISMISS` closes them |
| `GET` | `/api/hostel/messages/stream` | student cookie/owner | Server-sent events for one thread, bounded and self-reconnecting |
| `GET` | `/api/console/hostel/messages/stream` | landlord | The host's side of the same live thread |
| `POST` | `/api/hostel/ask` | public | Answer a question from one listing's public facts only |

**Refund policy.** A cancellation is priced by the calendar: a month or more
before the year starts is 100%, inside a month but more than a week out is 50%,
and inside the last week nothing. An administrator may override the percentage
with a mandatory reason. Approving reverses the bed's accrual and frees the
bed; if the entry had already been transferred the reversal becomes a debt on
the landlord's next payout. The booking only reaches `REFUNDED` when Paystack
(or a recorded manual transfer) settles the money.

**The assistant's fence.** `POST /api/hostel/ask` builds one facts block from
the same public query the listing page uses — beds on sale, prices, utilities,
distance, published reviews — and the model may answer from nothing else. It
cannot see other buildings, cannot promise availability, and falls back to a
written summary when Workers AI is not configured.

**Payout release policy.** A paid booking writes an `ACCRUED` row into
`hostel_payouts` carrying the gross, the platform's 3%, and the landlord's net.
The entry becomes payable three days before the academic year starts
(`release_after`). Paying it requires a verified (KYC) landlord and a saved
payout account; the account number is sealed at rest and only readable through
an audited reveal.

**How the money leaves.** `action: "SEND"` claims the payable entries as
`PROCESSING` under a new `AUTO` batch, creates (or reuses) a Paystack transfer
recipient, and asks Paystack to transfer the net. The entries only become
`RELEASED` when Paystack settles — inline, through the `transfer.*` webhook, or
through the reconcile job that runs on the payout cron. A refusal returns the
entries to the ledger with `payout_attempts` incremented and `last_error` set,
so money that never moved is still owed; after three attempts an entry is
`FAILED` and needs a person. One `PENDING` batch per landlord is enforced, so a
double-click cannot pay twice. `action: "RECORD"` stays for a transfer made by
hand, and releases the entries immediately under the reference given.

---

## 1. Public / Student Endpoints

### `GET /api/hostel/periods`

**Response (200)**
```json
{
  "ok": true,
  "periods": [
    {
      "id": "per-2026",
      "name": "2026/27 Academic Year",
      "starts_on": "2026-09-01",
      "ends_on": "2027-06-30"
    }
  ]
}
```

---

### `GET /api/hostel/properties?periodId=per-2026&maxDistance=5000`

**Response (200)**
```json
{
  "ok": true,
  "properties": [
    {
      "id": "prop-001",
      "name": "Green View Hostel",
      "address": "Near UMaT Main Gate",
      "latitude": 5.3009,
      "longitude": -1.9897,
      "campus_distance_m": 450,
      "utilities_enabled": true,
      "available_spaces": 12
    }
  ]
}
```

---

### `GET /api/hostel/spaces?propertyId=prop-001&periodId=per-2026`

**Response (200)**
```json
{
  "ok": true,
  "spaces": [
    {
      "listing_id": "lst-045",
      "space_id": "spc-003",
      "room_label": "Room 3",
      "space_label": "Bed A",
      "capacity": 4,
      "price": 180000,
      "utilities_fee": 20000,
      "total": 200000
    }
  ]
}
```

---

### `POST /api/hostel/bookings`

**Request**
```json
{
  "listingId": "lst-045",
  "studentName": "Kwame Mensah",
  "phone": "0241234567",
  "email": "kwame@example.com"
}
```

**Response (201)**
```json
{
  "ok": true,
  "booking": {
    "id": "book-789",
    "reference": "HF-2026A7B2C",
    "expiresAt": "2026-08-20T14:30:00Z",
    "authorizationUrl": "https://checkout.paystack.com/..."
  }
}
```

---

### `GET /api/hostel/bookings/verify?reference=HF-2026A7B2C`

**Response (200)**
```json
{
  "ok": true,
  "paid": true,
  "status": "CONFIRMED",
  "ticket": {
    "reference": "HF-2026A7B2C",
    "studentName": "Kwame Mensah",
    "property": "Green View Hostel",
    "room": "Room 3",
    "space": "Bed A",
    "period": "2026/27 Academic Year",
    "amount": 200000
  }
}
```

---

## 2. Landlord Endpoints

### `POST /api/landlord/auth`

**Request**
```json
{
  "phone": "0551234567",
  "password": "Landlord@123"
}
```

**Response (200)**
```json
{
  "ok": true,
  "landlord": {
    "id": "land-042",
    "name": "Mr. Owusu",
    "kycStatus": "VERIFIED"
  }
}
```

---

### `POST /api/landlord/properties`

**Request**
```json
{
  "name": "Green View Hostel",
  "address": "Near UMaT Main Gate",
  "latitude": 5.3009,
  "longitude": -1.9897
}
```

**Response (201)**
```json
{
  "ok": true,
  "property": { "id": "prop-001", ... }
}
```

---

### `POST /api/landlord/listings`

**Request**
```json
{
  "spaceId": "spc-003",
  "periodId": "per-2026",
  "price": 180000
}
```

**Response (201)**
```json
{
  "ok": true,
  "listing": {
    "id": "lst-045",
    "status": "DRAFT"
  }
}
```

---

## 3. Admin Endpoints

### `POST /api/admin/hostel/periods`

**Request**
```json
{
  "name": "2027/28 Academic Year",
  "startsOn": "2027-09-01",
  "endsOn": "2028-06-30"
}
```

**Response (201)**
```json
{
  "ok": true,
  "period": { "id": "per-2027", ... }
}
```

---

### `POST /api/admin/hostel/listings/:id/approve`

**Response (200)**
```json
{
  "ok": true,
  "listing": {
    "id": "lst-045",
    "status": "APPROVED"
  }
}
```

---

### `POST /api/admin/hostel/payouts/:id/release`

**Response (200)**
```json
{
  "ok": true,
  "payout": {
    "id": "payout-112",
    "status": "APPROVED",
    "releaseAfter": "2026-08-29"
  }
}
```

---

## 4. Chat Endpoints

**As built.** The thread is durable in Turso — one row per message per booking —
and reads mark the counterpart's messages as read. Realtime is a bounded
server-sent event stream over that same table, not Ably: the chat integration
doc's `POST /api/hostel/chat/token` is not served. A connection waits a few
seconds at a time for the thread's newest id to change, sends `{ changed, latestId }`,
then closes and lets the browser's `EventSource` reconnect. The client never
applies the event directly; it re-reads through the ordinary thread endpoint,
which is also what marks the message read. A deployment without the stream
still works, because the resident page refreshes on its own interval.

### `GET /api/hostel/messages/stream?reference=HF-2026A7B2C&after=<messageId>`

**Response** `text/event-stream`

```
retry: 2000

data: {"changed":true,"latestId":"msg-418"}
```

The student's stream is authorised by the payment cookie or the signed-in
student; the host's stream (`/api/console/hostel/messages/stream`) by the signed
console session and ownership of the booking. Both are rate-limited, and the
host's `HOST`-viewed messages are the only ones marked read there.

---

## 5. Error Response Format (All Endpoints)

```json
{
  "ok": false,
  "code": "INVALID_STATE",
  "error": "This space is no longer available."
}
```

**Common Error Codes:**
- `VALIDATION_ERROR`
- `UNAUTHORIZED`
- `FORBIDDEN`
- `NOT_FOUND`
- `INVALID_STATE`
- `CONFIG_REQUIRED`

---

**End of API Contract**
