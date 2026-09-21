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

## 2. Payout Release Flow (built)

```
Release job / Admin              System                              Paystack
───────────────────────────────────────────────────────────────────────────────
1. Release cron fires
                              2. Queue one row per landlord:
                                 - status = ACCRUED, release_after <= now
                                 - no batch in flight, no released-debt row
                                 - payout_attempts below the ceiling
                              3. Read the settled Paystack balance once
                              4. Gate each landlord before writing a batch:
                                 ACTIVE, KYC verified, destination saved,
                                 amount above the fee and the minimum,
                                 balance covers the amount
5. Admin may press Send
                              6. Insert batch (PENDING), claim entries
                                 (ACCRUED → PROCESSING) in the same breath
                              7. Transfer amount = claimed balance − rail
                                 fee (MOMO GHS 1.00 / bank GHS 8.00)
                              8. Store transfer_code, recipient_code,
                                 transfer_fee; write the audit log
                              9. Paystack settles inline or by webhook
```

**Key Rules:**
- A payout releases when its window closes: `release_after` defaults to three
  days before the academic year starts and is written onto each entry when the
  booking is paid. A shorter window is a policy change, not a migration.
- The fee is the landlord's: the transfer carries the ledger amount **less**
  Paystack's charge for that rail, so the platform's debit is exactly the
  balance owed. `hostel_payout_batches.transfer_fee` records it and both payout
  screens show Amount, fee and Received.
- Unattended release is opt-in (`hostel_payout_auto`, fallback
  `HOSTEL_PAYOUT_AUTO_ENABLED`). Off keeps the ledger and statements; Send with
  Paystack in the payout desk is attended and still works.
- The job never sends what the settled balance cannot cover, and never retries
  past `HOSTEL_PAYOUT_MAX_ATTEMPTS` — those entries go to `FAILED` and wait for
  a person. A failed transfer returns its entries to `ACCRUED`.
- An administrator recording a transfer by hand is the settlement check for
  that batch: the ledger records the full amount and the notification discloses
  the rail's fee rather than inventing a deduction.
- The reconcile job and the transfer webhook both settle `PENDING` batches, so
  a missed webhook is noticed rather than leaving money in limbo.

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