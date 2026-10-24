# Python intelligence Worker

AI generation and aggregate hostel insights run in a **private Cloudflare Python
Worker**, deployed with the TypeScript application by `scripts/deploy-cloudflare.sh`.
The app and console Workers call it through the `INTELLIGENCE` service binding.
It needs no VPS, public API hostname, shared bearer secret, database credentials,
or separate deployment workflow.

Cloudflare runs Python Workers in Pyodide. The Worker uses FastAPI and Pydantic
for its internal API, and its `AI` binding calls Workers AI directly. The
`workers_dev` and preview routes are disabled in its Wrangler configuration.
Authentication, bookings, payments and the analytics ledger stay in the app
Worker. Only AI prompts, aggregate booking counts, and Cinema frame-quality
metrics reach Python; the video files and thumbnail images do not.

## Deploy

Install [uv](https://docs.astral.sh/uv/getting-started/installation/) on the
machine that runs deployments. Then use the existing deployment command from
the repository root. It deploys the Python Worker first, builds the app, binds
both app Workers to `INTELLIGENCE`, and deploys them. `CLOUDFLARE_KEY` in the
ignored `.env` file is used as the deployment token. Set
`CLOUDFLARE_INTELLIGENCE_WORKER_NAME` there only if this Cloudflare account
needs a different Worker name.

```bash
npm run deploy:cloudflare
```

For local Python development, run `uv run pywrangler dev` from
`services/intelligence`. The app continues to use its existing Workers AI
binding when no local `INTELLIGENCE` service binding is available. To connect
the two local Workers, set
`CLOUDFLARE_SERVICE_BINDINGS=INTELLIGENCE=umatexpress-intelligence` in the local
environment and run both dev servers.

The dashboard sends only fourteen daily paid-booking counts and current
bed-space totals. Python reports a seven-day comparison, not a forecast. If
the Python Worker is unavailable, the ledger dashboard and the app's own
Workers AI binding remain available.

# Cinema uploaded-video thumbnails

When a host uploads an MP4, MOV, or WebM file, the browser decodes three small
frames while the multipart transfer is running. The private Python Intelligence
Worker selects the clearest representative frame at
`POST /v1/cinema/thumbnail/select` using brightness and contrast scores. The
application Worker validates the selected JPEG, converts it to a 320 × 180 WebP
with Cloudflare Images, and stores it beside the video in private R2.

Thumbnails are served only to authenticated room members; the host alone can
create them. They appear in the room list, upload queue, playlist, and player
poster. Video upload remains usable if a browser cannot seek the file, the
Python service is unavailable, or image processing fails. In local development
without the Python service binding, the first decoded frame is selected.
Removing or expiring a video also removes its thumbnail.

## Cinema discussion question suggestions

The host or co-host can ask for similarly worded pending and approved
questions. The TypeScript route checks room membership and moderator role,
rate-limits requests, and sends at most 100 question IDs and texts to the
private `POST /v1/cinema/questions/groups` Python endpoint. Python uses a
bounded word-overlap algorithm and returns ID groups only. The app verifies
those IDs against the current authorized queue before display. Suggestions
never approve, merge, dismiss, or reorder questions.
