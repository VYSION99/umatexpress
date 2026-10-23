# Production domain routing and protections

The client Worker serves `umatexpress.com`; `www.umatexpress.com` redirects to
its HTTPS origin with status 308, preserving the path and query string. The
console Worker serves `console.umatexpress.com`; its root opens `/console`.
Console-native pages and APIs return 404 on the public host.

`.env` configures `CLOUDFLARE_CLIENT_HOST`, `CLOUDFLARE_CLIENT_ALIASES`,
`CLOUDFLARE_CONSOLE_HOST`, and `CLOUDFLARE_CONSOLE_HOSTS`. The deployment writer
records the custom domains and disables workers.dev and preview URLs whenever
a production domain is configured. Runtime variables managed outside the build
are retained with `keep_vars`; explicit config variables still take precedence.

The Cloudflare zone has Always Use HTTPS enabled and minimum TLS 1.2. These
are account-side settings, independent of a Worker deployment.

Worker responses, including console redirects, boundary 404s, and image
responses, receive the existing security headers. WebSocket upgrade responses
retain their original socket. Static assets pass through the Worker first so that hostname redirects and
security headers apply consistently to assets and app routes. This incurs
a Worker invocation for asset requests.

Cloudflare Access and WAF policy changes require a separate audience and rules
review. Payment webhook traffic must remain compatible with server-to-server
requests. The existing application authentication and rate limits remain active.

Validation: `npm run build`, `npm run typecheck`, and
`node --test tests/deploy-config.test.mjs tests/console-host.test.mjs tests/console-render.test.mjs`.
