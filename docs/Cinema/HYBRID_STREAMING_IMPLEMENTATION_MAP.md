# Cinema hybrid streaming implementation map

**Date:** 17 October 2026  
**Status:** Architecture assessed; provider contracts and estimate arithmetic added. External streaming remains disabled.

## Product boundary

Cinema owns event discovery, verified organizers, access, RSVP and waitlists,
attendance, questions, polls, reactions, notes, moderation, study intelligence
and financial policy. Media providers transport video. They do not become the
source of truth for a Cinema event or its audience permissions.

The approved delivery model is:

```text
Host and panelists -> managed JaaS stage
                      |-> JaaS livestream -> YouTube Live (public/free)
                      `-> JaaS custom RTMP -> Cloudflare Stream (private/paid)

Professional production (optional): JaaS stage -> organizer-operated OBS
                                                    |-> YouTube Live
                                                    `-> Cloudflare Stream

Audience player -> Cinema room -> Durable Object interactions
                                -> chat, questions, polls, reactions and notes
```

Direct JaaS livestreaming is the normal path because it removes a second device
and operator from ordinary student events. OBS is an organizer-operated upgrade
for scene composition, titles and production switching. The application may
show setup instructions and ingest credentials to an authorized host, but
cannot assume it can start, stop or repair an organizer's local OBS instance.

## Current system assessment

| Requested capability | Existing implementation | Decision |
| --- | --- | --- |
| Accounts and verification | `student_accounts`, Cinema-specific verified account guard and console staff accounts | Reuse. Do not create Cinema users. |
| Event catalogue | `cinema_events`, public catalogue, posters, upcoming/live/replay sections | Extend existing events. |
| Organizers | `cinema_organizers`; student groups are immediate, clubs and departments require console approval | Extend with plan and provider-account ownership. |
| RSVP and limits | `cinema_event_rsvps`, waitlist promotion, current application cap of 100 | Reuse for in-app admission. Broadcast viewers may later exceed 100. |
| Roles | Host, co-host, presenter and viewer membership roles | Reuse for Jitsi token claims and moderator authorization. |
| Live interaction | One `CinemaRoom` Durable Object per session with WebSockets | Keep as the authority for presence and application interactions. |
| Stage media | Six-person browser peer mesh with TURN fallback | Retain behind a fallback flag until Jitsi is production-tested. Jitsi is not currently integrated. |
| YouTube | Manual URL parsing, official embed and synchronized playback | Reuse for Milestone 3. OAuth broadcast management is new work. |
| Private media | Temporary R2 uploads and signed Cinema media access | Keep for study rooms. It is not a scalable live broadcast service. |
| Cloudflare Stream | No adapter, live input, signed playback or usage reconciliation | New work, disabled by default. |
| Payments | Paystack checkout, idempotent provider operations, signed webhook inbox, finance journal and reconciliation | Extend. Do not create a second generic payment system. |
| Wallet and prepaid credit | No organizer credit account or reservation ledger | Add a Cinema subledger tied to existing finance events. |
| AI | Workers AI plus private Python Intelligence Worker through a service binding | Reuse for asynchronous transcript, question and event analysis. |
| Notifications | Durable outbox/queue and email/in-app templates | Reuse for reminders and spending alerts. |
| Console | Cinema rooms, organizer approval and risk signals; shared platform settings | Extend with streaming operations and finance views. |

## Corrections and constraints

1. Cloudflare Stream currently publishes delivery at USD 1 per 1,000 delivered
   minutes and storage capacity at USD 5 per 1,000 stored minutes. The initial
   assumptions of USD 0.001 and USD 0.005 per minute match that public schedule,
   but remain editable estimates. The provider invoice is authoritative.
2. YouTube playback must remain free. Club Pro may charge for Cinema's own RSVP,
   moderation, analytics and administration, never for access to the embedded
   YouTube video.
3. A YouTube player cannot be covered by custom camera tiles or controls. In
   YouTube mode, panel cameras and Cinema controls must occupy reserved space
   outside the player. Cloudflare-hosted original media can use the floating
   overlay layout.
4. Manual YouTube URLs require no organizer OAuth. Creating or managing a
   broadcast on an organizer's channel requires explicit Google OAuth consent,
   least-privilege scopes, revocation and token protection.
