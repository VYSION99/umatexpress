# vacationRide — Entity Relationship Diagram (ERD)

**Version:** 1.0  
**Status:** Draft for Review

---

## Overview

This document describes the core entities and relationships in the **vacationRide** module.

---

## Entity Relationship Diagram (Text/ASCII)

```
┌─────────────────────┐
│  scheduled_trips    │
│─────────────────────│
│ id (PK)             │
│ route_from          │
│ route_to            │
│ travel_date         │
│ departure_time      │
│ arrival_time        │
│ capacity            │
│ price               │
│ status              │
│ created_at          │
└─────────┬───────────┘
          │ 1
          │
          │ N
┌─────────▼───────────┐
│     bookings        │
│─────────────────────│
│ id (PK)             │
│ reference (UQ)      │
│ trip_id (FK)        │
│ seat                │
│ passenger_name      │
│ email               │
│ phone               │
│ amount              │
│ payment_status      │
│ booking_status      │
│ hold_expires_at     │
│ confirmed_at        │
│ created_at          │
└─────────┬───────────┘
          │ 1
          │
          │ N
┌─────────▼───────────┐
│    seat_holds       │
│─────────────────────│
│ id (PK)             │
│ booking_id (FK)     │
│ trip_id (FK)        │
│ seat                │
│ status              │
│ expires_at          │
│ created_at          │
└─────────────────────┘

┌─────────────────────┐
│     payments        │
│─────────────────────│
│ id (PK)             │
│ booking_id (FK)     │
│ reference_id (UQ)   │
│ provider            │
│ amount              │
│ currency            │
│ status              │
│ financial_txn_id    │
│ access_token_hash   │
│ created_at          │
│ updated_at          │
└─────────────────────┘

┌─────────────────────┐
│   dynamic_trips     │
│─────────────────────│
│ id (PK)             │
│ travel_date         │
│ departure_time      │
│ route_from          │
│ route_to            │
│ capacity            │
│ price               │
│ created_by          │
│ created_at          │
└─────────────────────┘

┌─────────────────────┐
│ admin_audit_logs    │
│─────────────────────│
│ id (PK)             │
│ admin_email         │
│ action              │
│ target_type         │
│ target_reference    │
│ details             │
│ created_at          │
└─────────────────────┘
```

---

## Relationship Summary

| Relationship | Cardinality | Description |
|--------------|-------------|-------------|
| `scheduled_trips` → `bookings` | 1:N | One trip has many seat bookings |
| `bookings` → `seat_holds` | 1:1 | Each booking has at most one active seat hold |
| `bookings` → `payments` | 1:N | One booking can have multiple payment attempts |
| `scheduled_trips` → `dynamic_trips` | 0:N | Dynamic trips are separate from the main schedule |
| `bookings` → `admin_audit_logs` | 0:N | Cancellations and sensitive actions are logged |

---

## Key Design Notes

- `seat_holds` is the mechanism that prevents double-booking during the payment window.
- `bookings.reference` is the public identifier shown to passengers (e.g., `UMX-12345`).
- `payments.access_token_hash` enables secure, token-based access to ticket details without exposing PII.
- `admin_audit_logs` only captures destructive or high-impact actions (mainly cancellations).

---

**End of vacationRide ERD**