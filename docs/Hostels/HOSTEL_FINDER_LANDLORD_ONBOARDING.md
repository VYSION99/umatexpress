# Hostel Finder — Landlord Onboarding & KYC Flow

**Version:** 1.0  
**Status:** Draft for Review

---

## 1. Onboarding Philosophy

The onboarding process is designed to balance **speed** (landlords want to list quickly) with **trust** (students and the platform need protection).

**Core Principle:**  
Landlords can start creating content immediately, but **monetization and visibility** are gated behind verification steps.

---

## 2. Onboarding Stages

### Stage 1: Registration (Immediate)

**Actions:**
- Landlord provides phone number + password
- System creates `hostel_landlords` record with `kyc_status = PENDING`

**Outcome:**
- Landlord can log in
- Landlord can create **1 property** (soft limit)

---

### Stage 2: Property Setup (Self-Service)

**Actions:**
- Create property (name, address, location)
- Create rooms and spaces
- Upload photos (R2)
- Create draft listings

**Outcome:**
- Property exists in `DRAFT` state
- Not visible to students

---

### Stage 3: Listing Submission

**Actions:**
- Landlord submits listing for review
- System changes status to `PENDING_REVIEW`

**Outcome:**
- Admin is notified
- Landlord cannot edit while under review (or edits reset status)

---

### Stage 4: Admin Review & Approval

**Admin Checklist:**
- Photos are clear and represent the property
- Pricing is reasonable for the area
- Property details match photos
- No obvious fraud signals

**Possible Outcomes:**
- `APPROVED` → Listing goes live
- `REJECTED` → Landlord receives reason + can resubmit

---

### Stage 5: Payout Account Setup (Required for Monetization)

**Actions:**
- Landlord enters bank / MoMo details
- System stores details (masked)
- Landlord can optionally enable encryption
- System creates Paystack Recipient (if KYC is complete)

**Outcome:**
- `paystack_recipient_code` is stored
- Landlord becomes eligible to receive payouts

---

### Stage 6: KYC Verification (Full Access)

**Required Documents (Ghana context):**
- Ghana Card or Passport
- Proof of property ownership or authorization letter
- Business registration (optional for individuals)

**Admin Actions:**
- Review documents
- Update `kyc_status` to `VERIFIED` or `REJECTED`

**Outcome:**
- Full access to all features
- Faster payout release (trusted tier)
- Removal of listing limits

---

## 3. State Machine Summary

```
REGISTERED → PROPERTY_SETUP → SUBMITTED → APPROVED → VERIFIED
                ↑_______________________________|
```

---

## 4. Gating Rules

| Feature | Requires |
|---------|----------|
| Create property | Registration |
| Create listing | Property exists |
| Listing visible to students | `APPROVED` status |
| Receive payouts | `VERIFIED` KYC + Recipient code |
| Unlimited properties | `VERIFIED` status |
| Fast payout release | Good history + `VERIFIED` |

---

## 5. Re-verification Triggers

Landlords may be asked to re-verify if:

- Multiple student complaints
- Sudden change in payout account
- High volume of bookings in short period
- Platform detects suspicious activity

---

## 6. Admin Dashboard Views

Admins should have dedicated views for:

- Pending KYC reviews
- Pending property/listing approvals
- Flagged landlords
- Payout account change requests (audited)

---

**End of Landlord Onboarding Document**