5. Estimated audience and spend alerts are operational safeguards. They are not
   a guaranteed hard cap. Final billing waits for provider-reported usage.
6. Jitsi supports the interactive stage. Large audiences use a YouTube or
   Cloudflare broadcast and remain interactive through Cinema's Durable Object.

## Agreed free-stage policy

The free managed stage is a controlled pilot, not an unlimited meeting plan.
Its initial entitlement is:

- one public JaaS event per quota owner in a rolling 30-day reservation period;
- at most 60 scheduled minutes;
- four unique verified stage identities for the whole event, including the
  initial host;
- one active stage device per account; and
- no private Cloudflare Stream delivery or managed recording.

A student group's quota belongs to its verified student owner. An approved club
or department's quota belongs to the approved organizer record. Delegates use
that same record. Renaming a group, creating another group name, changing the
host, or transferring host controls does not create another allowance.

The four-person rule counts unique accounts admitted during the event, not just
simultaneous camera tiles. Returning a speaker to the audience releases their
device claim but does not erase their admission. This prevents an organizer
from rotating many accounts through four places. A short renewable device
claim permits reconnection while rejecting simultaneous use of one account on
two devices.

Host transfer changes operational moderation only. The original event,
organizer, quota key, plan, duration and stage ceiling remain immutable. The
new host must already be an eligible stage identity; if all four identities
have been used, transferring to a fifth account is refused. Host handoff must
be recorded with the old host, new host, request and acceptance times.

JaaS usage is also protected at the shared account level. The application
records the first managed-stage token used by each verified account in a
calendar month. The initial developer pool warns operations at 15 identities,
raises a high warning at 20 and refuses a first token for another free identity
at 23, preserving two of the 25 included MAUs for support and testing. Existing
monthly identities and running events continue. This ledger is an operational
safety rail; provider usage remains authoritative because JaaS defines the MAU
shown on its invoice and may count usage differently.

## Foundation introduced in this assessment

- `lib/cinema-streaming/contracts.ts` defines provider IDs, broadcast records,
  playback access and the `StreamingProvider`, `BroadcastController`,
  `StreamAccessManager` and `StreamUsageTracker` boundaries.
- `lib/cinema-streaming/pricing.ts` implements integer-safe delivery estimates.
  It keeps maximum invitees, expected concurrency, expected unique viewers and
  billable viewer-minutes distinct.
- Paid streaming has an audited platform toggle with a false default. Provider,
  retail, storage, reserve, FX, minimum-charge and Club Pro price assumptions
  are editable without deployment.
- `lib/cinema-streaming/entitlements.ts` reserves immutable organizer-owned
  free entitlements and enforces unique-stage and active-device limits.
- `sql/038_cinema_streaming_foundation.sql` adds quota leases, entitlements,
  stage admissions and host-transfer audit records without changing current
  Cinema sessions.
- JaaS and free JaaS reservations each have a separate false-by-default switch.
  Credentials are read only on the server.
- `POST /api/cinema/sessions/:id/jaas` issues a short-lived, exact-room RS256
  token only to the host, co-host or admitted presenter. `DELETE` releases that
  account's active device claim. Responses are private and never cached.
- Managed event creation is available only when both JaaS switches and all
  signing credentials are configured. It reserves the organizer entitlement
  before publication and removes the unpublished room if reservation fails.
- Event responses expose only a `managedStage` marker. They never expose an App
  private key, provider token or organizer quota record.

No provider credential, live input or charge is created by this foundation.

## Provider adapters

### YouTube adapter

The first adapter keeps manual video IDs as the baseline. A later OAuth adapter
may schedule broadcasts for a connected organizer. Store only the channel ID,
encrypted refresh token, granted scopes, expiry and revocation state needed to
operate the connection. Access tokens should be refreshed server-side and not
persisted when avoidable.

Public playback responses contain the YouTube video ID, never a copied media
URL. Cinema keeps its own questions, polls and analytics clearly separate from
YouTube API data.

### Cloudflare Stream adapter

The Worker creates and manages live inputs with a server-side API token. An
authorized host may retrieve an ingest URL and key through a short-lived,
no-store response. Audience responses contain only authorized playback data.
Private events use signed playback credentials with short expiry and an event,
viewer and entitlement check before issuance.

