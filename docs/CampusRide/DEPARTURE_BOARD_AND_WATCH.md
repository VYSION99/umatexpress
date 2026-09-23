# CampusRide The Departure Board, and Being Told When a Seat Opens

**Status:** implemented — routes come first, and a student who finds nothing live can leave a promise behind
**Applies to:** `/campus`, `campus_seat_watch`, the campus reconcile job

---

## 1. Route-first entry

A student thinks in routes — "the hostel run", "the market run" — not in two
dropdowns describing a journey. The page used to open with a form, which asked
the student to describe what the board could simply show them, and it hid the
one fact that decides everything: whether anything is running at all.

The board is now the first thing on `/campus`:

- every active corridor, with its flat fare, its route time and its distance;
- **seats open right now**, summed across the corridor's live rides;
- sorted so the routes that can be ridden now come first, then the rest;
- tapping a route fills the finder below with that origin and destination, which
  is what makes it an entry point rather than a poster.

The seat count is computed from rides that are `OPEN`, accepting riders, with
slots left. A full ride, a paused ride and a ride that stopped accepting are all
zero seats — the same rule the sweep uses, in `openSeatsByCorridor`.

## 2. "Notify me" — the quiet half of the day

When nothing is live, the board offers **Notify me** instead of a dead end. The
student leaves an email address (or, if signed in, is simply told which account
will be written to), and the platform now knows they wanted a ride on a route at
a moment when it had none to sell.

That is a promise, so it is kept by a job rather than by hope.

| Piece | Behaviour |
|-------|-----------|
| One row per route per address | `campus_seat_watch`, unique on `(corridor_id, email)` — asking twice is a change of mind, not a second row |
| Settled once | `notified_at` is written inside a guarded `UPDATE ... WHERE notified_at = ''`, so two overlapping runs cannot both send |
| Only a real seat | the sweep considers a watch only while its corridor has an `OPEN`, accepting ride with slots left |
| Re-armed on request | watching again clears `notified_at`, so the next free seat is announced |
| One message, once | the outbox is keyed by reference, so a retry is not a second mail |

The sweep runs on the five-minute campus reconcile, costs one query when nobody
has asked for anything, and settles each watch exactly once — a route that stays
open does not become a daily mail.

## 3. What the message says

It answers the two questions the student is about to ask, so the decision can be
made without opening the app: which run, how many seats, and what it costs.

> **A seat opened** — 2 seats have opened on Main Gate → Lecture Area for
> GH₵ 5.00. Open campusRide and join the queue before it fills.

Signing in is deliberately **not** required to watch a route. The moment a
student wants this is the moment they are standing at a gate with nothing live,
and an account wall there is how a wish becomes a lost booking. A signed-in
account always wins the address, so the mail goes to the account's own inbox.

## 4. Files

| Concern | Where |
|---------|-------|
| The watch, the sweep and the seat count | `lib/campus-engine/watch.ts` |
| The message | `lib/campus-engine/notify-templates.ts` → `campusSeatWatchNotice` |
| The endpoint | `app/api/campus/watch/route.ts` |
| The board | `components/campusRide/student/DepartureBoard.tsx` on `/campus` |
| The schedule | `lib/campus-engine/reconcile.ts` → `runCampusSeatWatchSweep` |

## 5. Tests

`tests/campus-seat-watch.test.mjs` holds it: addresses normalise so two
spellings are one person, asking twice is one watch with the newest details,
nothing is sent while a route is quiet, one message arrives when a seat opens
and only one, a settled watch stays settled until it is re-armed, a paused or
full ride is not a seat, the message names the run and the fare, the endpoint
insists on a route, and reading a watch you do not hold says `false`.
