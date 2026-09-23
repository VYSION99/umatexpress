# Platform Notices

**Status:** implemented — organizer, landlord and driver decisions wired; vendor declared
**Applies to:** every service where one party waits on a decision the platform or another party makes

---

## 1. What it is

Every service on the platform has a pair of parties in it. A **provider and the
platform**: an application is approved, a KYC check decides whether money may
leave, a listing is reviewed. A **buyer and a provider**: a seat is confirmed, a
refund is decided, a payout is sent. Whoever is on the receiving end of a
decision has to be told, or the decision only exists in the console.

`lib/notify-templates.ts` is the one place that copy lives. A service picks its
`kind`, the decision it just made and a few facts; the template id, the subject
and the wording come from there, so the same decision reads the same way in
every product. The sender, `notifyParty()`, writes one row to
`notification_outbox`, which is both the email and the in-app record.

## 2. The two shapes

| Shape | Example | Who is told | Where the copy lives |
|-------|---------|-------------|----------------------|
| Provider ↔ platform | account approved, KYC verified, listing reviewed | the provider | `providerDecisionNotice`, `providerKycNotice`, `providerListingNotice` |
| Buyer ↔ provider | seat confirmed, refund decided, payout sent | the other party | the product that owns the state machine, listed in `PARTY_TEMPLATES.existing` |

The split is deliberate. Decision copy is short, repeated across services and
easy to keep uniform, so it is centralised. Money-flow copy carries the detail
of one booking, and it stays with the code that knows that state — moving it
would put booking facts in a module that never sees a booking.

## 3. The id says what happened

Template ids are `<kind>_<subject>_<decision>`, lower-cased, with the decision
in its past tense: `APPROVE` reads as `approved`, so the id describes the event,
not the button a reviewer pressed.

| Decision | Organizer | Landlord |
|----------|-----------|----------|
| account approved | `organizer_application_approved` | `landlord_application_approved` |
| account rejected | `organizer_application_rejected` | `landlord_application_rejected` |
| account suspended | `organizer_application_suspended` | `landlord_application_suspended` |
| KYC verified | `organizer_kyc_verified` | `landlord_kyc_verified` |
| KYC rejected | `organizer_kyc_rejected` | `landlord_kyc_rejected` |
| offer approved | `organizer_listing_approved` | `landlord_listing_approved` |
| offer sent back | `organizer_listing_rejected` | `landlord_listing_rejected` |
| offer suspended | `organizer_listing_suspended` | `landlord_listing_suspended` |

The offer family is one naming rule over the thing a provider publishes:
`PROVIDER_COPY[kind].offer` supplies the noun, so the same decision reads
"trip" for an organizer and "listing" for a landlord without a second function.

The KYC and offer gates are separate ids from the account decision on purpose:
an account decision changes whether someone may sell at all, an offer decision
changes whether one thing they sell is visible, and the two must never be
confused in a message or in a support conversation.

## 4. How a notice reaches a person

```
decision committed (DB write + consoleAudit)
        │
        └─▶ notifyParty({ recipient, reference, notice })
                 ├─ ensureNotificationsTable()
                 ├─ queueNotification()  → one row in notification_outbox
                 │       └─ unique (reference, template): a repeated decision sends once
                 └─ queue nudge, and the 5-minute cron sweep as the floor
```

Two properties matter:

* **It never throws.** The caller is a decision that is already committed, so a
  messaging failure is logged as `party_notice_failed` and the message is simply
  not sent. An administrator never sees a 500 because an email did not go out.
* **The reference is the thing, not the decision.** For an account decision it is
  the provider id; for an offer decision it is that trip or listing. A retried
  request cannot send the same message twice, and a second listing is a second
  message.

An address that is empty or not an address is skipped (`NO_RECIPIENT`) rather
than failed, so a provider with no email on file never breaks the route.

## 5. Adding a service

1. Add the kind to `ProviderKind` and describe it in `PROVIDER_COPY` — label,
   service, the noun for one thing they publish, console path, and what an
   approved provider should do first.
2. Call `notifyParty()` after the decision has been committed and audited, with
   the reason the administrator was required to give.
3. Reach the provider through their own address, taken from the row the decision
   was made about, never from the request.
4. Run `tests/party-notices.test.mjs`. It holds the shape of the book — every
   kind, every decision, one id per outcome — so a new kind that is missing copy
   or reuses an id fails there rather than in an inbox.

## 6. Wired today

| Service | Decision | Where |
|---------|----------|-------|
| Organizer (vacationRide) | account approved / rejected / suspended | `lib/organizers.ts` → `setOrganizerStatus` |
| Organizer (vacationRide) | KYC verified / rejected | `lib/organizers.ts` → `reviewOrganizerKyc` |
| Landlord (Hostel Finder) | KYC verified / rejected | `lib/hostel-engine/landlord.ts` → `reviewHostelLandlordKyc` |
| Organizer (vacationRide) | trip approved / sent back / suspended | `lib/organizer-trips.ts` → `reviewOrganizerTrip` |
| Landlord (Hostel Finder) | listing approved / sent back / suspended | `lib/hostel-engine/listings.ts` → `reviewHostelListing` |
| Driver (campusRide) | account approved / rejected / suspended | `lib/campus-engine/driver-onboarding.ts` → `reviewDriverApplication` |

`SUBMIT` is deliberately not wired: it is the organizer's own move, and mailing
someone about their own button press is noise.

Vendor (Food, `COMING_SOON`) has copy declared and nothing to hook it to yet:
the application handler does not exist. When it ships a decision, it wires the
same three lines.

## 7. Tests

| File | What it holds |
|------|---------------|
| `tests/party-notices.test.mjs` | the book itself: copy for every kind, one id per outcome, the reason threading, and what the sender does with a repeat, a missing address and a failure |
| `tests/console-kyc.test.mjs` | organiser and landlord account/KYC decisions tell the provider, not the moderator |
| `tests/organizer-publishing.test.mjs` | a trip review reaches the organizer, and submitting does not |
| `tests/hostel-listings.test.mjs` | a listing decision reaches the landlord, names the bed and carries the reason |
| `tests/driver-onboarding.test.mjs` | a driver applies, is decided, and hears about it; suspending ends their ride |
