# Hostel Finder discovery and checkout

The browse page keeps search, academic year, filters, sorting and page number in
its URL. Applying filters uses client navigation, with a native GET fallback.
Mobile filters collapse above the results. The List/Map control does not mount
MapLibre until selected; property-detail maps wait until near the viewport.

## Reads and response sizes

- Single-property reads constrain the aggregate by property ID.
- Metadata and detail rendering share a request-scoped React cache keyed by ID
  and requested academic year. No cross-request availability cache is used here.
- Search, utilities, minimum beds and maximum total price are pushed into SQL.
- Distance calculation/filtering and final sorting operate on summary rows in
  memory. This preserves the existing declared-distance/haversine behavior.
- Pages default to 12 cards and are capped at 48. Photo and rating enrichment
  happens after pagination. Map summaries are capped at 60 and labeled as such.
- Reviews are supplied with the server-rendered detail page, avoiding the second
  browser request. Public props and review responses omit account/moderation data.
- The public browse API caches availability snapshots for 15 seconds without a
  stale-while-revalidate window. Checkout always rechecks availability.

This bounds presentation/enrichment work, not the number of summary rows the
aggregate reads. For a much larger catalogue, persist an indexed effective
campus distance and move final ordering/pagination fully into SQL. No live
latency or transfer-size improvement has been claimed without measurement.

## Booking safety

The conditional AVAILABLE-to-RESERVED update and conditional booking insert run
in one `BEGIN IMMEDIATE` transaction. An insert error skips COMMIT and rolls
back the reservation. A lost claim inserts no booking. Payment initialization
runs after commit. See `tests/turso-transaction.test.mjs` for tests executing the
transaction SQL against SQLite, and the residency test for insert failure before
checkout. The protocol follows the
[Hrana batch specification](https://github.com/tursodatabase/libsql/blob/main/docs/HRANA_1_SPEC.md#execute-a-batch).

## Photos

Cards and the interactive gallery request fixed widths: 160, 320, 640, 960 and
1440 pixels. The existing IMAGES binding produces WebP at quality 80; a missing
or failed transformer falls back to a freshly read original stream.

Approval is checked before looking up cached bytes. Internal edge entries are
keyed by photo ID, width and approval revision. Browser/CDN responses are private
and require revalidation, so a rejected photo cannot bypass moderation through
the public URL. This uses the existing
[Cloudflare Images binding](https://developers.cloudflare.com/images/optimization/binding/).

Regression coverage includes academic-year links, direct lookups, pagination,
booking rollback, resized-image caching, moderation after caching, transform
fallback and public-review field filtering. Live device layout and production
latency still require a connected browser and representative data.