Provider usage is imported into immutable reconciliation records. A correction
creates another record; it does not rewrite a finalized charge.

### Jitsi stage adapter

TypeScript validates the Cinema role and issues a short-lived, room-bound Jitsi
JWT. Host and co-host map to moderators. Presenter access is granted only to an
approved panelist or speaking request. Viewers do not join Jitsi unless promoted.
The existing peer mesh remains available during rollout.

## Schema change map

The migration should extend current entities rather than reproducing the
suggested list literally.

### Extend `cinema_events`

- `category`
- `visibility` (`PUBLIC` or `PRIVATE`)
- `streaming_provider` (`YOUTUBE` or `CLOUDFLARE_STREAM`)
- `expected_duration_minutes`
- `maximum_invited`
- `expected_concurrent`
- `expected_unique_viewers`
- `rsvp_required`
- `recording_policy`
- interaction permission flags
- `subscription_entitlement_id`

Existing `capacity`, `starts_at`, `ends_at`, `event_format`, `stage_limit`,
`organizer_id` and `session_id` remain authoritative.

### Add Cinema-specific tables

| Table | Purpose |
| --- | --- |
| `cinema_organizer_streaming_accounts` | Encrypted YouTube connection metadata, channel ownership and revocation state. |
| `cinema_event_broadcasts` | One provider lifecycle record per event/broadcast attempt. |
| `cinema_stream_cost_estimates` | Frozen assumptions, FX rate, quote and reservation used at confirmation. |
| `cinema_stream_usage_records` | Raw provider usage windows with idempotent provider references. |
| `cinema_stream_billing_reconciliations` | Estimate-to-provider variance and finalization state. |
| `cinema_subscription_plans` | Versioned plan price, benefits, quotas and effective dates. |
| `cinema_organizer_subscriptions` | Organizer entitlement and renewal status. |
| `cinema_wallet_accounts` | Organizer credit balance projection and currency. |
| `cinema_wallet_entries` | Append-only purchase, reservation, release, consumption, adjustment and refund entries. |

Do not add duplicate `event_participants`, `event_rsvps` or generic
`payment_transactions` tables. Use `cinema_participants`,
`cinema_event_rsvps`, `payment_intents`, `payment_attempts`, provider operations,
the webhook inbox and the finance journal already in the repository. Revenue
reports should begin as queries over these sources rather than another mutable
summary table.

Every wallet mutation needs a unique business reference. Reservations and
consumption must be conditional transactions so retries cannot double charge.

## Implementation sequence

### M1 — Assessment and safe foundation

- Complete this map. **Implemented.**
- Add provider-neutral contracts and pure estimate arithmetic. **Implemented.**
- Add disabled-by-default JaaS and paid-stream configuration. **Implemented.**
- Add immutable free entitlement and unique-stage admission enforcement.
  **Implemented at the domain layer; event/API integration remains off.**
- Verify build, types, lint and focused tests.

### M2 — Broadcast persistence and mock provider

- Add the non-destructive broadcast and estimate migration.
- Implement an in-memory/mock adapter for local development.
- Add server-side provider registry and authorization tests.
- Extend event reads without changing existing YouTube behavior.

Exit gate: current Cinema tests remain green and a public YouTube event cannot
create a Cloudflare broadcast.

### M3 — YouTube public events

- Add provider selection to the event stepper.
- Preserve manual URL and video-ID publishing.
- Add a server-side OAuth connection flow for verified organizers.
- Add connection removal and Google token revocation.
- Add compliant terms/privacy links and Made-for-Kids handling where API data is used.

Exit gate: public playback is accessible without a Cinema charge, YouTube UI is
unobscured, and disconnecting a channel prevents new API actions.

### M4 — Jitsi interactive stage

- Add a media-provider feature flag and short-lived JWT endpoint.
  **Implemented.**
- Map existing roles and stage requests to Jitsi permissions.
  **Implemented at the authorization/token and embedded-stage boundaries.**
- Add host/panel layouts with the current peer mesh as fallback.
  **Implemented: managed events load the JaaS iframe and standard discussions
  retain the peer stage.**
- Use direct JaaS livestreaming for standard events.
- Document optional OBS production setup and prevent stream audio feedback
  during promotion.

