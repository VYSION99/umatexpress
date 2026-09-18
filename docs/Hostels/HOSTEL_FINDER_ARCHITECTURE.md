# Hostel Finder — Architecture Plan

**Status:** Approved for build  
**Owner:** UMaTeXPRESS team  
**Goal:** Student hostel discovery + booking platform where money flows through the platform to landlords, using bed-space inventory on annual academic periods.

---

## 1. Product Model (Locked Decisions)

| Dimension | Decision | Rationale |
|-----------|----------|---------|
| Inventory unit | **Bed-space** (1–6 per room) | Matches real Ghanaian student hostel reality |
| Booking grain | **One booking = one space** | Keeps capacity + payout ledger clean; multiple beds = multiple bookings |
| Booking period | **Annual academic year** — admin-defined global catalogue, landlord selects + prices | Reduces availability to a per-space boolean per period |
| Price location | **On the listing** (not the room) | Landlord can change rent year to year without touching the room |
| Space vs listing | **Separate** — space = physical bed, listing = that bed offered for a period | A space persists across academic years |
| Money flow | Platform is **merchant of record** (Paystack settles to platform) → platform pays landlords via **Paystack Transfers** | Full control over refunds/disputes |
| Payout timing | **Released 3 days before the period's school reopening date**, computed per booking; **admin can override/manually release** | Protects funds while allowing admin judgment |
| Commission | **Percentage, landlord-side**, stored per booking | Rate changes are historical-safe |
| Landlord publishing | Self-service **DRAFT → PENDING_REVIEW → APPROVED** | Balances speed with trust |
| Landlord payout account | Stored raw, **masked + audited** platform-side; **landlord may choose to encrypt** their stored details | Security without blocking operations |
| Gender | **Mixed** (no gender filter) | Per product decision |
| Guarantor | **Not modeled** | Per product decision |
| Utility fees | **Landlord toggle** on/off per unit; adds a fee line item | Flexible across properties |
| Photos | Cloudflare **R2** (new) | Required for credible listings |
| Refunds (v1) | **Admin-handled manually** | Cancellation policy deferred to Phase 4 |

---

## 2. Entity Model

### Landlord & payouts

```sql
hostel_landlords (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT UNIQUE NOT NULL,
  email TEXT,
  password_hash TEXT, password_salt TEXT, password_iterations INTEGER,
  status TEXT NOT NULL DEFAULT 'ACTIVE',              -- ACTIVE | SUSPENDED
  kyc_status TEXT NOT NULL DEFAULT 'PENDING',         -- PENDING | VERIFIED | REJECTED

  -- Payout destination (masked + audited; landlord may opt to encrypt)
  payout_method TEXT,                                 -- BANK | MOMO
  payout_account_name TEXT,
  payout_account_number TEXT,                         -- sensitive: masked by default
  payout_account_encrypted TEXT,                      -- set when landlord enabled encryption
  payout_encrypt INTEGER NOT NULL DEFAULT 0,          -- landlord choice
  payout_bank_code TEXT,
  paystack_recipient_code TEXT,                       -- set after recipient creation

  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT, updated_at TEXT
);
```

### Property → room → space → listing

```sql
hostel_properties (
  id TEXT PRIMARY KEY,
  landlord_id TEXT NOT NULL,
  name TEXT NOT NULL,
  address TEXT,
  latitude REAL, longitude REAL,
  campus_distance_m INTEGER,
  utilities_enabled INTEGER NOT NULL DEFAULT 0,       -- landlord toggle
  status TEXT NOT NULL DEFAULT 'DRAFT',               -- DRAFT | PENDING_REVIEW | APPROVED | SUSPENDED
  created_at TEXT, updated_at TEXT
);

hostel_rooms (
  id TEXT PRIMARY KEY,
  property_id TEXT NOT NULL,
  label TEXT NOT NULL,                                -- "Room 3"
  capacity INTEGER NOT NULL CHECK (capacity BETWEEN 1 AND 6),
  utilities_fee INTEGER NOT NULL DEFAULT 0,           -- applies when property toggle is on
  amenities TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT, updated_at TEXT
);

hostel_spaces (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  label TEXT,                                         -- "Bed A"
  status TEXT NOT NULL DEFAULT 'AVAILABLE',           -- AVAILABLE | RETIRED
  created_at TEXT, updated_at TEXT
);

hostel_periods (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,                                 -- "2026/27 Academic Year"
  starts_on TEXT NOT NULL,                            -- school reopening date
  ends_on TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT
);

hostel_listings (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  period_id TEXT NOT NULL,
  price INTEGER NOT NULL,                             -- rent per space, in pesewas
  status TEXT NOT NULL DEFAULT 'DRAFT',               -- DRAFT | PENDING_REVIEW | APPROVED | SUSPENDED
  created_at TEXT, updated_at TEXT,
  UNIQUE(space_id, period_id)
);
```

