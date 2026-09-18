# Hostel Finder — Moderation & Trust Model

**Version:** 1.0  
**Status:** Draft for Review

---

## 1. Trust Philosophy

The Hostel Finder operates on a **"Trust but Verify"** model:

- Landlords are empowered to list and manage their properties.
- The platform acts as a **gatekeeper** through approval workflows.
- Admin intervention is possible but **not required** for every action.
- All financial movements are **auditable** and reversible where possible.

---

## 2. Listing Lifecycle & Moderation States

```
DRAFT → PENDING_REVIEW → APPROVED → SUSPENDED
           ↑___________________________|
```

| State | Description | Visible to Students? | Can Receive Bookings? |
|-------|-------------|----------------------|-----------------------|
| `DRAFT` | Landlord is still editing | No | No |
| `PENDING_REVIEW` | Submitted for admin review | No | No |
| `APPROVED` | Live and bookable | Yes | Yes |
| `SUSPENDED` | Temporarily removed (by admin or system) | No | No |

**Moderation Triggers:**
- New listing created
- Significant changes to price or capacity
- Multiple complaints from students
- KYC status changes

---

## 3. Landlord Trust Tiers

| Tier | KYC Status | Payout Access | Listing Limit | Notes |
|------|------------|---------------|---------------|-------|
| New | `PENDING` | No | 1 property | Must complete basic verification |
| Verified | `VERIFIED` | Yes | Unlimited | Full access |
| Trusted | `VERIFIED` + Good history | Yes + Faster release | Unlimited | Manual review waived for most actions |
| Restricted | `REJECTED` or flagged | No | 0 | Requires admin intervention |

---

## 4. Fraud Prevention Measures

### 4.1 Duplicate & Sybil Detection
- Phone number uniqueness enforced at landlord level.
- Same phone used across multiple properties triggers review.
- Rapid creation of many listings from one account is rate-limited.

### 4.2 Listing Quality
- Photos are **mandatory** for `APPROVED` state (R2 upload required).
- Minimum of 3 photos per property.
- Admin can flag low-quality or misleading photos.

### 4.3 Booking Abuse
- One phone number can only have **one active booking** per period.
- Multiple bookings from the same phone within a short window triggers review.

### 4.4 Payment & Payout Monitoring
- Large number of failed payments from one student → temporary block.
- High volume of payouts to the same recipient in short time → manual review.

---

## 5. Admin Intervention Capabilities

Admins can perform the following actions:

| Action | Scope | Audit Required? |
|--------|-------|-----------------|
| Approve / Reject listing | Listing | Yes |
| Suspend property | Property + all listings | Yes |
| Release or hold payout | Payout | Yes |
| View full payout account | Landlord | Yes (masked by default) |
| View chat history | Booking | Yes (read-only) |
| Force-cancel booking | Booking | Yes |
| Refund student | Booking | Yes |

All admin actions are written to `hostel_audit_logs`.

---

## 6. Student Protection

- 10-minute payment hold before seat/space is permanently reserved.
- Clear refund policy (admin-mediated in v1).
- Chat history is preserved and exportable for disputes.
- Students can report landlords (creates a moderation ticket).

---

## 7. Dispute Resolution Process (v1)

1. Student or landlord raises a dispute via the platform.
2. Admin reviews:
   - Booking details
   - Payment records
   - Chat history
3. Admin makes a decision:
   - Full refund to student
   - Partial refund
   - Release payout to landlord
   - Escalate for manual investigation

---

## 8. AI-Assisted Moderation (Future)

In later phases, the system can use Workers AI to:

- Detect spam or abusive language in chat
- Flag listings with suspicious pricing
- Summarize long dispute threads for admins
- Auto-translate messages (for international students)

---

**End of Moderation & Trust Model**