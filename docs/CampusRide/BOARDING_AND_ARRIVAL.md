# CampusRide Arrival Estimates and the Trip Manifest

**Status:** implemented — the ticket shows an ETA built from the driver's own position, and the driver's manifest builds itself
**Applies to:** the student ticket, the driver console, `campus_rides`, `campus_zones`

---

## 1. The two things a passenger actually asks

"Where is my driver?" and "how long?" Both were previously answered with a
queue-batch estimate: how many riders are ahead of you divided by the seats in
the vehicle. That is the right answer while a passenger is waiting for someone
to accept them, and the wrong answer the moment a driver has, because the
passenger is no longer waiting for a turn — they are waiting for one vehicle
that is somewhere.

So the ticket now has two estimates and uses whichever one is honest:

| When | What the passenger sees | Where it comes from |
|------|------------------------|---------------------|
| `PAID_WAITING` | "About 12 min · 3 ahead of you" | the queue batch estimate |
| `ACCEPTED_BY_DRIVER` | "About 6 min · Your driver is on the way" | the driver's last reported position |
| `DRIVER_ARRIVED` | "At your pickup zone · Meet your driver" | the driver marked themselves arrived |

## 2. What the ETA rests on

`lib/campus-engine/eta.ts` is arithmetic with no database in it, so the console,
the ticket and the tests can share one set of numbers.

| Assumption | Value | Why |
|------------|-------|-----|
| `CAMPUS_ASSUMED_SPEED_KMH` | 18 | a campus shuttle, stopping, turning and waiting at gates |
| `CAMPUS_MARSHALLING_MINUTES` | 2 | finding a bay and getting people in once the vehicle has arrived |
| `CAMPUS_POSITION_STALE_MINUTES` | 3 | a fix older than this is history, not a live ETA |
| maximum | 45 min | a number nobody believes is not worth showing |
| "at the pickup" | within 50 m, or the same zone | naming metres once the driver is inside the zone reads as a bug |

Two rules keep it trustworthy, and they are the reason it is a function rather
than a line of arithmetic in the query:

- **A stale fix is not a live ETA.** If a driver's phone stopped reporting, the
  estimate falls back to the corridor's own travel time and *says so*
  ("the driver's last position is out of date, so this is the route's usual
  time"). A silent fallback would be a promise the platform cannot keep.
- **An untouched coordinate column is not a place.** The schema uses REAL
  columns that read as `0`; `0,0` is the Gulf of Guinea and is treated as "not
  reported", not as a position.

## 3. The trip manifest

The driver's console shows one section per state instead of one list ordered by
queue position, because at a gate a driver is asking two questions — *who is in
the vehicle* and *who am I still collecting* — and neither is answered by a
single mixed list.

| Group | States | What it means to the driver |
|-------|--------|-----------------------------|
| Waiting | `PAID_WAITING` | paid, not yet accepted |
| On the way | `ACCEPTED_BY_DRIVER`, `DRIVER_ARRIVED` | committed to collect |
| Aboard | `BOARDED` | in the vehicle |

The header states the two numbers that matter at a glance: aboard, and seats
left. The manifest builds itself from the queue — a passenger appears when they
pay, moves as they are accepted and their PIN is verified, and leaves when the
trip ends — so there is nothing for the driver to maintain by hand, and no way
for the list to disagree with the ledger.

**Boarding is the PIN.** The passenger's four-digit PIN is shown on their ticket
and never to the driver; the driver enters it, and only a match moves the entry
to `BOARDED`. The PIN is deliberately absent from the driver's queue payload and
from every message the platform sends.

## 4. No-show and cancel are not the same act

Both end the seat, and they leave the passenger in opposite positions:

- **No-show** — the driver was there and the passenger was not. The fare is
  kept, and the record is kept with it.
- **Cancel** — the driver walked away from a passenger who paid. The fare is
  returned in full, recorded at the moment of the cancel (see
  `docs/CampusRide/CANCELLATION_POLICY.md`).

## 5. Files

| Concern | Where |
|---------|-------|
| The ETA arithmetic and its assumptions | `lib/campus-engine/eta.ts` |
| The ticket payload (`pickupEta`) | `lib/campus-engine/queue-status.ts` |
| The ticket's ETA line | `app/campus/ticket/page.tsx` |
| The manifest grouping | `components/campusRide/driver/DriverOperationsPanel.tsx` |
| PIN boarding and the driver's transitions | `lib/campus-engine/driver.ts` → `updateDriverQueueEntry` |

## 6. Tests

`tests/campus-pickup-eta.test.mjs` holds the arithmetic: inside-the-zone
labelling, the speed and marshalling maths, the stale-fix fallback and its
caveat, the absence of an invented number, `0,0` as "not reported", the arrived
short-circuit, and the cap. `tests/campus-cancellation.test.mjs` holds the wiring
— a live driver position on a claimed seat arrives on the ticket as a
`DRIVER_POSITION` estimate of six minutes, and an unclaimed seat carries no ETA
at all.
