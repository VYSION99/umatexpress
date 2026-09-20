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
| `GET/POST` | `/api/console/hostel/payouts` | admin | Who is owed what, and the batch a transfer was recorded under |
| `GET/POST` | `/api/console/hostel/payout-account` | landlord owner | The masked destination a payout is addressed to |
| `GET` | `/api/console/hostel/statement` | landlord | The landlord's own accrual statement and recorded transfers |

**Payout release policy.** A paid booking writes an `ACCRUED` row into
`hostel_payouts` carrying the gross, the platform's 9%, and the landlord's net.
The entry becomes payable three days before the academic year starts
(`release_after`), and an administrator records the transfer reference that
releases it. Recording a payout requires a verified (KYC) landlord and a saved
payout account; the account number is sealed at rest and only readable through
an audited reveal.

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

### `POST /api/hostel/chat/token`

**Request**
```json
{
  "bookingReference": "HF-2026A7B2C"
}
```

**Response (200)**
```json
{
  "ok": true,
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "clientId": "landlord:land-042",
  "channel": "hostel:booking:HF-2026A7B2C"
}
```

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
