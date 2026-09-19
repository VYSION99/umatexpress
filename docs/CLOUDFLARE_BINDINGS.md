# Cloudflare bindings

Every Cloudflare binding the Worker can use is described in two places, and
nothing else:

- `lib/cloudflare-binding-spec.ts` — binding names, environment variable names
  and the parsers for the `BINDING=value` lists. It has no imports, so the build
  tool, workerd and plain Node tests all read the same description.
- `build/cloudflare-binding-plan.ts` — turns the environment into the
  `wrangler.json` block, and writes the effective names back into `vars` so the
  Worker resolves exactly what was built.

`vite.config.ts` calls the plan, so `vinext build` emits the bindings into
`dist/server/wrangler.json`, and `scripts/deploy-cloudflare.sh` copies that file
to `dist/server/wrangler.deploy.json` (overriding only the Worker name, entry
point, assets and console route). There is no second place to remember.

## The bindings

| Binding | Variable | Default | Account-side resource | Used by |
| --- | --- | --- | --- | --- |
| Workers AI | `CLOUDFLARE_AI_BINDING` | `AI` | none | `lib/cloudflare-ai.ts` |
| Images | `CLOUDFLARE_IMAGES_BINDING` | `IMAGES` | Images enabled on the account | `worker/index.ts` `/_vinext/image` |
| R2 | `CLOUDFLARE_R2_BINDING` | `PRIVATE_BUCKET` | bucket `CLOUDFLARE_R2_BUCKET` | `lib/cloudflare-bindings.ts`, Phase 3 KYC documents |
| Queue | `CLOUDFLARE_QUEUE_BINDING` | `NOTIFICATION_QUEUE` | queues `CLOUDFLARE_QUEUE` and `<queue>-dlq` | `lib/notifications.ts`, `worker/index.ts` `queue()` |
| Durable Object | `CLOUDFLARE_RATE_LIMITER_BINDING` | `RATE_LIMITER` | none (migration `v1`) | `worker/rate-limiter.ts`, `lib/rate-limit.ts` |
| Service binding | `CLOUDFLARE_SERVICE_BINDINGS` | empty | the other Worker must exist | `lib/cloudflare-bindings.ts` |
| mTLS certificate | `CLOUDFLARE_MTLS_CERTIFICATES` | empty | an uploaded certificate | `lib/mtn-momo.ts` |
| Subrequest limit | `CLOUDFLARE_SUBREQUEST_LIMIT` | empty | none | `limits.subrequests` in the generated config |

Set a binding variable to the empty string to deploy without that binding.
Leaving it unset keeps the default, so a deployment that never touches these
variables gets Workers AI, Images, R2, the queue and the rate limiter.

### What each binding changes

**Workers AI.** `env.AI` is tried first, so the model is billed to the account
that owns the Worker and no API token travels with the request. The REST path
(`CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_AI_TOKEN`) is still implemented as a
fallback for a deployment that cannot bind Workers AI; it is no longer
required. `cloudflareAiConfigStatus()` reports which mode is live.

**Images.** `worker/index.ts` already calls `env.IMAGES` for `/_vinext/image`;
before this binding existed that route could only answer 404. The binding
requires the Images product to be enabled on the account. It is a paid
Cloudflare feature; if the first deploy is rejected for it, set
`CLOUDFLARE_IMAGES_BINDING=` and deploy again — nothing else changes.

**Queue.** `notification_outbox` stays the source of truth. `queueNotification`
writes the row and then sends `{ id, reference, template, queuedAt }` to
`NOTIFICATION_QUEUE`; the `queue()` handler in `worker/index.ts` calls
`dispatchPendingNotifications({ ids })`, which claims each row atomically
before sending. A lost, duplicated or late message costs latency and nothing
else, and the `*/15 * * * *` sweep still covers retries and backoff. The queue
turns a five-minute delivery wait into milliseconds. A deployment that disables
the queue should move the sweep to `*/5 * * * *` in
`lib/campus-engine/crons.ts`, because the sweep is then the only delivery path.

Both products share the outbox. The template names the product: campusRide
templates link to `/campus/ticket`, and `vacation_`-prefixed templates
(`vacation_booking_confirmed`, `vacation_booking_cancelled`) link to
`/payment/callback`, which is where a vacationRide boarding pass lives. The
choice is made by `ticketLinkForTemplate` at send time, so the row needs no URL
column. The unique `(reference, template)` index is what makes the vacation
confirmation idempotent when payment verification and the Paystack webhook both
confirm the same booking.

**Durable Objects.** `RateLimiter` holds one fixed-window counter per
`(scope, subject)`, in one object per subject, so counts are serialised and
concurrent requests cannot read the same stale value. `lib/rate-limit.ts` tries
the object first, then the durable Turso counter, then the in-memory map. The
class uses SQLite-backed storage (`new_sqlite_classes`), which is what makes
Durable Objects available on the free plan.

**R2.** `PRIVATE_BUCKET` is private storage with no public URL. Phase 3 uses it
for KYC documents, which was previously the blocker for organizer payouts.
Nothing is served from this bucket; reads must go through the Worker.

