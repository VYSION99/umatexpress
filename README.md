# UMaTeXPRESS

UMaTeXPRESS is one student transport platform with multiple apps.

Current apps:

- `/` — client home for routing passengers into apps.
- `/account` — the student account shared by every passenger app.
- `/vacation` — vacationRide passenger booking for fixed long-distance trips.
- `/campus` — campusRide passenger nearest-ride finder.
- `/admin` — super-admin management home.
- `/admin/vacation` — vacationRide management.
- `/admin/campus` — campusRide management.
- `/driver` — campusRide driver console.

The client routes (`/`, `/vacation`, `/campus`) deliberately do not link to the management console or the driver console: each audience reaches its own area by URL, and the two consoles are never surfaced from the passenger site.

vacationRide provides live seat availability, Paystack or MTN MoMo payments, printable image tickets, and admin scheduling.
campusRide is being built as a paid live campus ride queue/matching system with driver accounts, PIN boarding, map widgets, and AI help.
It also ships as an installable web app with home-screen support on mobile devices.

campusRide planning and implementation notes live in [`campusRide/`](./campusRide/).
The codebase navigation map lives in [`docs/PROJECT_TREE.md`](./docs/PROJECT_TREE.md).

## Requirements

- Node.js 22.13 or newer
- A Turso database
- Paystack transaction credentials, or MTN MoMo Collection API credentials

## Setup

1. Copy `.env.example` to `.env` if `.env` does not already exist.
2. Replace every placeholder in `.env` with real development credentials.
3. Install and run the app:

```sh
npm install
npm run dev
```

The checked-in `.env.example` documents all required variables. `.env` is ignored and must never be committed.

## Environment variables

- `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`: Turso connection credentials.
- `PAYMENT_PROVIDER`: Use `PAYSTACK` while MTN MoMo KYC is pending, or `MTN_MOMO` later.
- `PAYSTACK_BASE_URL`: Paystack API origin. The default is `https://api.paystack.co`.
- `PAYSTACK_SECRET_KEY`: Paystack secret key from your dashboard.
- `PAYSTACK_CURRENCY`: Currency sent to Paystack. Use `GHS` for Ghana.
- `PAYSTACK_FEE_PERCENT`: Paystack fee percentage passed to the passenger. Defaults to `1.95` for Ghana.
- `CLOUDFLARE_ACCOUNT_ID`: Optional Cloudflare account ID for Workers AI.
- `CLOUDFLARE_AI_BINDING` (default `AI`): binds Workers AI directly, which is the preferred path and needs no token at all. See `docs/CLOUDFLARE_BINDINGS.md`.
- `CLOUDFLARE_AI_TOKEN`: Optional narrow Workers AI token, used only as the fallback when the AI binding is disabled. Do not reuse the deployment API token here.
- `CLOUDFLARE_AI_MODEL`: Optional Workers AI model name. Defaults to `@cf/meta/llama-3.3-70b-instruct-fp8-fast`.
- `MTN_MOMO_BASE_URL`: MTN API origin. The sandbox default is included.
- `MTN_MOMO_TARGET_ENVIRONMENT`: Usually `sandbox` or the configured production environment.
- `MTN_MOMO_CURRENCY`: Use `EUR` in the MTN sandbox and the production account currency in production.
- `MTN_MOMO_API_USER`, `MTN_MOMO_API_KEY`, and `MTN_MOMO_COLLECTION_KEY`: Collection API credentials.
- `ADMIN_EMAILS`: Comma-separated email addresses allowed to sign in as administrators.
- `TRUST_PLATFORM_IDENTITY`: Set to `true` only when a hosting proxy strips and injects `oai-authenticated-user-email` itself. Defaults to `false`, which ignores the header.
- `ADMIN_PASSWORD`: Bootstrap password for local sign-in. It defaults to `Admin@12345`; change it from the admin security page once Turso is connected.
- `ADMIN_SESSION_SECRET`: Random value of at least 32 characters used to sign HTTP-only admin sessions. Hosted workspace identity headers remain supported.
- `DRIVER_SESSION_SECRET`: Optional random value of at least 32 characters used to sign driver sessions. If omitted, `ADMIN_SESSION_SECRET` is reused.
- `RESEND_API_KEY` and `RESEND_FROM`: Resend credentials, the only mail provider. `RESEND_FROM` must be an address on a domain verified in Resend. Without them, in-app notifications still work and email is simply not attempted.
- `RESEND_REPLY_TO`: Optional reply-to address for passenger replies.
- `STUDENT_SESSION_SECRET`: Random value of at least 32 characters used to sign student account sessions. If omitted, `DRIVER_SESSION_SECRET` and then `ADMIN_SESSION_SECRET` are reused.