### Bookings, payments, payouts

```sql
hostel_bookings (
  id TEXT PRIMARY KEY,
  reference TEXT UNIQUE NOT NULL,                     -- HF-...
  space_id TEXT NOT NULL,
  period_id TEXT NOT NULL,
  listing_id TEXT NOT NULL,
  student_name TEXT, phone TEXT, email TEXT,
  rent_amount INTEGER NOT NULL,
  utilities_amount INTEGER NOT NULL DEFAULT 0,
  amount INTEGER NOT NULL,                            -- total charged
  payment_status TEXT NOT NULL DEFAULT 'WAITING_PAYMENT',
  booking_status TEXT NOT NULL DEFAULT 'HELD',
  expires_at TEXT,                                    -- 10-min payment hold
  confirmed_at TEXT,
  created_at TEXT, updated_at TEXT
);

hostel_payments (                                     -- inbound ledger (reuse campus_payments shape)
  id TEXT PRIMARY KEY, booking_id TEXT NOT NULL, reference TEXT UNIQUE NOT NULL,
  provider TEXT NOT NULL, amount INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'GHS',
  status TEXT NOT NULL DEFAULT 'PENDING', access_token_hash TEXT,
  fare_amount INTEGER, fee_amount INTEGER, authorization_url TEXT,
  paid_at TEXT, raw_response TEXT, created_at TEXT, updated_at TEXT
);

hostel_payouts (                                      -- outbound ledger (NEW)
  id TEXT PRIMARY KEY,
  landlord_id TEXT NOT NULL,
  booking_id TEXT NOT NULL,
  gross_amount INTEGER NOT NULL,                      -- total booked
  commission_amount INTEGER NOT NULL,
  net_amount INTEGER NOT NULL,
  release_after TEXT,                                 -- = period.starts_on - 3 days
  status TEXT NOT NULL DEFAULT 'PENDING',             -- PENDING | APPROVED | TRANSFERRED | FAILED | CANCELLED
  transfer_reference TEXT,
  released_at TEXT, transferred_at TEXT,
  created_at TEXT, updated_at TEXT
);
```

### Indexes

- `idx_hostel_spaces_room_status (room_id, status)`
- `idx_hostel_listings_period_status (period_id, status)`
- `idx_hostel_bookings_space_period (space_id, period_id)`
- `idx_hostel_payouts_status_release (status, release_after)`
- `idx_hostel_landlords_recipient (paystack_recipient_code)`

---

## 3. Module Layout & Reuse

```
lib/hostel-engine/
  auth.ts            # landlord sessions (clone of driver-auth)
  landlord.ts        # property/room/space CRUD, ownership + masking helpers
  periods.ts         # admin period catalogue + release-date computation
  listings.ts        # draft → pending → approved lifecycle
  booking.ts         # atomic space claim + 10-min hold (reuses queue.ts)
  payments.ts        # inbound Paystack (clone of rides.ts)
  payouts.ts         # NEW: ledger + Paystack Transfers + reconcile
  kyc.ts             # recipient onboarding + verification gate

app/hostel/…         # student discover / filter / map / detail / checkout / ticket
app/landlord/…       # landlord console (auth, properties, rooms, spaces, listings, bookings, payouts)
app/admin/hostel/…   # moderation, periods, payout release, reconciliation

app/api/hostel/…     # public API
app/api/v1/hostel/…  # stable v1 aliases

sql/014_hostel_foundation.sql
sql/015_hostel_payouts.sql
```