**Service bindings.** No second Worker exists today, so the list is empty.
Fill it in when the console or an image service becomes its own Worker, with
`CLOUDFLARE_SERVICE_BINDINGS=CONSOLE=umatexpress-console`. A service binding
that names a Worker that does not exist fails the deploy, which is why it is
opt-in.

**mTLS.** The MTN MoMo Collection API expects the client certificate outside
the sandbox. Upload one with
`npx wrangler mtls-certificate upload --cert cert.pem --key key.pem`, then set
`CLOUDFLARE_MTLS_CERTIFICATES=MTN_MOMO_CERT=<certificate-id>`. `lib/mtn-momo.ts`
routes every MoMo request through the binding when it is present and falls back
to plain `fetch` when it is not. mTLS is a property of a custom domain, so a
workers.dev host can never terminate client certificates.

**Subrequest limit.** The Turso client spends one subrequest per SQL statement,
and the Workers free plan allows fifty per invocation — a ceiling that a sweep
walking every active ride used to spend before it ever reached the outbox. So
every job is sized to fit: the sweep takes ten messages, the queue consumer
takes batches of ten, and a queue-driven dispatch skips the lease and retention
scans that belong to the cron. Two jobs never share one invocation:

- `*/5 * * * *` — payment reconciliation (`runCampusReconcile`).
- `2,17,32,47 * * * *` — notification sweep (`runNotificationSweep`).

The triggers are declared from `lib/campus-engine/crons.ts` and routed in
`worker/index.ts`; adding a third job means adding a third trigger. On a paid
plan, set `CLOUDFLARE_SUBREQUEST_LIMIT=1000` to buy headroom for a bigger batch;
the free plan rejects the field outright, which is why it is empty here.

The sweep is offset by two minutes rather than left on `*/15` because
Cloudflare folds every trigger that falls due in the same minute into a single
invocation. Every quarter hour also belongs to `*/5`, so a `*/15` sweep was
never reached — the reconcile ran and the sweep was skipped. `tests/cloudflare-bindings.test.mjs`
parses both minute fields and fails if they ever share a minute again.

**Schema marker.** `ensureCampusRideTables()` used to replay its whole schema
probe — about thirty-seven statements, each its own subrequest — on every cold
isolate, spending most of an invocation's budget before any real work started.
It now writes and reads a `campus_schema_meta` row holding `CAMPUS_SCHEMA_VERSION`:
a cold isolate reads one marker and stops, and warm isolates skip the check
entirely. The pass itself is sent through `tursoBatch()`, which puts every
statement in one pipeline request because Turso counts subrequests per HTTP
call rather than per statement. Measured against the live database, a migrated
cold isolate costs one subrequest and about 280ms, against roughly thirty-seven
requests before. **Bump `CAMPUS_SCHEMA_VERSION` in `lib/campus-ride.ts` whenever
those statements change**, or the new statement never runs.

`campus_schema_meta` is written only after every statement in the batch has
landed, and the in-isolate promise is discarded on failure, so a partially
applied schema is retried rather than cached. `ALTER TABLE ADD COLUMN` is the
one statement that is not idempotent; the pass tolerates its
`duplicate column name` reply instead of probing each column with its own query.

## Deploying

`npm run deploy:cloudflare` reads `.env`, creates the R2 bucket and the queue
(plus its dead-letter queue) if they do not exist, builds, and then deploys.
Creating account-side resources needs an authenticated Wrangler session
(`npx wrangler login`, or `CLOUDFLARE_API_TOKEN` in the environment). The deploy
prints the bindings it is about to ship:

```txt
Bindings: Workers AI=AI, Images=IMAGES, R2=PRIVATE_BUCKET:umatexpress-private,
Queue=NOTIFICATION_QUEUE:umatexpress-notifications,
DurableObject=RATE_LIMITER:RateLimiter
```

The generated config is deliberately not hand-edited: `dist/server/wrangler.json`
comes from the build and is the only input to the deploy config.

## Verifying a deployment

1. `npx wrangler tail --name umatexpress` and look for `reconcile_run`.
2. Sign in to the console as an ADMIN and call
   `GET /api/console/bindings`. It answers with the runtime (`workerd` or
   `node`), and for each binding whether it is present plus the account-side
   resource it points at. That is the only way to know that a rename or a
   disabled binding actually took effect, because bindings are resolved at
   deploy time, not at request time.
3. Book one campusRide seat and confirm `notification_queue_consumed` appears
   immediately, rather than only on the next five-minute tick.

## Local development

Miniflare simulates R2, Queues, the rate limiter and Workers AI locally, so
`npm run dev` needs no Cloudflare account. Two bindings are the exception:
mTLS certificates and service bindings resolve to real account resources, so
leave `CLOUDFLARE_MTLS_CERTIFICATES` and `CLOUDFLARE_SERVICE_BINDINGS` unset for
local work unless you are deliberately testing against remote resources.

## What is never stored in `vars`

`vars` carries binding names and resource names only — no tokens, no keys. A
certificate id is a reference, not a secret; the certificate itself never
leaves Cloudflare. The bindings report is ADMIN-only for the same reason the
rest of the console is: resource names are still deployment detail.
