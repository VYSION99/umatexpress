# campusRide implementation checklist

## Phase 1 — Discovery

- [x] Confirm paid/free/mixed fare model: paid.
- [x] Confirm seat reservation vs queue/availability: queue.
- [ ] List campus routes and stops.
- [x] Confirm whether admin-only control is enough for MVP: no, driver portal is required.
- [x] Confirm if driver interface is required now.
- [x] Confirm ticket format: image ticket.
- [x] Confirm matching model: nearest compatible ride.
- [x] Confirm UI approach: reusable widgets.
- [x] Confirm map requirement: advanced map experience.
- [x] Confirm AI requirement: help across student, driver, and admin areas.

## Phase 2 — Data design

- [ ] Finalize SQL tables.
- [ ] Decide shared vs separate booking/payment tables.
- [x] Add migration file.
- [ ] Add latitude/longitude fields for zones and rides.
- [ ] Add driver last-seen/current-location fields.
- [ ] Add AI context fields where needed.
- [x] Add API engine indexes.
- [x] Add tests for engine state transitions, pricing, and matching.
- [x] Add tests for queue request/payment handoff preview.
- [ ] Add tests for queue payment safety and capacity safety.

## Phase 2.5 — API engine

- [x] Create `lib/campus-engine/`.
- [x] Add typed response helpers.
- [x] Add structured engine errors.
- [x] Add ride state machine.
- [x] Add pricing engine foundation.
- [x] Add matching engine service wrapper.
- [x] Add audit helper.
- [x] Add super-admin API service wrapper.
- [x] Add student ride request service foundation.
- [x] Add versioned `/api/v1/campus/...` routes.

## Phase 3 — UI widgets

- [x] Create `components/campusRide/`.
- [x] Add shared layout widgets.
- [x] Add map widgets.
- [x] Add AI assistant widgets.
- [x] Add student widgets.
- [x] Add driver widgets.
- [x] Add admin widgets.
- [ ] Keep business logic outside widgets.

## Phase 4 — APIs

- [x] Add zone management API.
- [x] Add corridor/fare API.
- [x] Add nearest ride API.
- [x] Add location/update API.
- [ ] Add map data API.
- [x] Add campusRide AI helper API.
- [x] Add queue initialize/verify API.
- [x] Add campusRide payment API foundation.
- [x] Add driver auth APIs.
- [x] Add driver ride operation APIs.
- [ ] Add driver queue APIs.

## Phase 5 — Admin UI

- [x] Add `/admin/campus`.
- [x] Add zone manager widget.
- [x] Add corridor/fare manager widget.
- [x] Add vehicle manager widget.
- [x] Add driver manager widget.
- [x] Add live ride monitor widget.
- [ ] Add admin campus map widget.
- [ ] Add admin AI panel widget.
- [ ] Add queue table widget.
- [ ] Add announcements.

## Phase 6 — Driver UI

- [x] Add `/driver/login`.
- [x] Add `/driver`.
- [x] Add current zone updater.
- [x] Add driver map widget.
- [x] Add driver AI assistant widget.
- [x] Add active ride control.
- [ ] Add driver queue list.
- [ ] Add passenger queue item actions.

## Phase 7 — Passenger UI

- [x] Add `/campus`.
- [x] Add nearest ride finder widget.
- [x] Add student map widget.
- [x] Add student AI help widget.
- [x] Add pickup/destination zone picker.
- [x] Add matched ride cards.
- [x] Add queue/payment flow.
- [x] Add image ticket flow foundation.

## Phase 8 — Advanced map and AI

- [ ] Add map provider adapter.
- [ ] Add live ride markers.
- [ ] Add pickup/drop-off zone markers.
- [ ] Add route corridor lines.
- [ ] Add driver last-seen indicators.
- [ ] Add AI context builder.
- [ ] Add contextual AI responses for student, driver, and admin.

## Phase 9 — Integration

- [x] Add one super-admin homepage for routing into management apps.
- [x] Move vacationRide management to `/admin/vacation`.
- [x] Protect campusRide management behind the same admin gate.
- [x] Add module navigation between vacationRide and campusRide.
- [ ] Keep analytics/bookings separated by module.
- [ ] Test deployment on Cloudflare Workers.
- [ ] Configure any required new secrets.
