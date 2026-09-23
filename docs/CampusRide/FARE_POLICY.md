# CampusRide Fares

**Status:** implemented — a tariff is guarded when it is saved and its split is recorded when it is paid
**Applies to:** `campus_route_corridors`, `campus_fares`, `campus_payments`, the campus operations console

---

## 1. The shape of a campus fare

A campus fare is **one published number per corridor**. It is not computed from
demand, and it never moves while a student is looking at it. A passenger sees the
price on the departure board before paying, and the amount they pay is written
onto the queue entry at reserve time, so a later tariff change cannot move the
price of a seat already sold.

That flat number is what makes a hike impossible. The cost of that decision is
that the tariff also cannot protect itself, so two numbers are computed from a
cost model and enforced around it: a **floor** and a **ceiling**.

## 2. The cost model

The cost model does not price the ride. It answers one question — what does one
trip cost to run — so the guardrail can be a fact instead of an opinion.

| Input | Meaning | Setting | Shipped default |
|-------|---------|---------|-----------------|
| `costPerKm` | fuel and wear for one kilometre | `campus_fare_cost_per_km` | 240 (GH₵2.40) |
| `costPerMinute` | occupying the vehicle and its driver for one minute | `campus_fare_cost_per_minute` | 30 (GH₵0.30) |
| `standingCost` | what a departure costs whatever its length | `campus_fare_standing_cost` | 150 (GH₵1.50) |
| `assumedSeats` | the seats a corridor is planned around | `campus_fare_assumed_seats` | 6 |
| `loadFactorBps` | the share of those seats a trip is expected to sell | `campus_fare_load_factor_bps` | 7000 (70%) |
| `commissionBps` | the platform's share of the fare | `campus_commission_bps` | 1000 (10%) |
| `maxMarkupBps` | how far above the floor a corridor may be priced | `campus_fare_max_markup_bps` | 6000 (60%) |
| `minFare` / `maxFare` | the absolute band a tariff must sit inside | `campus_fare_min_amount` / `campus_fare_max_amount` | GH₵1.00 / GH₵30.00 |

A trip is counted as a **round trip**: a shuttle that leaves a gate has to come
back, so both the distance and the time are doubled.

### 2.1 Where the two per-unit numbers come from

The two numbers an administrator tunes are derived, not guessed. Each is three
figures operations can look up, divided once:

**Cost per kilometre** — fuel, wear and nothing else:

```
costPerKm = (fuel price per litre ÷ 100) × litres per 100 km   +   wear per km
          = (GH₵15.00 ÷ 100) × 13                            +   GH₵0.45
          = GH₵1.95                                         +   GH₵0.45
          = GH₵2.40  →  240 pesewas
```

**Cost per minute** — the driver and the vehicle's time, spread over the minutes
a day the vehicle is actually earning:

```
costPerMinute = (driver per day + vehicle overheads per day) ÷ productive minutes per day
              = (GH₵80.00 + GH₵25.00)                        ÷ 360
              = GH₵0.29  →  30 pesewas
```

Read that second one as the **cost of a vehicle-minute**, not a wage: the minute
a trip takes is a minute no other trip can use, and the idle time a driver is
paid for is already inside the daily figure.

None of these are measurements yet. They are the recommended defaults, and the
operations console says so next to every floor it shows. Replacing them takes
three lookups — the price on the pump, the consumption the drivers actually
report, and the daily cost of a driver and a vehicle — and every floor and
ceiling moves together when they are replaced.

## 3. The floor, or why the driver stops losing

```
tripCost     = 2 × distanceKm × costPerKm + 2 × minutes × costPerMinute + standingCost
plannedSeats = the corridor's own plan, or floor(assumedSeats × loadFactorBps ÷ 10000)
costFloor    = ceil(tripCost ÷ plannedSeats)
fareFloor    = ceil(costFloor ÷ (1 − commissionBps ÷ 10000))
```

`costFloor` is the fare at which the driver is whole. `fareFloor` is the fare at
which the driver is whole **and** the platform's commission is covered — the
commission comes out of the price, never out of the driver's cost, so the floor
is divided by the commission's complement rather than accepted as-is. A fare
sitting exactly on `costFloor` would leave the driver short by the platform's
share of it.

The floor uses the **planned load**, not the capacity. A six-seat shuttle that
runs at seventy percent sells four seats, and a tariff built on six loses money
on every trip that runs as it actually runs.

