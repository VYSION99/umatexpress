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
else, and the `*/5 * * * *` cron still sweeps retries and backoff. The queue
turns a five-minute delivery wait into milliseconds.

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
