# campusRide analysis workspace

This folder is for planning the next module before we touch the live `vacationRide` booking flow.

`campusRide` should handle regular campus movement, short-distance trips, shuttle schedules, commuter-style routes, and repeated daily operations. Keep notes, diagrams, SQL drafts, API sketches, and UI ideas here until the design is clear enough to implement.

## Current status

- Created: 2026-08-28
- Phase: analysis
- Production code impact: none yet
- Existing live module: `vacationRide`

## Suggested analysis order

1. Define the actual campusRide use cases.
2. Decide whether campusRide shares the same passenger/admin UI or gets its own pages.
3. Design route, stop, vehicle, timetable, seat/capacity, and pricing models.
4. Decide payment rules: free shuttle, cash, Paystack, MoMo, or wallet later.
5. Draft SQL tables and API routes.
6. Review how campusRide should coexist with vacationRide.

## Folder map

- `feature-brief.md` — product scope and questions.
- `architecture-notes.md` — system design draft.
- `implementation-checklist.md` — execution phases once approved.