A corridor may **name its own planned load**, and that is the lever that lowers a
floor honestly. A four-kilometre run served by a fourteen-seat bus is planned to
sell ten seats where a six-seat shuttle is planned to sell four, so its floor
falls by more than half without anyone paying a subsidy. `plannedSeats` on the
fare row is that number; `0` means the platform plan on the settings page
decides. It is the seats a departure is planned to **sell**, not the seats in the
vehicle: a corridor that overrides has already made the load-factor judgement
itself.

## 4. The ceiling, or why the student stops being hiked

```
fareCeiling = ceil(fareFloor × (1 + maxMarkupBps ÷ 10000))
```

The ceiling is a published markup on the floor, so it can only move when the
cost inputs move and it moves by a stated amount. It is a second guard, not a
second price: a tariff anywhere between the floor and the ceiling is a decision,
and the ceiling only stops the decision being unreasonable.

An absolute band (`minFare`–`maxFare`) sits outside both. It exists for one
reason: the console's fare field is in cedis and is stored in pesewas, so a typo
is a fifty-cedi ride. A fare outside the band is refused outright rather than
acknowledged.

## 5. The split

The passenger pays the tariff. The platform's commission is taken from the fare
on the **fare, never on the total**, because the total carries Paystack's fee and
that fee is not the platform's revenue. `splitCommission` (`lib/money.ts`) is the
one place that division happens, and it is the same function vacationRide
organizers are paid through.

At payment time the split is written onto `campus_payments` — `commission_bps`,
`commission_amount`, `net_amount` — and never recomputed. A later change to the
commission rate applies to the next ride, not to a ride already sold.

The same row carries `fare_floor`, the floor that was in force when the seat was
sold, so a margin report can tell a tariff that was cheap by design from one that
was cheap by accident.

## 6. Who pays the Paystack fee

The passenger, as a line item the fare itself does not absorb: the checkout total
is the fare grossed up by `PAYSTACK_FEE_PERCENT`. The ledger keeps the two apart —
`fare_amount` is the fare, `fee_amount` is the estimate, `paystack_fee_actual` is
what Paystack reported back. When the effective rate drifts above the configured
one the platform is paying the difference, and that drift is only visible because
both numbers are stored.

## 7. What the console refuses

| Case | Result |
|------|--------|
| Fare outside the absolute band | refused, with the band and the setting that widens it in the message |
| Fare above the ceiling | refused, with the floor, the ceiling and the markup that produced it |
| Fare below the floor | refused unless acknowledged; the message states the per-seat loss per trip |
| Acknowledged below floor | saved, with the administrator recorded on the fare row and in the audit log |
| A corridor whose fare is missing or inactive | the booking is refused with `FARE_NOT_CONFIGURED` — never priced at a default |

The last row is the important one. A fare that cannot be found used to fall back
to a built-in GH₵5.00, which priced a GH₵50 corridor at GH₵5 and paid the driver
on that basis. Nothing is guessed now: a missing tariff fails closed.

The floor and the ceiling that were in force are written onto the fare row when a
tariff is saved, so the console can show a corridor whose price was never checked
(`0`) separately from one that passes.

## 8. The four seeded corridors

Worked through end to end, `distanceKm 3.0`, `minutes 8`, `assumedSeats 6` at the
shipped defaults (`costPerKm 240`, `costPerMinute 30`, `standingCost 150`,
`commission 10%`, `markup 60%`):

| Step | Working | Pesewas | Cedis |
|------|---------|---------|-------|
| Distance cost | 6 km × 240 | 1440 | 14.40 |
| Time cost | 16 min × 30 | 480 | 4.80 |
| Standing | — | 150 | 1.50 |
| `tripCost` | — | 2070 | 20.70 |
| `plannedSeats` | floor(6 × 0.70) | 4 | — |
| `costFloor` | ceil(2070 ÷ 4) | 518 | 5.18 |
| `fareFloor` | ceil(518 ÷ 0.90) | 576 | 5.76 |
| `fareCeiling` | ceil(576 × 1.60) | 922 | 9.22 |

How sensitive that floor is to the two numbers an administrator owns, for a
2.0 km corridor of 8 minutes and 4 planned seats:

| `costPerKm` ↓ / `costPerMinute` → | 20 | 30 | 40 |
|---|---|---|---|
| 200 | GH₵3.54 | GH₵3.98 | GH₵4.43 |
| 240 | GH₵3.98 | GH₵4.43 | GH₵4.87 |
| 280 | GH₵4.43 | GH₵4.87 | GH₵5.32 |

