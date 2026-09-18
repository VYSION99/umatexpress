# Hostel Finder — Data Flow Diagrams

**Version:** 1.0  
**Status:** Draft for Review

---

## 1. Booking + Payment Flow

```
Student                          System                              Paystack
───────────────────────────────────────────────────────────────────────────────
1. Browse properties & periods
2. Select space + period
3. Click "Book Now"
                              4. Check availability
                              5. Atomically claim space
                                 (UPDATE ... WHERE available > 0)
                              6. Create booking (HELD, 10-min expiry)
                              7. Create payment record (PENDING)
8. Redirect to Paystack
                              9. Initialize Paystack transaction
10. Student pays
                              11. Webhook received
                              12. Verify signature + dedupe event
                              13. Mark payment SUCCESSFUL
                              14. Update booking → CONFIRMED
                              15. Create payout record
                                 (gross, commission, net, release_after)
                              16. Release space if payment fails/expired
```

**Key Invariants:**
- Space is claimed **before** payment is initiated.
- Payment success does **not** touch capacity again.
- Payout record is created at confirmation time.
- Release date is computed as `period.starts_on − 3 days`.

---

## 2. Payout Release Flow

```
Admin / Cron                     System                              Paystack
───────────────────────────────────────────────────────────────────────────────
1. Daily job runs
                              2. Find payouts where:
                                 - status = PENDING
                                 - release_after <= today
                                 - booking is confirmed
3. Admin reviews (optional)
4. Admin clicks "Release"
                              5. Update payout → APPROVED
                              6. Call Paystack Transfer API
                              7. Receive transfer_reference
                              8. Update payout → TRANSFERRED
                              9. Write audit log

                              (Failure path)
                              10. Transfer fails
                              11. Update payout → FAILED
                              12. Schedule retry (reconcile job)
```

**Key Rules:**
- Payouts are released **3 days before school reopening** by default.
- Admin can manually release earlier or delay.
- Failed transfers are retried via the reconcile job.

---

## 3. Landlord Onboarding Flow

```
Landlord                         System
────────────────────────────────────────────────────────────
1. Register (phone + password)
                              2. Create landlord record (kyc = PENDING)
3. Login
4. Create property
5. Create rooms + spaces
6. Create listing (draft)
7. Submit for review
                              8. Update listing → PENDING_REVIEW
                              9. Notify admin
10. Admin reviews
11. Admin approves
                              12. Update listing → APPROVED
13. Add payout account
                              14. Store masked account
                              15. (Optional) Landlord enables encryption
16. Complete KYC documents
                              17. Update kyc_status → VERIFIED
                              18. Create Paystack Recipient
                              19. Store recipient_code
```

---

## 4. Chat Message Flow

```
Student / Landlord               Ably                          Turso
────────────────────────────────────────────────────────────────────
1. Open booking chat
                              2. Request token from Worker
                              3. Validate ownership
                              4. Issue scoped Ably token
5. Publish message
                              6. Deliver to other party
                              7. Webhook fires
                              8. Worker persists message
```

---

## 5. Atomic Space Claim (Critical Path)

```
Function: claimHostelSpace(rideId/spaceId, nowIso)

1. BEGIN (implicit via conditional UPDATE)
2. UPDATE hostel_spaces
   SET status = 'BOOKED'
   WHERE id = ? AND status = 'AVAILABLE'
3. IF row was updated:
      → Return success + position
   ELSE:
      → Check current status
      → Return "FULL" or "CLOSED"
```

This is the same pattern used successfully in `campusRide`.

---

## 6. Error & Recovery Paths

| Scenario | Recovery |
|----------|----------|
| Payment succeeds but booking already expired | Mark as `PAYMENT_RECEIVED_REVIEW` |
| Transfer to landlord fails | Reconcile job retries; admin can retry manually |
| Duplicate webhook | `payment-events` deduplication table prevents double processing |
| Space claim fails due to race | Student sees "This space is no longer available" |

---

**End of Data Flow Diagrams**