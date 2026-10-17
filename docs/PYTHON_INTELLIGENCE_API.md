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
Worker. Only AI prompts and aggregate booking counts reach Python.

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
