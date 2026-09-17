# campusRide feature brief

## Goal

Create a module for everyday campus transportation that can coexist with the current `vacationRide` system.

## Early assumptions

- `vacationRide` is for longer scheduled trips like UMaT → Accra.
- `campusRide` is for shorter recurring routes around or near campus.
- Admin should be able to control routes, stops, active vehicles, schedules, fare rules, and availability.
- Passenger flow should be faster than vacationRide because campus trips may happen repeatedly during the day.

## Core questions to answer

1. Are campusRide trips paid, free, or mixed?
2. Do passengers reserve seats, or only view live shuttle availability?
3. Should schedules repeat daily/weekly, or should admin create each trip manually?
4. Are routes fixed, flexible, or both?
5. Do we need driver accounts now, or only admin control first?
6. Should campusRide have a separate URL like `/campus` or be selected from the home page?
7. Should tickets be required, or is a boarding code enough?

## Candidate passenger features

- View active campus routes.
- Pick origin and destination stops.
- See next shuttle/departure.
- Reserve a seat or join a queue.
- Pay fare if required.
- Receive ticket/boarding code.
- Get route instructions and driver/contact info.

## Candidate admin features

- Create and edit routes.
- Add stops to each route.
- Set recurring schedules.
- Add vehicles and capacity.
- Enable/disable route visibility.
- View bookings/riders by route/date.
- Pause a route due to breakdown, weather, or traffic.
- Broadcast announcements to riders.

## First MVP idea

Start with:

- Routes
- Stops
- Daily schedules
- Vehicle capacity
- Optional fare
- Passenger reservation
- Admin route/schedule control

Then add driver views, live tracking, wallet, subscriptions, or QR scanning later.
