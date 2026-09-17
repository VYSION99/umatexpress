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
│   ├── driver/                          # campusRide driver portal
│   ├── admin/                           # super-admin, vacationRide, campusRide admin
│   └── api/
│       ├── admin/                       # admin auth, AI, bookings, campus management
│       ├── campus/                      # campusRide student/map/queue APIs
│       ├── driver/                      # driver auth, queue, rides, location APIs
│       ├── passenger/                   # passenger AI helper
│       ├── payments/                    # initialize, verify, webhook
│       ├── trips/                       # vacationRide schedule/display/availability
│       └── v1/                          # stable campus API aliases
├── components/
│   ├── admin/                           # management console launcher and gate
│   ├── campusRide/
│   │   ├── admin/                       # campusRide admin widgets
│   │   ├── driver/                      # driver portal widgets
│   │   ├── shared/                      # map, shell, AI assistant
│   │   └── student/                     # nearest ride and queue UI
│   ├── launcher/                        # public app launcher widgets
│   └── pwa/                             # home-screen install engine
├── lib/
│   ├── campus-engine/                   # campusRide API business engine
│   ├── admin-auth.ts                    # admin session auth
│   ├── admin-credentials.ts             # admin password hashing/recovery
│   ├── campus-ai.ts                     # campusRide AI prompts
│   ├── campus-location.ts               # distance/location helpers
│   ├── campus-matching.ts               # nearest ride matching
│   ├── campus-ride.ts                   # campusRide data access and setup
│   ├── campus-routing.ts                # Google/OSRM route engine
│   ├── cloudflare-ai.ts                 # Workers AI client
│   ├── dynamic-trips.ts                 # vacationRide dynamic trips
│   ├── google-maps-loader.ts            # browser Maps JavaScript loader
│   ├── mtn-momo.ts                      # MTN MoMo provider
│   ├── payment-access.ts                # ticket/payment access cookies
│   ├── paystack.ts                      # Paystack provider
│   ├── rate-limit.ts                    # in-worker request throttling
│   ├── runtime-env.ts                   # Cloudflare/local env access
│   ├── trip-settings.ts                 # vacationRide display settings
│   ├── trips.ts                         # shared trip helpers
│   └── turso.ts                         # Turso REST pipeline client
├── public/
│   ├── manifest.webmanifest             # installable app manifest
│   ├── sw.js                            # service worker shell cache
│   ├── logo.svg                         # shared brand logo
│   ├── icon-192.png                     # install icon
│   ├── icon-512.png                     # install icon
│   └── vip-coach.png                    # vacationRide hero image
├── sql/                                 # manual production migrations
├── scripts/                             # install, audit, build, deploy helpers
├── campusRide/                          # planning notes for the campusRide product
├── build/                               # local framework helper code
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
