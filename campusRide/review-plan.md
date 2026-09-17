# campusRide review plan

## Direction

`campusRide` is a paid live campus ride-matching module.

It should work differently from `vacationRide`:

- `vacationRide`: fixed long-distance scheduled trips.
- `campusRide`: many short rides around campus, matched when a student is ready.

The main student action is:

> Find the nearest available ride and join the queue.

## Confirmed decisions

1. campusRide is paid.
2. Students join a queue instead of selecting seats.
3. There will be many rides on campus.
4. Driver accounts are required.
5. Tickets should be generated in image format.
6. Students should search for the nearest ride, or the system should hook them up automatically.
7. All UI should use reusable widgets.
8. campusRide should include an advanced map experience.
9. AI help should be available across student, driver, and admin areas.

## Open decision

The first routes/zones are not confirmed yet.

Recommended starting seed zones:

- UMaT Main Gate
- Main Campus
- Lecture Area
- Hostel Area
- Tarkwa Station
- Market Circle

Admin can edit these later.

## MVP passenger flow

1. Student opens `/campus`.
2. Student selects pickup zone or allows location access.
3. Student selects destination zone.
4. System finds nearest active ride.
5. Student joins the ride queue.
6. Student pays with Paystack.
7. Student receives an image ticket.
8. Driver sees the paid passenger in the queue.
9. Driver marks passenger as boarded/completed/no-show.

## MVP driver flow

1. Driver logs in at `/driver/login`.
2. Driver opens `/driver`.
3. Driver sets current zone and destination/direction.
4. Driver opens a ride for queue requests.
5. Driver accepts paid passengers until vehicle is full.
6. Driver starts ride.
7. Driver marks passengers boarded/completed/no-show.
8. Driver closes ride.

## MVP admin flow

1. Super admin logs in once through `/admin/login`.
2. Super admin lands on `/admin`.
3. Super admin chooses the management app.
4. For vacationRide, open `/admin/vacation`.
5. For campusRide, open `/admin/campus`.
6. In campusRide, admin creates pickup/drop-off zones.
7. Admin creates route corridors between zones.
8. Admin sets fares.
9. Admin registers vehicles and driver accounts.
10. Admin monitors live rides and queues.
11. Admin pauses zones, rides, drivers, or vehicles.
12. Admin reviews audit logs.

## Matching model

### Phase A — Zone matching

This is the recommended MVP.

The system matches students by:

1. Pickup zone.
2. Destination zone or compatible route corridor.
3. Ride has available queue capacity.
4. Ride is active and accepting passengers.
5. Driver has updated location recently.

### Phase B — Nearby zone suggestions

If there is no exact match:

> No ride at Lecture Area right now. Nearest ride is at Main Gate.

### Phase C — GPS matching

Later, if students and drivers allow location access, the system can match by latitude/longitude distance.

GPS should be designed from the beginning, but shipped safely in stages:

1. Start with zone-based matching.
2. Add optional browser location for students.
3. Add driver current location updates.
4. Add distance scoring.
5. Add full map visualization.

## Advanced map plan

The map should become the visual center of campusRide.

### Student map

The student map should show:

- Student current location, when permission is granted.
- Nearby pickup zones.
- Available rides near the student.
- Driver/vehicle marker for matched rides.
- Destination zone.
- Estimated walking direction to pickup zone.
- Ride status after joining queue.

Main widgets:

- `CampusMap`
- `StudentLocationButton`
- `PickupZoneMapPicker`
- `DestinationZoneMapPicker`
- `NearbyRideMarkers`
- `MatchedRideDrawer`

### Driver map

The driver map should show:

- Driver current location.
- Current zone.
- Assigned route corridor.
- Waiting passengers near pickup zones.
- Destination direction.
- Ride capacity and queue pressure.

Main widgets:

- `DriverMap`
- `DriverLocationTracker`
- `DriverZoneMarker`
- `QueueHeatMarkers`
- `DriverRouteOverlay`

### Admin map

The admin map should show:

- All active rides.
- Driver last-seen status.
- Busy pickup zones.
- Queue counts by zone.
- Paused/unavailable zones.
- Route corridor lines.
- Demand heatmap later.

Main widgets:

- `AdminCampusMap`
- `LiveRideLayer`
- `ZoneDemandLayer`
- `RouteCorridorLayer`
- `DriverStatusLayer`
- `MapFilterPanel`

### Map provider approach

Recommended MVP approach:

- Build the map as an adapter widget so the provider can change later.
- Keep all map logic behind `components/campusRide/map/`.
- Keep location and distance logic in `lib/campus-location.ts`.
- Store zone latitude/longitude even if GPS is optional at first.

Possible provider path:

1. Start with browser geolocation plus simple coordinate display/list matching if map provider is not ready.
2. Add a map provider layer.
3. Add route lines and live markers.
4. Add heatmaps/analytics.