The four corridors the platform seeds, at their current tariffs and the shipped
defaults:

| Corridor | km | min | Trip | Floor | Fare | Ceiling | Driver / trip | Platform / trip |
|----------|----|-----|------|-------|------|---------|---------------|-----------------|
| Main Gate → Lecture Area | 1.4 | 7 | 12.42 | 3.46 | 5.00 | 5.54 | 5.58 | 2.00 |
| Hostel Area → Main Campus | 1.8 | 8 | 14.94 | 4.16 | 5.00 | 6.66 | 3.06 | 2.00 |
| Main Campus → Tarkwa Station | 3.2 | 12 | 24.06 | 6.69 | 8.00 | 10.71 | 4.74 | 3.20 |
| Main Campus → Market Circle | 3.6 | 14 | 27.18 | 7.56 | 8.00 | 12.10 | 1.62 | 3.20 |

**All four clear the floor at their current tariffs.** No price has to rise
today, which is the cheapest correct answer, and it is the answer the earlier
placeholders got wrong — 60 pesewas a minute put every one of them under water
and would have argued for a price rise the economics do not support.

The honest way to read that table is a day, not a trip: at six productive hours
and the planned load, the driver is left with roughly GH₵143 a day on the gate
run, GH₵69 on the hostel run, GH₵71 on the station run — and **GH₵21 on the
market run.**

### 8.1 What to do about the two off-campus runs

- **Main Gate → Lecture Area and Hostel Area → Main Campus: leave them alone.**
  Both clear the floor with room to spare and pay the driver a day's money.
- **Main Campus → Tarkwa Station: keep GH₵8.00, or lift it to GH₵9.00.** It
  clears the floor either way, but at GH₵8.00 the driver sees GH₵71 a day for
  fifty minutes of driving an hour. GH₵9.00 is inside the ceiling of GH₵10.71
  and takes the day to about GH₵125.
- **Main Campus → Market Circle is not a tariff problem, it is a fleet
  problem.** A six-seat shuttle selling four seats cannot beat a sixteen-seat
  trotro on a four-kilometre town run, and no tariff fixes that: recovering the
  cost at four seats means charging about GH₵12 for a trip a trotro does for a
  third of that. Set the corridor's **planned seats to 10** — the vehicle that
  actually suits the run — and the floor falls to **GH₵3.03**, while the ceiling
  caps the fare at **GH₵4.85**:

  | Market Circle | 6-seat shuttle, 4 seats | 14-seat bus, 10 seats |
  |---|---|---|
  | Fare | GH₵8.00 | GH₵4.85 (the ceiling) |
  | Driver per trip | GH₵1.62 | GH₵16.47 |
  | Driver per day | ≈ GH₵21 | ≈ GH₵212 |
  | Platform per trip | GH₵3.20 | GH₵4.85 |

  Everyone is better off and nobody subsidises anything. Note what the ceiling
  does there: at ten seats GH₵8.00 is *refused* for being above GH₵4.85, so a
  corridor cannot name a bigger vehicle and keep a small vehicle's price. The
  seat count is a real decision, not a way to unlock a higher fare.

So the order of the levers is: **run the right vehicle first, move the tariff
second, subsidise third** — and only a subsidy that someone signs their name to
may sit below the floor, which is exactly what the console records.

### 8.2 When a subsidy is the right answer

A below-floor tariff is a recurring cost with no natural end, so it should buy
something specific. The one thing worth buying here is the **guaranteed
departure**: publishing that a departure leaves on time whether or not it is
full. That is a service a timetable can be held to and a budget can be sized,
and it belongs on its own line rather than inside a tariff everyone quietly
loses on.

## 9. What is not decided here

- **The confirmed cost inputs.** The shipped figures are recommendations derived
  from a fuel price, a consumption and a daily driver cost that operations has
  not confirmed yet. Until it does, every floor is arithmetic on a good guess.
- **The corridor distances.** `distanceKm` is recorded per corridor and the
  seeded values are estimates. A floor is only as good as the kilometres it
  divides by, and a surveyed figure is worth more than a guessed one.
- **The guarantee behind the tariff.** Whether a departure leaves on time when
  half-full is a subsidy decision, and it changes what the floor has to recover.
- **Settlement.** The split is a fact on a row; paying it is still blocked by
  Paystack settling every collection to the bank, so `net_amount` is only
  payable once collection moves to subaccounts or auto-settlement is stopped.
  A driver's balance is arithmetic until then.
