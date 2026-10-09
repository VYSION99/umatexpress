# Student service launcher

The homepage uses `CampusLauncher.tsx`, scoped `launcher.css`, and the service registry in `services.ts`. Existing service routes own authentication, payments, and booking logic.

To add a service, register its unique ID, title, icon, accent, size, availability, destination, action, description, detail, and category. Mark services without a working destination unavailable. Add an accent rule or artwork only when needed. Stored preferences automatically include newly registered services and discard obsolete or duplicate IDs.

Preferences use the versioned `umatexpress.launcher.v1` local-storage key, synchronise across tabs, and fall back to memory when storage is blocked. No credentials or booking details are stored by the launcher. Pinned services display first; arrow controls reorder the underlying list within each pin group. The Open services sheet carries live services alone; its Hide/Show toggle drives one homepage card per service, and Customise can reset the complete layout. ACMD and CliPad show their own logos on those cards. The public shell's bottom bar — pills in a desktop hero, a fixed bar on a phone — reads the same projection minus the partners: Home first, then the live services that stay inside the app, in the cards' order, so Cinema appears without a second edit and a service the student hid leaves the bar too.

The profile panel shows ticket links opened on this device; it does not claim to be a complete booking history. The homepage opens that panel from its Tickets action. Food remains a planned service in the On the way strip; no menu or ordering flow is advertised. No database migration is required.

For a browser check, start the app on port 5190 and Chrome with a dedicated temporary profile and remote debugging on port 9228, then run `node scripts/check-launcher.mjs`. Set `LAUNCHER_TEST_URL` to test another local origin. The check changes only launcher preferences, verifies four viewport widths and launcher interactions, and writes screenshots to `/tmp/umatexpress-launcher-*.png`.