The UI should not depend directly on one map vendor everywhere. Use a wrapper widget so we can switch providers without rewriting all pages.

## Queue model

Students do not select seat numbers.

Queue statuses:

- `WAITING_PAYMENT`
- `PAID_WAITING`
- `ACCEPTED_BY_DRIVER`
- `BOARDED`
- `COMPLETED`
- `CANCELLED`
- `NO_SHOW`

## Ticket image

The image ticket should show:

- campusRide branding
- Ticket reference
- Passenger name
- Phone
- Pickup zone
- Destination zone
- Driver name, if assigned
- Vehicle label/plate, if assigned
- Queue position
- Amount paid
- Payment status
- Verification code or QR placeholder
- Created time

## Payment model

campusRide is paid.

Recommended MVP:

- Admin sets fare per route corridor.
- Paystack initializes payment when the student joins queue.
- Paystack charge can be added to passenger total, same as vacationRide.
- Passenger appears in driver queue only after successful payment.

Later:

- Peak pricing
- Distance-based fare
- Student wallet
- Subscriptions
- Promo codes

## Driver accounts

Driver fields:

- Name
- Phone
- Email or username
- Password/PIN
- Assigned vehicle
- Current zone
- Active status
- Last seen time

Driver permissions:

- View own ride.
- Update current zone.
- Open/close ride.
- See paid queue passengers.
- Mark passengers boarded/completed/no-show.

Admin permissions:

- Create/disable driver.
- Reset driver password/PIN.
- Assign vehicle.
- Override ride status.
- View all rides and queues.

## Proposed tables

- `campus_zones`
- `campus_route_corridors`
- `campus_fares`
- `campus_vehicles`
- `campus_drivers`
- `campus_driver_sessions`
- `campus_rides`
- `campus_queue_entries`
- `campus_payments`
- `campus_ticket_events`
- `campus_announcements`
- `campus_audit_logs`

## Proposed API routes

Passenger:

- `GET /api/campus/zones`
- `GET /api/campus/rides/nearest`
- `POST /api/campus/queue/initialize`
- `GET /api/campus/queue/verify`
- `GET /api/campus/ticket`

Driver:

- `POST /api/driver/auth`
- `DELETE /api/driver/auth`
- `GET /api/driver/me`
- `PATCH /api/driver/location`
- `POST /api/driver/rides`
- `PATCH /api/driver/rides`
- `GET /api/driver/queue`
- `PATCH /api/driver/queue`

Admin:

- `GET /api/admin/campus/overview`
- `POST /api/admin/campus/zones`
- `PATCH /api/admin/campus/zones`
- `POST /api/admin/campus/corridors`
- `PATCH /api/admin/campus/corridors`
- `POST /api/admin/campus/fares`
- `PATCH /api/admin/campus/fares`
- `POST /api/admin/campus/drivers`
- `PATCH /api/admin/campus/drivers`
- `POST /api/admin/campus/vehicles`
- `PATCH /api/admin/campus/vehicles`
- `GET /api/admin/campus/rides`
- `PATCH /api/admin/campus/rides`
- `GET /api/admin/campus/audit-logs`

## Proposed pages

- `/campus` — student nearest-ride finder.
- `/campus/ticket` — image ticket view/download.
- `/driver/login` — driver login.
- `/driver` — driver ride and queue dashboard.
- `/admin` — super-admin management home.
- `/admin/vacation` — vacationRide management.
- `/admin/campus` — admin campusRide control center.

## Widget-first UI plan

All campusRide screens should be built from reusable widgets.

This keeps the student, driver, and admin experiences visually connected and makes later changes much faster.

### Shared layout widgets

- `CampusShell` — page frame for campusRide pages.
- `CampusHeader` — logo, module label, quick actions.
- `CampusModuleTabs` — switch between vacationRide and campusRide where needed.
- `CampusStatusBanner` — service notices, route pauses, payment notices.
- `CampusEmptyState` — friendly empty screen when no ride/zone/queue exists.
- `CampusActionBar` — sticky mobile action buttons.

### Student widgets

- `NearestRideFinder` — pickup/destination inputs plus location permission action.
- `ZonePicker` — reusable pickup/drop-off selector.
- `CampusMap` — shared map base for campusRide.
- `StudentLocationButton` — asks for browser location and explains privacy.
- `PickupZoneMapPicker` — choose pickup from map.
- `NearbyRideMarkers` — show matched/nearby rides.
- `RideMatchCard` — shows matched ride, distance/zone, driver, vehicle, fare, queue size.
- `QueueJoinCard` — passenger details and payment start.
- `QueuePositionCard` — shows position and current ride status.
- `CampusTicketImage` — image ticket/boarding pass.
- `PassengerHelpWidget` — AI or static travel help.

### Driver widgets

