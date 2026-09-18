# Hostel Finder — Entity Relationship Diagram (ERD)

**Version:** 1.0  
**Status:** Draft for Review

---

## Overview

This document describes the core entities and their relationships in the Hostel Finder system.

---

## Entity Relationship Diagram (Text/ASCII)

```
┌─────────────────────┐
│  hostel_landlords   │
│─────────────────────│
│ id (PK)             │
│ name                │
│ phone (UQ)          │
│ email               │
│ password_*          │
│ kyc_status          │
│ payout_*            │
│ paystack_recipient  │
│ status              │
│ created_at          │
└─────────┬───────────┘
          │ 1
          │
          │ N
┌─────────▼───────────┐       1          N
│ hostel_properties   │◄──────────────────────┐
│─────────────────────│                       │
│ id (PK)             │                       │
│ landlord_id (FK)    │                       │
│ name                │                       │
│ address             │                       │
│ latitude            │                       │
│ longitude           │                       │
│ campus_distance_m   │                       │
│ utilities_enabled   │                       │
│ status              │                       │
│ created_at          │                       │
└─────────┬───────────┘                       │
          │ 1                                 │
          │                                   │
          │ N                                 │
┌─────────▼───────────┐                       │
│   hostel_rooms      │                       │
│─────────────────────│                       │
│ id (PK)             │                       │
│ property_id (FK)    │                       │
│ label               │                       │
│ capacity (1-6)      │                       │
│ utilities_fee       │                       │
│ amenities           │                       │
│ status              │                       │
│ created_at          │                       │
└─────────┬───────────┘                       │
          │ 1                                 │
          │                                   │
          │ N                                 │
┌─────────▼───────────┐       1          N    │
│   hostel_spaces     │◄──────────────────────┘
│─────────────────────│
│ id (PK)             │
│ room_id (FK)        │
│ label               │
│ status              │
│ created_at          │
└─────────┬───────────┘
          │ 1
          │
          │ N
┌─────────▼───────────┐       N          1
│  hostel_listings    │──────────────────────►┐
│─────────────────────│                       │
│ id (PK)             │                       │
│ space_id (FK)       │                       │
│ period_id (FK)      │                       │
│ price               │                       │
│ status              │                       │
│ created_at          │                       │
└─────────┬───────────┘                       │
          │ 1                                 │
          │                                   │
          │ N                                 │
┌─────────▼───────────┐                       │
│  hostel_bookings    │◄──────────────────────┘
│─────────────────────│
│ id (PK)             │
│ reference (UQ)      │
│ space_id (FK)       │
│ period_id (FK)      │
│ listing_id (FK)     │
│ student_name        │
│ phone               │
│ email               │
│ rent_amount         │
│ utilities_amount    │
│ amount              │
│ payment_status      │
│ booking_status      │
│ expires_at          │
│ confirmed_at        │
│ created_at          │
└─────────┬───────────┘
          │ 1
          │
          │ N
┌─────────▼───────────┐
│  hostel_payments    │
│─────────────────────│
│ id (PK)             │
│ booking_id (FK)     │
│ reference (UQ)      │
│ provider            │
│ amount              │
│ status              │
│ access_token_hash   │
│ paid_at             │
│ created_at          │
└─────────────────────┘

┌─────────────────────┐       N          1
│  hostel_payouts     │──────────────────────►┐
│─────────────────────│                       │
│ id (PK)             │                       │
│ landlord_id (FK)    │                       │
│ booking_id (FK)     │                       │
│ gross_amount        │                       │
│ commission_amount   │                       │
│ net_amount          │                       │
│ release_after       │                       │
│ status              │                       │
│ transfer_reference  │                       │
│ released_at         │                       │
│ transferred_at      │                       │
│ created_at          │                       │
└─────────────────────┘                       │
                                              │
┌─────────────────────┐                       │
│  hostel_periods     │◄──────────────────────┘
│─────────────────────│
│ id (PK)             │
│ name                │
│ starts_on           │
│ ends_on             │
│ active              │
│ created_at          │
└─────────────────────┘

┌─────────────────────┐
│  hostel_messages    │
│─────────────────────│
│ id (PK)             │
│ booking_id (FK)     │
│ sender_type         │
│ sender_id           │
│ content             │
│ metadata            │
│ created_at          │
└─────────────────────┘
```

---

## Relationship Summary

| Relationship | Cardinality | Description |
|--------------|-------------|-------------|
| Landlord → Properties | 1:N | One landlord can own multiple properties |
| Property → Rooms | 1:N | One property contains multiple rooms |
| Room → Spaces | 1:N | One room contains multiple bed-spaces (1–6) |
| Space → Listings | 1:N | One space can be listed across multiple periods |
| Period → Listings | 1:N | One period can have many listings |
| Listing → Bookings | 1:N | One listing can generate multiple bookings (over time) |
| Booking → Payments | 1:N | One booking can have multiple payment attempts |
| Booking → Payouts | 1:1 | One booking generates one payout record |
| Booking → Messages | 1:N | One booking has one chat thread (many messages) |
| Landlord → Payouts | 1:N | One landlord receives many payouts |

---

## Notes

- `hostel_spaces` represents the **physical bed**.
- `hostel_listings` represents the **offer** of that bed for a specific academic period.
- `hostel_bookings` always references both a space and a period.
- All monetary amounts are stored in **pesewas** (smallest GHS unit).

---

**End of ERD**