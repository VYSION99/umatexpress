#!/usr/bin/env bash
set -euo pipefail

WORKER_NAME="${CLOUDFLARE_WORKER_NAME:-umatexpress}"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_IN="$PROJECT_DIR/dist/server/wrangler.json"
CONFIG_OUT="$PROJECT_DIR/dist/server/wrangler.deploy.json"

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

node - "$CONFIG_IN" "$CONFIG_OUT" "$WORKER_NAME" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [input, output, name] = process.argv.slice(2);
const serverDir = path.dirname(input);
const projectDir = path.dirname(path.dirname(serverDir));
const config = JSON.parse(fs.readFileSync(input, "utf8"));
config.name = name;
config.topLevelName = name;
config.main = path.join(serverDir, "index.js");
config.assets = { directory: path.join(projectDir, "dist/client") };
fs.writeFileSync(output, JSON.stringify(config, null, 2));
NODE

wrangler deploy --config "$CONFIG_OUT"
