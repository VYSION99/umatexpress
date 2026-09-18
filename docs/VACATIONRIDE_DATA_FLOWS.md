# vacationRide — Data Flow Diagrams

**Version:** 1.0  
**Status:** Draft for Review

---

## 1. Standard Booking + Payment Flow

```
Student                          System                              Paystack
───────────────────────────────────────────────────────────────────────────────
1. Select trip + seat
                              2. Create booking (AWAITING_PAYMENT)
                              3. Create seat_hold (expires in 10 min)
                              4. Initialize Paystack transaction
5. Redirect to Paystack
6. Complete payment
                              7. Webhook received (charge.success)
                              8. Verify x-paystack-signature
                              9. Check payment-events deduplication
                              10. Validate seat_hold still valid
                              11. If valid:
                                     - Confirm booking
                                     - Mark seat_hold as BOOKED
                                     - Update payment status
                              12. If expired:
                                     - Move booking to PAYMENT_RECEIVED_REVIEW
                                     - Flag for admin resolution
```

**Key Safety Mechanisms:**
- Seat is **held before payment** starts.
- Webhook is **idempotent** via `payment-events` table.
- Expired payments go into a **review queue** instead of being blindly accepted or rejected.

---

## 2. Admin Cancellation Flow

```
Admin                            System
────────────────────────────────────────────────────────────
1. Opens booking in admin panel
2. Clicks "Cancel Booking"
                              3. Verify admin session
                              4. Write record to admin_audit_logs
                              5. Delete booking
                              6. Release seat_hold (if still held)
                              7. Update payment status to CANCELLED (if applicable)
```

**Important:** The audit log is written **before** the booking is deleted. This is a deliberate safety pattern.

---

## 3. Payment Review Flow (Expired Hold)

```
System detects expired hold + successful payment
        ↓
Booking moved to PAYMENT_RECEIVED_REVIEW
        ↓
Admin reviews case:
   - Option A: Assign different seat (if available)
   - Option B: Issue full refund
   - Option C: Contact passenger
        ↓
Admin resolves manually
```

This is one of the more sophisticated parts of vacationRide and demonstrates defensive design.

---

## 4. Admin Password Recovery Flow

```
Admin forgets password
        ↓
Runs SQL from sql/002_admin_password_recovery.sql
        ↓
Signs in with bootstrap ADMIN_PASSWORD
        ↓
Immediately forced to change password via /admin/change-password
        ↓
New password is hashed with 100,000 PBKDF2 iterations
```

---

## 5. Dynamic Trip Creation Flow

```
Admin creates dynamic trip
        ↓
System inserts into dynamic_trips table
        ↓
Trip becomes available for booking (same flow as scheduled_trips)
        ↓
No automatic recurrence (must be created manually each time)
```

Currently, dynamic trips are treated similarly to scheduled trips once created.

---

## 6. Error & Edge Case Handling

| Scenario | Handling |
|----------|----------|
| Duplicate webhook delivery | `payment-events` table prevents double processing |
| Payment succeeds after hold expires | Booking moved to `PAYMENT_RECEIVED_REVIEW` |
| Student pays but selects wrong seat | Admin must manually resolve (no self-service swap yet) |
| Paystack amount mismatch | Booking flagged for review |

---

**End of vacationRide Data Flows**