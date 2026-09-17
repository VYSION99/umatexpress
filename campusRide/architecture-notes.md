# campusRide architecture notes

## Separation from vacationRide

For now, keep `campusRide` as a separate module concept. Do not rename or disrupt the existing `vacationRide` tables and routes until the model is approved.

Possible future URL structure:

- `/` — client home for routing passengers into apps.
- `/vacation` — vacationRide landing/booking.
- `/campus` — campusRide passenger home.
- `/admin` — super-admin management home for routing into apps.
- `/admin/vacation` — vacationRide management.
- `/admin/campus` — campusRide route and shuttle control.

## Confirmed product model

campusRide is a paid live ride-matching and queue module.

- Students do not choose seats; they join queues.
- There can be many active rides on campus at once.
- Driver accounts are required.
- Ticket output should be image-based.
- Students search for the nearest ride, or the system matches them to the nearest compatible ride.
- Advanced map UI is required across student, driver, and admin experiences.
- AI help is required across student, driver, and admin experiences.

## Possible data model

Draft entities:

- `campus_zones`
  - id
  - name
  - description
  - landmark
  - latitude
  - longitude
  - active
  - created_at
  - updated_at

- `campus_route_corridors`
  - id
  - name
  - origin_zone_id
  - destination_zone_id
  - estimated_minutes
  - active

- `campus_fares`
  - id
  - corridor_id
  - amount
  - currency
  - active

- `campus_vehicles`
  - id
  - label
  - plate_number
  - capacity
  - vehicle_type
  - active

- `campus_drivers`
  - id
  - name
  - phone
  - email
  - password_hash
  - password_salt
  - password_iterations
  - vehicle_id
  - current_zone_id
  - active
  - last_seen_at
  - current_latitude
  - current_longitude

- `campus_rides`
  - id
  - driver_id
  - vehicle_id
  - corridor_id
  - current_zone_id
  - status
  - capacity
  - available_slots
  - accepting_queue
  - started_at
  - ended_at
  - current_latitude
  - current_longitude
  - last_location_at
  - created_at

- `campus_queue_entries`
  - id
  - reference
  - ride_id
  - corridor_id
  - passenger_name
  - email
  - phone
  - pickup_zone_id
  - destination_zone_id
  - queue_position
  - amount
  - payment_status
  - queue_status
  - ride_pin
  - accepted_at
  - arrived_at
  - boarded_at
  - completed_at
  - cancelled_at
  - created_at

## API route sketch

- `GET /api/campus/zones`
- `GET /api/campus/rides/nearest`
- `GET /api/campus/map`
- `POST /api/campus/queue/initialize`
- `GET /api/campus/queue/verify`
- `GET /api/campus/ticket`
- `POST /api/campus/ai`
- `POST /api/driver/auth`
- `PATCH /api/driver/location`
- `GET /api/driver/map`
- `GET /api/driver/queue`
- `PATCH /api/driver/queue`
- `GET /api/admin/campus/overview`
- `GET /api/admin/campus/map`
- `POST /api/admin/campus/ai`
- `POST /api/admin/campus/drivers`
- `POST /api/admin/campus/vehicles`
- `POST /api/admin/campus/zones`
- `POST /api/admin/campus/corridors`

## Reuse candidates

- Admin authorization
- Paystack payment helpers
- Turso connection
- Ticket/callback pattern
- AI passenger/admin helper pattern
- PWA installation/logo assets
- Map widgets should use an adapter layer so the map provider can change later.

## Things to avoid

- Do not overload `scheduled_trips` with campus shuttle data too early.
- Do not mix campusRide bookings into vacationRide dashboards without a module field or separate table.
- Do not tie all UI directly to one map vendor. Build a map adapter widget first.