## Commands

```sh
npm run dev       # local development server
npm run lint      # ESLint validation
npm run typecheck # TypeScript validation
npm run build     # production Cloudflare/Vinext build
npm test          # production build and Node test suite
npm run start     # serve an existing production build
```

## Home-screen installation

The app is installable as a PWA from the root layout, so the install prompt is available across the launcher, vacationRide, campusRide, driver portal, and admin console. Android/desktop browsers can show the native install prompt. iPhone users should open Safari, tap Share, then choose Add to Home Screen.

The shell service worker (`public/sw.js`) makes the app open offline. Navigations are **network-first** — a stale HTML document can reference build assets that the next deploy removed, which would break the app until the user cleared site data — and static assets use stale-while-revalidate. The worker is skipped unless the app is running a production build on HTTPS (or `localhost`), so it never serves yesterday's CSS against the dev server. Offline, a visited page is served from cache and falls back to the cached home shell.

## Cloudflare Workers deployment

Authenticate Wrangler first:

```sh
npx wrangler login
```

Add production secrets to Cloudflare:

```sh
npx wrangler secret put TURSO_DATABASE_URL --name umatexpress
npx wrangler secret put TURSO_AUTH_TOKEN --name umatexpress
npx wrangler secret put PAYMENT_PROVIDER --name umatexpress
npx wrangler secret put PAYSTACK_SECRET_KEY --name umatexpress
npx wrangler secret put PAYSTACK_CURRENCY --name umatexpress
npx wrangler secret put PAYSTACK_FEE_PERCENT --name umatexpress
npx wrangler secret put ADMIN_EMAILS --name umatexpress
npx wrangler secret put ADMIN_PASSWORD --name umatexpress
npx wrangler secret put ADMIN_SESSION_SECRET --name umatexpress
npx wrangler secret put DRIVER_SESSION_SECRET --name umatexpress
npx wrangler secret put STUDENT_SESSION_SECRET --name umatexpress
npx wrangler secret put RESEND_API_KEY --name umatexpress
npx wrangler secret put RESEND_FROM --name umatexpress
npx wrangler secret put CAMPUS_APP_URL --name umatexpress
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID --name umatexpress
npx wrangler secret put CLOUDFLARE_AI_TOKEN --name umatexpress
npx wrangler secret put CLOUDFLARE_AI_MODEL --name umatexpress
```

For `CLOUDFLARE_AI_TOKEN`, create a Cloudflare API token with Workers AI permission. Do not paste your Paystack secret, Turso token, or general deployment token unless that token was intentionally created with Workers AI access.

Deploy to your temporary Workers URL, for example `umatexpress.acmdevelopers2020.workers.dev`:

```sh
npm run deploy:cloudflare
```

## Paystack URLs

Set the Paystack callback / redirect URL to:

```txt
https://umatexpress.acmdevelopers2020.workers.dev/payment/callback
```

Set the Paystack webhook URL to:

```txt
https://umatexpress.acmdevelopers2020.workers.dev/api/payments/webhook
```

The webhook verifies Paystack's `x-paystack-signature` header using
`PAYSTACK_SECRET_KEY`, then confirms the matching vacationRide booking or campusRide queue payment server-side.

## Manual SQL migration

Run the consolidated schema once against a fresh Turso database:

```txt
sql/000_umatexpress_full_migration.sql
```

It creates every table and index, seeds `trip_settings`, and is safe to run more than once. On an existing database it will not add new columns to tables that already exist, because SQLite has no `ADD COLUMN IF NOT EXISTS`; the app self-heals those columns at runtime, or you can run the optional `ALTER TABLE` list in section 8 of the file.

