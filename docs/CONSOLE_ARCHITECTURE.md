# Console Architecture

**Status:** Phase 1 implemented (identity, origin boundary, sign-in)
**Applies to:** every UMaTeXPRESS management surface, present and future

---

## 1. One identity, one origin

Every console service — CampusRide admin, vacationRide admin, driver, and the
organizer surfaces being built — signs in through **one account** on **one
origin**. There is no second credential store to add for a new service, and no
way for one service's console to be reached from the student site.

| Layer | Where it lives |
|-------|----------------|
| Account store | `console_accounts` (`sql/000_umatexpress_full_migration.sql`, section 4) |
| Session | `umx_console_session`, HMAC-signed, host-only, 8 hours |
| Library | `lib/console-auth.ts` (accounts, sessions, role guards) |
| Sign-in | `lib/console-signin.ts` + `POST /api/console/session` |
| Boundary | `lib/console-hosts.ts`, applied in `worker/index.ts` |
| Screens | `app/console/*` (entry, sign-in, password) |

## 2. Roles

| Role | Meaning | `profile_id` |
|------|---------|--------------|
| `ADMIN` | Platform staff, every service | — |
| `MODERATOR` | Reviews trips, organizer applications and listings; no money, no campus operations | — |
| `ORGANIZER` | Runs their own vacationRide trips | `trip_organizers.id` (Phase 2) |
| `DRIVER` | CampusRide driver | `campus_drivers.id` |

Rules that make the role meaningful:

1. The role is read from the **signed session** and re-checked against the stored
   row on every request. A role claim in a body, query string or header is
   ignored.
2. `requireConsoleRole(request, roles)` is the only role check. A route that
   does not call it does not have a role, and therefore has no access.
3. A role change, a suspension and a password change all take effect on the next
   request, not on the next sign-in: `token_version` and the stored role are
   both compared to the session.
4. `staffSessionFromRequest(request, roles)` defaults to `["ADMIN"]`, so a new
   endpoint is admin-only until somebody widens it on purpose.

## 3. Origin boundary

The console is served from `console.umatexpress.com`. `CONSOLE_HOSTS` lists the
hosts allowed to serve it.

* On the console host: `/console*`, `/api/console/*`, the admin and driver
  surfaces that have not moved yet, and framework assets. `/` redirects to
  `/console`. Everything else is a `404`.
* On every other host: `/console*` and `/api/console/*` are `404`. The public
  site is untouched.
* Unconfigured (`CONSOLE_HOSTS` empty) and loopback hosts are boundary-free, so
  local development and a preview deployment cannot lock anyone out.

The host boundary is **defence in depth**. The control that protects the console
is that every console route requires a session, which is why an unconfigured
host list cannot expose anything on its own.

The console cookie carries no `Domain` attribute, so it is never attached to a
request for the public site, and the public shell service worker is never
registered on console pages.

## 4. Adding a new console service

1. **Add a role** to `CONSOLE_ROLES` if the service has a distinct audience.
   Never add a second account table or a second sign-in route.
2. **Mount the surface** under `/console/*` and its API under `/api/console/*`,
   both on the console host. Add the paths to `lib/console-hosts.ts` only when
   they are new prefixes.
3. **Guard the API** with
   `const account = await requireConsoleRole(request, ["ADMIN", "MODERATOR"])`.
   Scope every query by the account's own id — never by an id from the request.
4. **Audit the sensitive reads** with `consoleAudit()`. Passenger contact
   details (decision D3) are read-audited without exception.
5. **Add the card** to `components/admin/console-services.ts` and list the role
   in `consoleServicesForRole`. The launcher is presentation only; the API guard
   is the access control.
6. **Test the negative case**: another role, and another tenant, must get `401`,
   `403` or `404` — never data.

## 5. Bridged accounts (migration state)

An account with `password_hash IS NULL` is bridged to a legacy credential store:
it authenticates against `admin_credentials` (ADMIN) or `campus_drivers`
(DRIVER) and keeps the identity, role and status in `console_accounts`. The
first console sign-in adopts an existing admin or driver automatically, so
nobody needs a second password to reach the console.

Bridged sessions live **one hour**, not eight, because a legacy store cannot tell
the console that a password changed. Setting a console password stores a real
hash and detaches the account from the legacy credential for console sign-in.

The legacy admin and driver sign-ins keep working on the public origin during
the transition. They are removed once every console surface runs on the console
identity.

## 6. Operating the console

| Requirement | Where |
|-------------|-------|
| Session secret, at least 32 characters | `CONSOLE_SESSION_SECRET` (falls back to `ADMIN_SESSION_SECRET`) |
| Console hosts | `CONSOLE_HOSTS`, comma-separated |
| Custom domain bound on deploy | `CLOUDFLARE_CONSOLE_HOST` |

Until the custom domain resolves, deploy the console as its own workers.dev
Worker. That is what gives it a hostname of its own while the client stays
public:

```
CLOUDFLARE_CONSOLE_WORKER_NAME=console-umatexpress
CLOUDFLARE_CONSOLE_HOSTS=console-umatexpress.acmdevelopers2020.workers.dev
```

`scripts/deploy-cloudflare.sh` then builds once and deploys twice: the client
Worker keeps the cron triggers and the notification queue consumer; the console
Worker gets neither — a second of either would run every job and send every
message twice — but does get `CONSOLE_HOSTS`, so it serves console surfaces
only while the client refuses `/console*` and `/api/console/*`. Push the
runtime secrets to both Workers:

```
CLOUDFLARE_WORKER_NAME=console-umatexpress scripts/push-secrets.sh
```

`scripts/deploy-cloudflare.sh` writes the console route into the generated
Wrangler config, so a redeploy cannot drop the domain. Binding a custom domain
requires the zone to be in the same Cloudflare account; if it is not, remove
`CLOUDFLARE_CONSOLE_HOST` for that deploy and the console stays on workers.dev.

## 7. Verification

| Check | Command |
|-------|---------|
| Boundary, session and role rules | `node --test tests/console-host.test.mjs tests/console-auth.test.mjs` |
| Type and lint | `npm run typecheck`, `npm run lint` |
| Console pages in a real browser | `node scripts/check-console-origin.mjs` (dev server on 5190, Chrome debug port 9231) |