Exit gate: viewers cannot publish media; an approved speaker can enter and leave
the stage without ending the Cinema event.

### JaaS configuration procedure

1. Create or select the JaaS application and upload its RSA public key.
2. Store `JAAS_APP_ID` and the exact full `JAAS_KEY_ID` from the console.
3. Base64-encode the complete PEM private-key file and store it as the Worker
   secret `JAAS_PRIVATE_KEY_BASE64`. Both PKCS#8 (`BEGIN PRIVATE KEY`) and PKCS#1
   (`BEGIN RSA PRIVATE KEY`) PEM files are accepted.
4. Leave `cinema_jaas_enabled` and `cinema_jaas_free_events_enabled` off while
   deploying the secret and running a private staging event.
5. Enable the JaaS switch first, verify token issuance and room entry, then
   enable free reservations. Turning off the free-reservation switch blocks new
   free bookings. Turning off the main JaaS switch blocks new token issuance.
   Neither action sends a command that ends a provider meeting already running.

The current slice loads the JaaS iframe for eligible host, co-host and presenter
accounts, disposes it when they leave, and releases all stage device claims
when the host ends the Cinema room. JaaS provider webhooks and automatic
livestream start remain acceptance work; a host starts livestreaming from the
JaaS controls. Ordinary Cinema events and the existing peer stage continue to
function.

### M5 — Cloudflare private streaming

- Create live inputs through the server adapter.
- Issue authorized signed playback.
- Add RTMPS/SRT/WHIP capability detection rather than promising every mode.
- Add status polling/webhooks, retention and cleanup.
- Keep the feature toggle off until sandbox acceptance passes.

Exit gate: an unauthorized account cannot obtain playback or ingest data, and a
free/public event never invokes the Stream API.

### M6 — Subscription, prepaid credit and reconciliation

- Version plan definitions and entitlements.
- Extend Paystack checkout with Cinema credit purchases.
- Post wallet entries through the existing idempotent payment path.
- Reserve credit transactionally at private-event confirmation.
- Send 50%, 80% and 95% alerts from reconciled usage projections.
- Import provider usage and finalize charges without rewriting the estimate.

Exit gate: webhook replay cannot buy credit twice; concurrent reservation cannot
overspend an account; provider variance is visible before finalization.

### M7 — Organizer and console dashboards

- Organizer events, subscription, estimates, credits and usage.
- Console live operations, provider health, cost/revenue/margin, refunds and
  suspicious activity.
- Distinguish registrations, unique attendees, concurrency, viewing duration and
  delivered minutes everywhere.

### M8 — Reliability and rollout

- Provider contract tests and failure simulation.
- Deployed audience and Durable Object load tests.
- Mobile Safari, Android Chrome and desktop browser acceptance.
- Key rotation, OAuth revocation, payment replay, signed playback expiry and
  recording-retention exercises.
- Enable one approved pilot organizer before general availability.

## External configuration, when each milestone reaches it

| Configuration | Required for |
| --- | --- |
| Google OAuth client ID, client secret, redirect URI and approved YouTube scopes | Organizer channel connection and managed broadcasts |
| Cloudflare account ID and narrowly scoped Stream API token | Live-input management and usage reads |
| JaaS App ID, key ID and private signing key | Managed Jitsi stage |
| Paystack production approval and existing secret | Real credit purchases |
| Named USD/GHS source and update policy | Organizer GHS quotes and invoices |

These credentials are account-side prerequisites. They must be installed as
Worker secrets or encrypted provider connections and never committed to the
repository.

## Acceptance checklist

- Existing Cinema rooms and public events continue to work with all new
  integrations disabled.
- Provider choice is decided server-side from the stored event.
- YouTube playback is free and uses the official player without obstructing it.
- Cloudflare ingest credentials never appear in audience APIs or logs.
- Private playback expires and is denied after entitlement revocation.
- Estimate assumptions and FX rate are frozen on the event quote.
- Provider usage is idempotent and clearly marked estimated or finalized.
- Credit purchases, reservations, releases, consumption and refunds are
  append-only and auditable.
- Jitsi viewers cannot publish; only authorized stage members receive tokens.
- Chat, polls, questions, reactions, notes and attendance remain functional when
  either streaming provider fails.
- Mobile controls do not create horizontal scrolling or cover YouTube controls.

