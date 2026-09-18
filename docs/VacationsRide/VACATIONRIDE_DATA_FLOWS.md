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
Staff member forgets password
        ↓
Runs section 9 of sql/000_umatexpress_full_migration.sql (or asks an admin to)
        ↓
Signs in with the bootstrap ADMIN_PASSWORD
        ↓
Is sent to /console/change-password and sets a console password
        ↓
The console account now owns the credential; PBKDF2-SHA256, 100,000 iterations
```

A console account whose session still owes a password change reaches the
password screens but no staff data: `staffEmailFromRequest` refuses it.

---

## 5. Dynamic Trip Creation Flow

```
Admin creates a trip
        ↓
System inserts into scheduled_trips (POST /api/trips/schedule)
        ↓
The trip becomes bookable when it is active and its review status is APPROVED
        ↓
No automatic recurrence (must be created manually each time)
```

There is no `dynamic_trips` table: "dynamic trips" are `scheduled_trips` rows.

## 6. Organizer Onboarding and Approval (Phase 2)

```
Applicant                          Reviewer                      System
──────────────────────────────────────────────────────────────────────────
1. Applies at /console/register
                              2. Account + organizer row created PENDING
                              3. Application appears in the review queue
                              4. Approve / reject with a reason
                                     - APPROVE: account ACTIVE + record APPROVED
                                     - REJECT:  reason recorded, applicant told
5. Signs in on the console
                              6. Session carries role ORGANIZER and profile id
7. Opens own trips only
```

## 7. Organizer Manifest Read (Phase 2, D3)

```
Organizer opens a trip manifest
        ↓
Session gives the organizer id and profile id (never the request)
        ↓
Query is scoped: WHERE trip_id = ? AND organizer_id = <session organizer>
        ↓
Zero rows → 404, the same answer as a trip that does not exist
        ↓
Rows returned with passenger contact details
        ↓
One audit row written per read: actor, trip, rows returned
        ↓
Suspending the organizer revokes the session, so the next read is 401
```

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
