# Hostel Finder — Service Plugins

**Version:** 1.0
**Status:** ON HOLD — live in production; no further plugin work until the review below is answered
**Scope:** the hostel service catalogue, landlord subscriptions, and the resident service request
**Recorded:** 2026-09-23, immediately after a review of the plugin money path

---

## 1. Why it is on hold

The happy path works: an administrator prices a service, a landlord subscribes and pays, a
resident sees it on their booking and asks for it, and the landlord approves, starts and
completes the request. Everything below is shipped and reachable today.

Two things stop this being a business we can stand behind, and neither is a bug to patch.
**The console and the sweeper disagree** about whether a subscription paid after its hold
closed is alive, so the same payment can be kept with no service or collected twice. And
**there is no vendor**: the catalogue sells installation, maintenance, meals and security to
landlords while the only party the money reaches is the platform, which has nobody to hand
any of it to.

Both are structural decisions, so the feature is frozen rather than patched. Nothing was
changed in code to record this hold; the document is the artefact.

## 2. What ships today

| Surface | Where | What it does |
|---------|-------|--------------|
| Catalogue | `lib/hostel-engine/plugins.ts:39` | Ten seeded services in four categories, platform-priced, `billing_period` defaulting to `ACADEMIC_YEAR` |
| Catalogue console | `components/console/hostel/PluginCatalogue.tsx`, `app/api/console/hostel/plugins/catalogue/route.ts` | Admin edits price, description, category, active flag |
| Subscription | `lib/hostel-engine/plugins.ts:361` | Landlord picks a plugin, period and optional property; Paystack checkout; `HP-XXXXXXXX` reference; 30-minute hold plus 15-minute grace (`:29`, `:32`) |
| Activation | `lib/hostel-engine/plugins.ts:452` | Idempotent, reached from the checkout return, the webhook and the sweep |
| Sweep | `lib/hostel-engine/reconcile.ts:36` | Every five minutes: re-verify pending payments, then release expired holds (`:93`) |
| Resident request | `lib/hostel-engine/plugins.ts:502` | Requires a `PAID` booking and an `ACTIVE` subscription; copies the resident price onto the request once |
| Fulfilment | `lib/hostel-engine/plugins.ts:576` | `REQUESTED → APPROVED / DECLINED / CANCELLED`, `APPROVED → ACTIVE / CANCELLED`, `ACTIVE → COMPLETED / CANCELLED` |
| Consoles | `components/console/hostel/ResidentWorkspace.tsx`, `components/campusRide/hostel/ResidentDashboard.tsx` | Landlord sees subscriptions and requests; the resident sees what their hostel switched on |

## 3. The two defects

### 3.1 A payment after the hold closed has two answers

The console refuses it and the sweep may accept it.

- `verifyPluginSubscriptionPayment` (`:477`) is the landlord's checkout return. If the hold
  has passed it sweeps the row to `EXPIRED` and answers `409 — "That subscription window has
  closed. Start it again."`
- `activatePluginSubscription` (`:452`) only checks `status = PENDING_PAYMENT`. It never reads
  `hold_expires_at`, so the sweep can activate the same payment minutes earlier without
  complaint.
- The sweep counts it without listening: `reconcile.ts:67` walks pending subscriptions,
  calls `await activatePluginSubscription(...)` at `:73`, and adds to `settled` at `:74`
  whatever comes back — a `NOT_PENDING` for a row already swept to `EXPIRED` counts the
  same as a real activation.

The landlord is told the window closed while their money is still collected, and the remedy
the console offers — start it again — writes a **new reference onto the same row**
(`:405`), orphaning the paid reference so that no row and no statement in the system can
explain where that money went. There is no `PAYMENT_REVIEW` for plugins; bookings have had
one since `lib/hostel-engine/residency.ts:410`, and this is the same shape of problem.

### 3.2 There is no vendor

The `WIFI` seed says the service is "installed and maintained by the platform's vendor", and
`docs/PLATFORM_NOTICES.md` already reserves `vendor` as a provider kind — but there is no
vendor table, no cost field and no payout leg. `platform_price` accrues wholly to the
platform, so a plugin can be sold, activated, requested and completed with nobody obliged to
deliver it and no money set aside to pay whoever does.

## 4. The rest of the hold list

- **No clock and no owner.** `hostel_service_requests` has no `due_at`, no assignee and no
  rating, so a paid request can sit in `APPROVED` indefinitely with nobody accountable.
- **Price inversion is unpoliced.** `MEALS` is 26,000 pesewas to the landlord and 40,000 to
  the resident, while `WIFI` is 24,000 and 12,000. Both margins are legal in the current model,
  and a landlord can lose money or charge residents a multiple with no guard and no warning.
- **Flat fees only.** There is no meter, reading, unit or consumption column anywhere in the
  engine, so prepaid power, water and data cannot be represented at all — the flat `POWER`
  and `WATER` rows are the only shape available.
- **A resident price of zero is silent.** It means "included in the rent" in the code and is
  never said in the console, so landlords have no signal that they are absorbing the cost.

## 5. Decisions to settle before this is reopened

1. **Who fulfils it.** Platform-as-vendor with margin only, or a real vendor list with cost
   passed through and its own payout leg.
2. **Flat or metered.** Stay with per-year fees, or add prepaid top-ups — noting that a
   running balance is a wallet, with float that has to reconcile.
3. **What a late payment becomes.** Refunded, credited, or parked in a review queue a human
   decides. Any answer other than "refunded automatically" needs the review state to exist.
4. **Who owns the resident price.** A floor at platform price, a ceiling, or an explicit
   "landlord may resell at a margin" statement.
5. **Where plugin money is visible.** Whether a subscription appears on the landlord
   statement as a cost and on the platform's revenue as its own line.

## 6. What "reopened" must mean

- A payment that arrives after the hold closes lands in a state a human can decide, and the
  money is either refunded or applied — never kept with a closed subscription and a fresh
  reference.
- Every `ACTIVE` subscription names the party who must deliver it and the date it is due.
- The console and the sweep read the **same** rule for when a hold has expired, and the sweep
  acts on the status the activation returns.
- Tests pin the money path, not only the helpers: a payment after expiry, a late verify, and a
  cancelled-then-paid reference.

## 7. What this document is not

It is not a defect register for the rest of Hostel Finder, and it does not authorise a
rewrite. It exists so the next person to touch plugins starts from the money as it actually
behaves, instead of the happy path the console implies.
