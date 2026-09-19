# UMaTeXPRESS project tree

This is the recommended map for working in the codebase. Route folders stay under `app/` because the framework uses the filesystem route tree.

```txt
uMATeXPRESS/
├── app/
│   ├── page.tsx                         # client service launcher
│   ├── layout.tsx                       # app shell, metadata, global installer
│   ├── globals.css                      # shared legacy/global styles
│   ├── ticket.css                       # printable ticket styles
│   ├── palette.css                      # shared colour tokens (white surface, yellow/green/dark cyan)
│   ├── vacation/                        # vacationRide passenger app
│   ├── campus/                          # campusRide student app and ticket
│   ├── admin/                           # administrator password reset (the one address the console still borrows)
│   ├── console/                         # console origin: entry, sign-in, password, disputes and workspaces
│   └── api/
│       ├── admin/                       # admin auth, AI, bookings, campus management
│       ├── campus/                      # campusRide student/map/queue APIs
│       ├── console/                     # console session, bindings, assistant and service endpoints
│       ├── disputes/                    # passenger dispute filing and list
│       ├── driver/                      # driver auth, queue, rides, location APIs
│       ├── passenger/                   # passenger AI helper
│       ├── payments/                    # initialize, verify, webhook
│       ├── trips/                       # vacationRide schedule/display/availability
│       └── v1/                          # stable campus API aliases
├── components/
│   ├── admin/                           # console session gate, service registry and vacationRide admin console
│   ├── console/                         # the one shell every service is framed by, the assistant and the unavailable-service frame
│   ├── campusRide/
│   │   ├── admin/                       # campusRide admin widgets
│   │   ├── driver/                      # driver portal widgets
│   │   ├── shared/                      # map, shell, AI assistant
│   │   └── student/                     # nearest ride and queue UI
│   ├── launcher/                        # public app launcher widgets and the service registry
│   ├── pwa/                             # home-screen install engine
│   └── vacation/                        # vacationRide flyer carousel
├── lib/
│   ├── campus-engine/                   # campusRide API business engine
│   ├── admin-auth.ts                    # admin session auth
│   ├── admin-credentials.ts             # admin password hashing/recovery
│   ├── campus-ai.ts                     # campusRide AI prompts
│   ├── campus-location.ts               # distance/location helpers
│   ├── campus-matching.ts               # nearest ride matching
│   ├── campus-ride.ts                   # campusRide data access and setup
│   ├── campus-route-geometry.ts         # corridor route geometry (no routing service)
│   ├── cloudflare-ai.ts                 # Workers AI client
│   ├── cloudflare-binding-spec.ts       # binding names and BINDING=value parsers
│   ├── cloudflare-bindings.ts           # typed access to AI/Images/R2/Queue/DO/mTLS
│   ├── console-audit.ts                 # console action audit trail
│   ├── console-applications.ts          # every way into the console: applications and invited access
│   ├── console-assistant.ts             # assistant runtime: tool loop, handlers, daily brief, signed confirmations
│   ├── console-assistant-catalog.ts     # what the assistant may read and propose, per role
│   ├── console-auth.ts                  # console accounts, sessions and role guards
│   ├── console-hosts.ts                 # console origin boundary policy
│   ├── console-signin.ts                # console sign-in and password change
│   ├── dynamic-trips.ts                 # vacationRide dynamic trips
│   ├── disputes.ts                      # trip disputes: open, list, resolve, audit
│   ├── edge-cache.ts                    # Cloudflare per-colo response cache
│   ├── mtn-momo.ts                      # MTN MoMo provider
│   ├── organizer-insights.ts            # route-overlap warnings and per-trip analytics
│   ├── organizer-trips.ts               # organizer trip lifecycle and review state machine
│   ├── organizer-payouts.ts             # commission split, payout ledger, transfers and reconcile
│   ├── organizers.ts                    # organizer records, KYC and payout capture
│   ├── public-notices.ts                # public flyer feed: platform plus approved organizer notices
│   ├── payment-access.ts                # ticket/payment access cookies
│   ├── paystack.ts                      # Paystack provider
│   ├── paystack-banks.ts                # payout destinations (Ghana banks and networks)
│   ├── rate-limit.ts                    # in-worker request throttling
│   ├── runtime-env.ts                   # Cloudflare/local env access
│   ├── secret-box.ts                    # AES-GCM seal/open for payout and KYC values
│   ├── staff-session.ts                 # staff guard bridging console and legacy admin
│   ├── trip-notice.ts                   # client-safe trip notice shape, placeholder cleanup and live route lines
│   ├── trip-settings.ts                 # vacationRide display settings
│   ├── trips.ts                         # shared trip helpers
│   ├── turso.ts                         # Turso REST pipeline client
│   └── vacation-notify.ts               # vacationRide confirmation and cancellation messages
├── public/
│   ├── manifest.webmanifest             # installable app manifest
│   ├── sw.js                            # service worker shell cache
│   ├── logo.png                         # brand master (1080x858)
│   ├── logo-web.png                     # optimised wide logo the app loads
│   ├── logo-mark.png                    # square mark for rail, launcher and ticket badges
│   ├── icon-192.png                     # installer icon (from the logo master)
│   ├── icon-512.png                     # installer icon
│   ├── icon-maskable-192.png            # maskable installer icon, safe-zone padded
│   ├── icon-maskable-512.png            # maskable installer icon
│   ├── apple-touch-icon.png             # iOS home-screen icon
│   └── vip-coach.png                    # vacationRide hero image
├── sql/                                 # manual production migrations
├── scripts/                             # install, audit, build, deploy helpers
│   └── build-icons.py                   # regenerate installer icons from logo.png (needs Pillow)
├── campusRide/                          # planning notes for the campusRide product
├── build/                               # framework helper code and the Cloudflare binding plan
├── worker/                              # Worker entry point and the RateLimiter Durable Object
├── tests/                               # Node test suite
├── docs/                                # project documentation and tree maps
├── .env.example                         # safe environment variable template
├── cloudflare-env.d.ts                  # Cloudflare module typing shim
├── package.json                         # scripts and dependencies
└── README.md                            # setup/deploy overview
```

## Working rule

- Put route UI and route handlers in `app/`.
- Put reusable UI in `components/`.
- Keep client colour and background rules in `app/palette.css`: it owns the tokens and remaps the legacy
  `--lime` / `--cream` values, so a new surface cannot inherit the old lime by accident.
- Put business logic, integrations, auth, and persistence in `lib/`.
- Put manual DB updates in `sql/`.
- Put operational scripts in `scripts/`.
- Put long-form planning/review notes in `docs/` or the product folder, not inside route folders.