The numbered files `sql/001` … `sql/013` are kept as a historical record. `sql/000_umatexpress_full_migration.sql` supersedes them.

## Smoke test

After a migration or deploy, assert the live campusRide invariants (capacity,
queue positions, paid-but-not-advanced entries, expired holds) without writing
anything:

```sh
node scripts/smoke-campus-ride.mjs
node scripts/smoke-campus-ride.mjs --url=https://umatexpress.acmdevelopers2020.workers.dev
```

The script is read-only and exits non-zero on failure, so it can gate a deploy. Add `--url=` to also check that the public endpoints respond.

## Payment reconciliation

Stale PENDING campusRide payments are re-verified against Paystack and expired checkout holds are swept by a Cloudflare Cron Trigger every 5 minutes (`triggers.crons` in `vite.config.ts`). The worker's `scheduled` handler calls `runCampusReconcile` in `lib/campus-engine/reconcile-job.ts`; it logs one `reconcile_run` line per tick and never throws.

You can run the same sweep on demand (admin-authenticated) with `POST /api/admin/campus/reconcile`.

## Booking safety

Seats are held for ten minutes while payment is pending. A successful payment only confirms a booking when its hold is still valid or was already claimed by that booking. Late successful payments enter `PAYMENT_RECEIVED_REVIEW` so an administrator can assign another seat or arrange a refund.

Payment status and ticket data require a hashed, HTTP-only, per-payment browser token. Public payment responses do not expose passenger email addresses or phone numbers.

## Student accounts

UMaTeXPRESS keeps **one account per student for the whole platform**, not one per service. campusRide and vacationRide accept the same session, so signing in once covers either app, and the account lives on the platform rather than inside either service.

Only addresses ending in `@st.umat.edu.gh` can hold an account. The rule is a pure function in `lib/student-email.ts`, used by both the sign-in form and the server, so another domain is rejected before any database work happens.

Browsing is never gated. Search, fares, seat availability, zones, the campus map, ticket pages, and the public API stay open to signed-out visitors. The account is required only where money is committed:

- `POST /api/payments/initialize` — vacationRide seat hold and payment.
- `POST /api/campus/queue/initialize`, and the legacy alias `POST /api/v1/campus/student/rides` — campusRide queue join and payment.

Both routes take the passenger email from the account rather than the request body, so the Paystack receipt always goes to the signed-in student and nobody can start a booking in another passenger's name.

### Account API

`/api/auth/student` is the only account surface:

| Method | Purpose |
| --- | --- |
| `GET` | Who is signed in. Never throws, and answers `{"ok":true,"account":null}` when nobody is. |
| `POST` | Sign in. |
| `PUT` | Create an account. |
| `PATCH` | Save the profile (name and mobile money number), or change the password when `newPassword` is present. |
| `DELETE` | Sign out. |

The session is an HMAC-signed, HTTP-only, `SameSite=Lax` cookie (`umx_student_session`, 30 days, `Secure` on HTTPS). Passwords are stored as PBKDF2-SHA256 with a per-account salt. Changing a password or deactivating an account bumps `token_version` or clears `active`, which retires every session already issued for that account. Responses never contain the hash, salt, or iteration count, and an unknown address still pays one password derivation so the response time does not reveal which addresses have accounts.

Sign-in and sign-up are rate limited and share the same `authGuardStatus` lockout as the admin and driver sign-in paths. The `student_accounts` table is created by section 4 of `sql/000_umatexpress_full_migration.sql`; the app also creates and self-heals it at runtime, at most once per isolate.

No email or SMS provider is configured, so `email_verified` stays `0`: the domain is checked, but nothing proves the mailbox exists, and there is no password-reset flow. A delivery provider is the prerequisite for self-service recovery.

`tests/student-auth.test.mjs` covers the domain rule, the password policy, cookie signing and tampering, session revocation, and that every account action requires a session.

## campusRide passenger experience

The paid ticket at `/campus/ticket?reference=…` tracks the ride live instead of asking the passenger to refresh:

