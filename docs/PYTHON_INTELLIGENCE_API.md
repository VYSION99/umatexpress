# Python intelligence API

The application keeps authentication, bookings, payment data and the analytics
ledger in its existing Cloudflare Worker. An optional FastAPI service handles
AI generation and computes derived analytics from aggregate counts. Browsers
never call it directly, and the Python service has no Turso credentials.

## Run locally

From the repository root, install `services/intelligence/requirements.txt` in
a Python 3.12+ virtual environment, then set a random secret of at least 32
characters and start the service:

```bash
export INTELLIGENCE_API_SECRET='your-unique-32-plus-character-random-secret'
export CLOUDFLARE_ACCOUNT_ID='your-account-id'
export CLOUDFLARE_AI_TOKEN='your-workers-ai-token'
uvicorn services.intelligence.main:app --host 127.0.0.1 --port 8000
```

Set `INTELLIGENCE_API_URL=http://127.0.0.1:8000/` and the same
`INTELLIGENCE_API_SECRET` on the app server. The AI token is needed only if
Python will generate AI responses; analytics needs only the shared secret.
`/health` is unauthenticated. Both `/v1/ai/generate` and
`/v1/analytics/hostels/insights` require `Authorization: Bearer <secret>`.

## Production

Build the included image from the repository root with
`docker build -f services/intelligence/Dockerfile .`. Host it separately from
the Cloudflare Worker behind HTTPS. Configure `INTELLIGENCE_API_SECRET`,
`CLOUDFLARE_ACCOUNT_ID`, and `CLOUDFLARE_AI_TOKEN` as secrets on that host.
Set `INTELLIGENCE_API_URL` and the same shared secret on the Worker, then run
`scripts/push-secrets.sh` as part of the usual deployment. Restrict ingress to
the app where your host supports it; the bearer secret remains mandatory.
Never use a public browser variable for the URL or secret.

The admin hostel dashboard sends only 14 daily paid-booking counts and total
bed-space counts. The Python calculation is a seven-day comparison, clearly
labelled as such; it does not predict future bookings. If the service times
out, the normal ledger dashboard still loads. Existing Workers AI remains the
fallback for AI requests. Enabling this service is optional and does not
require a database migration.
