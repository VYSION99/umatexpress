# Student service launcher

The homepage uses `CampusLauncher.tsx`, scoped `launcher.css`, and the service registry in `services.ts`. Existing service routes own authentication, payments, and booking logic.

To add a service, register its unique ID, title, icon, accent, size, availability, destination, action, description, detail, and category. Mark services without a working destination unavailable. Add an accent rule or artwork only when needed. Stored preferences automatically include newly registered services and discard obsolete or duplicate IDs.

Preferences use the versioned `umatexpress.launcher.v1` local-storage key, synchronise across tabs, and fall back to memory when storage is blocked. No credentials or booking details are stored by the launcher. Pinned services display first; arrow controls reorder the underlying list within each pin group. Open services is the only sheet in the launcher: it carries live services alone, its Hide/Show toggle drives the homepage rail and the full-width banner cards, and Customise can reset the complete layout.

Guest profile, notifications, and bookings explain the missing student account, notification feed, and unified booking history. They do not call administrative APIs or infer payment confirmation. Food remains Coming soon; it stays in the On the way strip and out of the sheet. Its artwork is illustrative; no real menu is advertised. No database migration is required.

For a browser check, start the app on port 5190 and Chrome with a dedicated temporary profile and remote debugging on port 9228, then run `node scripts/check-launcher.mjs`. Set `LAUNCHER_TEST_URL` to test another local origin. The check changes only launcher preferences, verifies four viewport widths and launcher interactions, and writes screenshots to `/tmp/umatexpress-launcher-*.png`.
