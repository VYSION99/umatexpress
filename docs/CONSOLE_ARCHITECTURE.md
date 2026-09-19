# Console Architecture

**Status:** Phase 1 implemented (identity, origin boundary, sign-in), one shell for every service
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
| Screens | `app/console/*` (entry, sign-in, password, services) |
| Shell | `components/console/ConsoleShell.tsx` — one frame for every service |
| Service directory | `components/admin/console-services.ts` — what exists, its group and its navigation |
| Assistant | `lib/console-assistant.ts` + `components/console/ConsoleAssistant.tsx` — role-scoped reads and confirmed actions (see `docs/CONSOLE_ASSISTANT.md`) |

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

### Ways in

The console is one account for every service, but there is not one door for
every role. `lib/console-applications.ts` is the single description of both
ways in:

* **Apply** — a service a stranger may run adds an entry to
  `consoleApplications`. The entry carries the role it creates, the fields the
  form collects, the endpoint it posts to, the service that reviews it, and the
  activation policy: `REVIEW` means the account cannot sign in until a reviewer
  approves it (organizers), `DIRECT` means the account signs in at once while
  publishing, payouts and visibility stay gated (landlords and vendors when
  their services open). `implementedConsoleApplicationIds` lists the
  programmes the API can actually process, so a programme may be `OPEN` only
  when it is on that list.
* **Invited** — `consoleInvitedAccess` names the roles that are never
  self-service: drivers are added by CampusRide operations with their vehicle
  and zone, administrator and moderator accounts by an administrator. A test
  pins that no open application can mint an operational role.

`/console/register` is the picker; `/console/register/<programme>` renders the
form from the registry entry, and every form posts to the one endpoint,
`/api/console/applications/<programme>`, which looks the programme up before it
reads a body. The first programme is the organizer application: it writes the
`trip_organizers` row plus a `PENDING` console account, and its review queue is
the Organizer applications service.

## 3. Origin boundary

The console is served from `console.umatexpress.com`. `CONSOLE_HOSTS` lists the
hosts allowed to serve it.

* On the console host: `/console*`, `/api/console/*`, the APIs the console
  screens call (`/api/admin/*`, `/api/driver/*`, the two admin trip reads),
  `/admin/reset-password` while that page waits for a console-native version,
  and framework assets. `/` redirects to `/console`. Everything else is a
  `404`.
* On every other host: `/console*` and `/api/console/*` are `404`, and the
  legacy staff addresses redirect to the console (table below). The public site
  is untouched.
* Unconfigured (`CONSOLE_HOSTS` empty) and loopback hosts are boundary-free, so
  local development and a preview deployment cannot lock anyone out.

The host boundary is **defence in depth**. The control that protects the console
is that every console route requires a session, which is why an unconfigured
host list cannot expose anything on its own.

The console cookie carries no `Domain` attribute, so it is never attached to a
request for the public site, and the public shell service worker is never
registered on console pages.

### Legacy addresses

The console is the only staff surface. The addresses it used to answer on
survive as redirects, so a bookmark, a shared link or a driver's saved home
screen keeps working; the query string travels with the redirect.

| Used to be | Now |
|------------|-----|
| `/admin` | `/console` |
| `/admin/login`, `/driver/login` | `/console/login` |
| `/admin/change-password` | `/console/change-password` |
| `/admin/campus` | `/console/campus` |
| `/admin/vacation` | `/console/vacation` |
| `/driver` | `/console/driver` |

`LEGACY_CONSOLE_PATHS` in `lib/console-hosts.ts` is the single description of
that map. On the console host — and wherever the boundary is not in force, such
as local development — the redirect is a sibling path; on any other host it is
an absolute redirect to the console origin. A path that is not in the map stays
where it is, which is what keeps `/admin/reset-password` working.

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
5. **Add the service** to `components/admin/console-services.ts`: its `group`
   (one of `CONSOLE_GROUP_ORDER`), its `nav` (the pages inside it) and its role
   in `consoleServicesForRole`. The shell renders whatever the directory says;
   the API guard is the access control, and a service with `href: null` is
   listed as "coming soon" instead of linking somewhere unfinished.
6. **Test the negative case**: another role, and another tenant, must get `401`,
   `403` or `404` — never data.

## 5. One shell for every service

The console is one console, the way a cloud console is one console for every
product. A page never draws its own header: it renders `ConsoleShell` and
supplies a label, a title, a one-line blurb, its own body, and optionally an
action for the top bar.

`components/admin/console-services.ts` is the single description of what exists:

* **A service** is a product area — CampusRide, VacationRide, the organizer
  workspace, payouts, disputes, the services that are still coming — with a
  `group`, an `icon`, an `accent`, display copy and a `nav` list of the pages
  inside it.
* **A group** is a shelf in the directory (`Mobility`, `Money`, `Trust &
  safety`, …). `CONSOLE_GROUP_ORDER` is the display order and the only place to
  add a new shelf.
* **A role** decides what is on the shelf. `consoleServicesForRole` is
  presentation only: every API re-reads the role from the signed session.

The shell adds the parts that must not differ between services: the rail, the
breadcrumb, the service finder, the account cluster, sign-out, the mobile bar,
and the hero. It also mounts the console assistant.
The home page adds `ConsoleBriefStrip` above the directory: the role's daily
brief, read from `/api/console/assistant/brief`, with the assistant panel one
tap away. On a phone the rail steps aside for a fixed bottom bar
(Home / Services / Security / Sign out), so a service is never more than two
taps away.

Adding a service to the sidebar is therefore one registry entry, and no page
copies navigation markup.

## 6. Bridged accounts (migration state)

An account with `password_hash IS NULL` is bridged to a legacy credential store:
it authenticates against `admin_credentials` (ADMIN) or `campus_drivers`
(DRIVER) and keeps the identity, role and status in `console_accounts`. The
first console sign-in adopts an existing admin or driver automatically, so
nobody needs a second password to reach the console.

Bridged sessions live **one hour**, not eight, because a legacy store cannot tell
the console that a password changed. Setting a console password stores a real
hash and detaches the account from the legacy credential for console sign-in.

Every staff surface now runs on the console origin: `/admin` and `/driver` are
redirects, and the only legacy address still standing is the administrator
password reset at `/admin/reset-password`. It authenticates against the same
`admin_credentials` store until it too moves behind `console_accounts`.

## 7. Operating the console

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

## 8. Verification

| Check | Command |
|-------|---------|
| Boundary, session and role rules | `node --test tests/console-host.test.mjs tests/console-auth.test.mjs` |
| Type and lint | `npm run typecheck`, `npm run lint` |
| The service directory contract | `node --test tests/console-ia.test.mjs` |
| Applications and invited access | `node --test tests/console-applications.test.mjs` |
| The assistant's tools, roles and proposals | `node --test tests/console-assistant.test.mjs` |
| Console pages in a real browser | `node scripts/check-console-origin.mjs` (dev server on 5190, Chrome debug port 9231) |

The browser check stubs the session endpoint by role, so it needs no
credentials. It asserts the shell frames every page, the rail lists only what
the role may use, the home page groups services in the declared order, a
service page opens its own sub-navigation, CampusRide, VacationRide and the
driver portal render inside the shell, the legacy addresses redirect into the
console with their query string, the finder searches every service, and nothing
overflows or drops below a 44px touch target at 320, 390, 768 and 1440 pixels.
It also checks that the access page offers every service, that an unopened
service cannot be applied for, and that the organizer form collects the agreed
fields. It writes screenshots to `/tmp/umatexpress-console-*.png`.
