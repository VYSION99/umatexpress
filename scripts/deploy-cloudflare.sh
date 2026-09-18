#!/usr/bin/env bash
set -euo pipefail

WORKER_NAME="${CLOUDFLARE_WORKER_NAME:-umatexpress}"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_IN="$PROJECT_DIR/dist/server/wrangler.json"
CONFIG_OUT="$PROJECT_DIR/dist/server/wrangler.deploy.json"
CONSOLE_HOST="${CLOUDFLARE_CONSOLE_HOST:-}"

# The console lives on its own origin. Read it from .env when the shell has not
# exported it, so one file configures local runs and deploys alike.
if [[ -z "$CONSOLE_HOST" && -f "$PROJECT_DIR/.env" ]]; then
  CONSOLE_HOST="$(grep -E '^CLOUDFLARE_CONSOLE_HOST=' "$PROJECT_DIR/.env" | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" | xargs || true)"
fi

cd "$PROJECT_DIR"
npm run build

if [[ ! -f "$CONFIG_IN" ]]; then
  echo "Missing Vinext Cloudflare config: $CONFIG_IN" >&2
  echo "Run npm run build and confirm dist/server/wrangler.json is generated." >&2
  exit 1
fi

if [[ ! -f "$PROJECT_DIR/dist/server/index.js" ]]; then
  echo "Missing Worker entry: $PROJECT_DIR/dist/server/index.js" >&2
  echo "Vinext build completed without the expected server entry point." >&2
  exit 1
fi

if [[ ! -d "$PROJECT_DIR/dist/client" ]]; then
  echo "Missing client assets directory: $PROJECT_DIR/dist/client" >&2
  exit 1
fi

node - "$CONFIG_IN" "$CONFIG_OUT" "$WORKER_NAME" "$CONSOLE_HOST" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [input, output, name, consoleHost] = process.argv.slice(2);
const serverDir = path.dirname(input);
const projectDir = path.dirname(path.dirname(serverDir));
const config = JSON.parse(fs.readFileSync(input, "utf8"));
config.name = name;
config.topLevelName = name;
config.main = path.join(serverDir, "index.js");
config.assets = { directory: path.join(projectDir, "dist/client") };
// A redeploy must never drop the console domain, so the route is written into
// the generated config instead of being added once in the dashboard.
if (consoleHost) {
  config.routes = [{ pattern: `${consoleHost.replace(/^https?:\/\//, "").replace(/\/.*$/, "")}/*`, custom_domain: true }];
} else {
  console.log("CLOUDFLARE_CONSOLE_HOST is not set: deploying without the console custom domain.");
  console.log("The console then only answers on the workers.dev host listed in CONSOLE_HOSTS.");
}
fs.writeFileSync(output, JSON.stringify(config, null, 2));
NODE

wrangler deploy --config "$CONFIG_OUT"