- `GET /api/campus/queue/status?reference=…` returns the boarding timeline, queue position, how many riders are ahead, an estimated wait, and the driver/vehicle. It is authorised by the same per-payment token as verification and never returns the boarding PIN.
- The ticket page polls that endpoint every 15 seconds, and also refreshes when the tab becomes visible or the device reconnects.
- The last verified ticket is cached on the device, so the boarding PIN still shows at the gate when there is no network. The cache is per passenger device, and the ticket page has a **Forget ticket** action to clear it.
- **Share trip** sends the route and reference only — never the boarding PIN.
- Repeat riders get their name and phone prefilled from the last queue join.

The timeline and wait estimate are pure functions in `lib/campus-engine/progress.ts`, covered by `tests/queue-progress.test.mjs`. The wait estimate assumes riders are picked up in batches of the vehicle capacity, so it is deliberately labelled as an estimate.

## Passenger notifications

Driver actions queue a passenger message (accepted, arrived, trip completed, cancelled) into `notification_outbox`. Queuing is idempotent per `(reference, template)`, so repeating a driver action cannot message a rider twice, and a notification failure never blocks or undoes the driver action.

That one row is both the **in-app notification** and the **email**. The student reads it in the notification panel on `/` (or `GET /api/notifications`), even when no mail provider is configured; the cron emails a copy through Resend when it is. Because mail delivery is only a copy, a bounced mailbox never costs a student their ride update.

- `GET /api/notifications` returns the signed-in account's latest 30 messages with an unread count. `PATCH /api/notifications` marks one message (`{"id": "…"}`) or the whole feed (`{"all": true}`) as read. Both are scoped to the account email from the session, so one student can never read or clear another's feed, and both are `no-store`.
- Mail is addressed to the account email the passenger booked with, not the phone number on the queue entry: the retired SMS providers are gone. Rows left over from them (a recipient with no `@`) are skipped by the dispatcher and age out through retention.
- The message body is the same text the feed shows. Only the email carries the ticket link, built from `CAMPUS_APP_URL`, and messages never contain the boarding PIN.

The 5-minute reconciliation cron flushes the outbox. Each message is claimed with an atomic `UPDATE ... WHERE status='PENDING'` before sending, so overlapping cron runs cannot deliver the same email twice; a message stuck in `SENDING` past its 10-minute lease is reclaimed on the next run. The outbox prunes itself: pending rows older than 7 days and settled (`SENT`/`FAILED`) rows older than 30 days are deleted, so it cannot grow without bound. Delivery counts (including stuck `FAILED`) are exposed to admins via `GET /api/admin/campus/metrics` as `notifications`, together with the provider name and whether Resend is configured.

Resend failures are recorded on the row with the provider's detail, and retried on a 30s / 2m / 4.5m backoff up to three attempts before the row is marked `FAILED`. The exact request Resend receives is asserted in `tests/resend-email.test.mjs`, the feed's account scoping in `tests/notification-feed.test.mjs`, and the queueing, claim, reclaim and pruning rules in `tests/notifications.test.mjs`.

Drivers also get a **Today** card (`GET /api/driver/summary`) with completed trips, boarded passengers, fares collected, queue depth, and the next pickup.

## campusRide driver flow

campusRide passengers join a paid queue and receive an image-style ticket with a boarding PIN. Drivers use `/driver` to open a ride, view paid waiting passengers, accept the passenger, mark arrival, verify the PIN, then complete the ride. No-shows and driver cancellations release the slot and write audit records.

## Admin password recovery

Stored admin passwords are hashed, so a forgotten password cannot be viewed. To recover access:

1. Open [`sql/000_umatexpress_full_migration.sql`](./sql/000_umatexpress_full_migration.sql) and find section 9.
2. Replace `admin@example.com` with the affected admin email, then uncomment the `DELETE` line.
3. Run the statement in Turso.
4. Sign in with the current `ADMIN_PASSWORD` environment/Cloudflare secret.
5. Immediately set a new password from `/admin/change-password`.

## Admin audit logs

Cancelled bookings can be permanently deleted from the admin table, but the app first writes a copy of the deleted booking into `admin_audit_logs`. The table is created by [`sql/000_umatexpress_full_migration.sql`](./sql/000_umatexpress_full_migration.sql) if you are applying SQL manually.
