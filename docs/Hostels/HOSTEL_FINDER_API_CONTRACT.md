# Hostel Finder — API Contract (v1)

**Version:** 1.0  
**Status:** Draft for Review

---

## Overview

This document defines the request and response shapes for the core Hostel Finder endpoints in **Phase 1 and Phase 2**.

All monetary values are in **pesewas** (GHS × 100).

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