- `DriverLoginCard` — driver sign-in form.
- `DriverStatusCard` — active/inactive, current zone, vehicle.
- `DriverZoneUpdater` — update current pickup zone.
- `DriverMap` — driver location, route, and pickup demand.
- `DriverLocationTracker` — updates driver last-seen/current coordinates.
- `ActiveRideControl` — open/start/pause/end ride.
- `DriverQueueList` — paid passengers waiting for boarding.
- `PassengerQueueItem` — accept, boarded, completed, no-show.
- `VehicleCapacityMeter` — used/available capacity.

### Admin widgets

- `CampusOverviewMetrics` — live rides, queues, paid riders, revenue.
- `ZoneManagerWidget` — create/edit/pause zones.
- `CorridorManagerWidget` — connect pickup/destination zones.
- `FareManagerWidget` — set route corridor pricing.
- `VehicleManagerWidget` — vehicle records and capacity.
- `DriverManagerWidget` — driver accounts, reset password/PIN, assigned vehicle.
- `LiveRideMonitorWidget` — all active rides.
- `AdminCampusMap` — live ride and demand map.
- `MapFilterPanel` — filter by route, driver, zone, status.
- `CampusQueueTableWidget` — passengers by ride/status.
- `CampusAnnouncementWidget` — broadcast notices.
- `CampusAuditLogWidget` — logged admin/driver actions.

### AI help widgets

AI should be available in every campusRide area, but with different responsibilities.

Student AI:

- Explain pickup instructions.
- Recommend nearest pickup zone.
- Explain queue/payment/ticket status.
- Help when no ride is nearby.
- Summarize driver/vehicle instructions.

Driver AI:

- Summarize current queue pressure.
- Suggest which zone to move toward.
- Draft passenger delay messages.
- Explain route/boarding tasks.
- Highlight possible no-show/capacity issues.

Admin AI:

- Suggest fare/route improvements.
- Summarize campus demand.
- Draft public announcements.
- Detect operational risks.
- Recommend where to assign more drivers.

Main widgets:

- `CampusAiAssistant`
- `StudentRideHelpWidget`
- `DriverOpsAssistantWidget`
- `AdminCampusAiPanel`
- `AiSuggestionCards`

AI should always use current context from the page: selected zone, destination, active ride, queue state, driver status, or admin filters.

### Widget implementation rule

Each widget should own only its UI and small client-side state.

Business logic should stay in:

- `lib/campus-ride.ts`
- `lib/campus-matching.ts`
- `lib/campus-location.ts`
- `lib/campus-ai.ts`
- `lib/driver-auth.ts`
- API route handlers

This avoids burying matching, payment, and queue logic inside React components.

## Implementation phases

### Phase 1 — Schema and helpers

- Create campusRide SQL migration.
- Add campusRide TypeScript helpers.
- Seed demo zones and corridors.
- Keep vacationRide tables untouched.
- Create the shared campusRide widget folder.
- Add map/location helper structure.
- Add AI helper structure.

### Phase 2 — Admin setup

- Build `/admin/campus`.
- Route admins through `/admin` super-admin home.
- Manage zones.
- Manage corridors and fares.
- Manage vehicles.
- Manage drivers.
- Use admin widgets instead of one large admin page component.

### Phase 3 — Driver portal

- Build driver auth.
- Build `/driver` dashboard.
- Let drivers update current zone.
- Add driver location/map widgets.
- Let drivers open/close rides.
- Let drivers manage queue statuses.
- Build driver screens from driver widgets.

### Phase 4 — Student matching

- Build `/campus`.
- Add pickup/destination selectors.
- Add map-based pickup/destination experience.
- Find nearest compatible ride.
- Join queue.
- Build passenger screens from student widgets.

### Phase 5 — Payment and ticket

- Add Paystack payment for campusRide.
- Verify payment.
- Add webhook support.
- Generate image ticket.

### Phase 6 — Operations hardening

- Add queue expiry.
- Add no-show handling.
- Add audit logs.
- Add duplicate payment protection.
- Add capacity protection.

### Phase 7 — Smarter matching

- Add nearby-zone fallback.
- Add driver last-seen timeout.
- Add optional GPS.
- Add demand analytics.

### Phase 8 — Advanced map and AI

- Add live ride map layers.
- Add driver map tracking.
- Add admin demand map.
- Add AI help in student flow.
- Add AI help in driver flow.
- Add AI help in admin flow.

## Recommended first build

Build in this order:

1. SQL tables.
2. Admin zones/corridors/fares/drivers/vehicles.
3. Super-admin app routing.
4. Driver login and active ride dashboard.
5. Student nearest ride search.
6. Basic map/location widgets.
7. Queue payment.
8. Image ticket.
8. AI help widgets.
9. Advanced map layers.
10. Audit logs and hardening.

## Not for MVP

- Wallets/subscriptions
- QR scanner app
- Complex fare zones
- Student ID verification
- Push notifications