**Direct reuse (no changes)**
- `lib/turso.ts`
- `lib/payment-access.ts`
- `lib/payment-events.ts`
- `lib/observability.ts`
- `lib/rate-limit.ts`
- `lib/campus-engine/queue.ts` (atomic claim + guarded transition + expiry release)
- `lib/campus-engine/audit.ts`
- Map + AI widgets from `components/campusRide/shared`

**New / heavily adapted**
- `payouts.ts` + **Paystack Transfers**
- **R2** photo upload + signed URLs
- Landlord **KYC + recipient** flow
- Release-date policy (`starts_on − 3 days`)

---

## 4. API Surface

### Student
- `GET  /api/hostel/periods`
- `GET  /api/hostel/properties?periodId=&maxDistance=`
- `GET  /api/hostel/spaces?propertyId=&periodId=`
- `POST /api/hostel/bookings` → atomic claim + payment init
- `GET  /api/hostel/bookings/verify?reference=`

### Landlord
- `POST /api/landlord/auth`
- `GET  /api/landlord/me`
- `POST /api/landlord/properties` · `/rooms` · `/spaces`
- `POST /api/landlord/listings` (draft → submit for review)
- `GET  /api/landlord/bookings`
- `GET  /api/landlord/payouts`
- `POST /api/landlord/payout-account` (set/update destination; optional encryption toggle)

### Admin
- `POST /api/admin/hostel/periods`
- `POST /api/admin/hostel/listings/:id/approve`
- `GET  /api/admin/hostel/landlords/:id/payout-account` (audited reveal; full value)
- `POST /api/admin/hostel/payouts/:id/release`
- `POST /api/admin/hostel/reconcile`

---

## 5. Phased Delivery

### Phase 1 — Foundation (no money)
- Schema + migrations 014
- Landlord auth + console
- Property / room / space CRUD (landlord-scoped)
- Global period catalogue (admin) + release-date computation
- Listing draft → pending → approved workflow
- Student read-only browse + map + filter

**Acceptance:** Landlord creates a property with rooms/spaces, attaches to a period, admin approves, student sees it on the map.

### Phase 2 — Booking + inbound payments
- Atomic space claim (`claimHostelSpace` — port of `claimCampusQueueSlot`)
- 10-minute payment hold + expiry release
- Paystack inbound (reuse init + webhook + dedupe)
- Image ticket on success
- Utilities fee included when landlord toggle is on

**Acceptance:** Student books one bed-space for the full academic year and receives a ticket. Capacity is never oversold; expired holds release exactly once.

### Phase 3 — Payouts & trust
- Landlord KYC + Paystack transfer-recipient onboarding
- Payout ledger + percentage commission (per booking)
- Release-after (`starts_on − 3 days`) + admin manual release
- Paystack Transfers + reconcile cron (stuck/failed/retry, idempotent)
- Payout account masking + audited reveal; optional landlord encryption
- R2 photo upload + moderation

**Acceptance:** A successful booking creates a payable with `release_after` set; admin releases; landlord is paid via Paystack Transfer; failed transfers retry and are audited.

### Phase 4 — Polish
- AI assistant (property + availability context)
- Student reviews
- Fraud signals
- Cancellation/refund policy
- Analytics dashboard

---

## 6. Security & Trust

- Landlord sessions: HMAC-signed, HTTP-only, allowlisted (same as driver).
- Every money-moving action uses guarded transitions (idempotent).
- Payouts require `kyc_status = VERIFIED` **and** `paystack_recipient_code`.
- Listings require `status = APPROVED` before appearing in student search.
- **Payout account** is masked by default (`024*****789`); full value only via audited admin reveal; never written to observability logs. Landlord may opt to store it encrypted.
- Payment events deduplicated via `payment-events`.
- R2 photos served via signed URLs (not public by default).

---

## 7. Deferred / Open

- Exact commission percentage (Phase 3).
- Per-landlord hold-window overrides (default is global `starts_on − 3 days`).
- Partial-year / semester bookings (later phase).
- Encryption-at-rest implementation detail for landlord payout accounts.
- Mobile money vs bank default for landlords.

---

**Next step:** On approval, begin Phase 1 (schema migration 014 + landlord auth + console skeleton).