# vacationRide — API Contract (Selected Endpoints)

**Version:** 1.0  
**Status:** Draft for Review

---

## Overview

This document highlights key public and admin-facing endpoints for **vacationRide**. It focuses on the most important flows rather than documenting every route.

---

## 1. Public Endpoints

### `GET /api/trips/display`

**Purpose:** Returns the currently active trip(s) for the enabled travel date.

**Response (200)**
```json
{
  "ok": true,
  "trips": [
    {
      "id": 1,
      "route_from": "UMaT",
      "route_to": "Accra",
      "travel_date": "2026-08-28",
      "departure_time": "06:30",
      "arrival_time": "14:00",
      "capacity": 50,
      "price": 18000,
      "available_seats": 42
    }
  ]
}
```

---

### `GET /api/trips/availability?tripId=1`

**Purpose:** Returns seat availability map for a specific trip.

**Response (200)**
```json
{
  "ok": true,
  "trip_id": 1,
  "unavailable": [3, 7, 12, 18, 22, 35]
}
```

---

### `POST /api/trips/schedule`

**Purpose:** (Admin) Create or update a scheduled trip.

**Request**
```json
{
  "route_from": "UMaT",
  "route_to": "Accra",
  "travel_date": "2026-08-28",
  "departure_time": "06:30",
  "capacity": 50,
  "price": 18000
}
```

---

## 2. Booking Flow Endpoints

### `POST /api/bookings`

**Purpose:** Create a new booking (initiates seat hold).

**Request**
```json
{
  "trip_id": 1,
  "seat": 14,
  "passenger_name": "Ama Serwaa",
  "email": "ama@example.com",
  "phone": "0241234567"
}
```

**Response (201)**
```json
{
  "ok": true,
  "booking": {
    "id": "book-12345",
    "reference": "UMX-98765",
    "hold_expires_at": "2026-08-20T10:40:00Z"
  }
}
```

---

### `POST /api/payments/initialize`

**Purpose:** Initialize Paystack transaction for a booking.

**Request**
```json
{
  "booking_reference": "UMX-98765"
}
```

**Response (200)**
```json
{
  "ok": true,
  "authorization_url": "https://checkout.paystack.com/abc123",
  "access_token": "..."   // Set as HTTP-only cookie
}
```

---

### `GET /api/payments/verify?reference=UMX-98765`

**Purpose:** Verify payment status and return ticket data (if paid).

**Response (200)**
```json
{
  "ok": true,
  "paid": true,
  "ticket": {
    "reference": "UMX-98765",
    "passenger_name": "Ama Serwaa",
    "trip": "UMaT → Accra",
    "seat": 14,
    "departure": "2026-08-28 06:30"
  }
}
```

---

## 3. Webhook Endpoint

### `POST /api/payments/webhook`

**Purpose:** Receive Paystack webhook events.

**Security:**
- Validates `x-paystack-signature` header
- Uses `payment-events` table for deduplication

**Behavior:**
- On `charge.success`: Attempts to confirm booking if hold is valid.
- On failure/expired hold: Moves booking to `PAYMENT_RECEIVED_REVIEW`.

---

## 4. Admin Endpoints

### `DELETE /api/admin/bookings`

**Purpose:** Cancel a booking (with audit logging).

**Request**
```json
{
  "reference": "UMX-98765"
}
```

**Response (200)**
```json
{
  "ok": true,
  "cancelled": true,
  "reference": "UMX-98765"
}
```

---

### `POST /api/admin/auth`

**Purpose:** Admin login.

**Request**
```json
{
  "email": "admin@example.com",
  "password": "Admin@12345"
}
```

---

## 5. Error Response Format

All endpoints return errors in this shape:

```json
{
  "ok": false,
  "code": "INVALID_STATE",
  "error": "Seat is no longer available."
}
```

---

**End of vacationRide API Contract**