#!/usr/bin/env bash
set -euo pipefail

WORKER_NAME="${CLOUDFLARE_WORKER_NAME:-umatexpress}"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_IN="$PROJECT_DIR/dist/server/wrangler.json"
CONFIG_OUT="$PROJECT_DIR/dist/server/wrangler.deploy.json"
CONFIG_CONSOLE_OUT="$PROJECT_DIR/dist/server/wrangler.deploy.console.json"
CONSOLE_HOST="${CLOUDFLARE_CONSOLE_HOST:-}"
SKIP_BUILD=""
if [[ "${1:-}" == "--skip-build" ]]; then SKIP_BUILD=1; fi

# Reads one key from .env, distinguishing "unset" (use the default) from
# "present but empty" (the binding is deliberately disabled), which is exactly
# how the Vite binding plan reads the same file.
env_or_default() {
  local key="$1" fallback="$2" line
  line="$(grep -E "^${key}=" "$PROJECT_DIR/.env" 2>/dev/null | tail -1 || true)"
  if [[ -z "$line" ]]; then
    printf '%s' "$fallback"
    return
  fi
  printf '%s' "${line#*=}" | tr -d '"' | tr -d "'" | xargs || true
}

# The console lives on its own origin. Read it from .env when the shell has not
# exported it, so one file configures local runs and deploys alike.
if [[ -z "$CONSOLE_HOST" && -f "$PROJECT_DIR/.env" ]]; then
  CONSOLE_HOST="$(grep -E '^CLOUDFLARE_CONSOLE_HOST=' "$PROJECT_DIR/.env" | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" | xargs || true)"
fi

cd "$PROJECT_DIR"

# Bindings that name an account-side resource must exist before Wrangler can
# deploy a Worker that references them. Creating them here keeps the first
# deploy of a fresh account from failing halfway through, and re-running is a
# no-op.
R2_BINDING="$(env_or_default CLOUDFLARE_R2_BINDING PRIVATE_BUCKET)"
R2_BUCKET="$(env_or_default CLOUDFLARE_R2_BUCKET umatexpress-private)"
QUEUE_BINDING="$(env_or_default CLOUDFLARE_QUEUE_BINDING NOTIFICATION_QUEUE)"
QUEUE_NAME="$(env_or_default CLOUDFLARE_QUEUE umatexpress-notifications)"

# The console can be deployed as its own Worker, which is what gives it a
# hostname of its own (and an Access policy of its own) while the client stays
# public. Opt in with CLOUDFLARE_CONSOLE_WORKER_NAME plus the hostname that
# Worker will answer on; both are required together, because a console Worker
# without a boundary would serve the public client too.
CONSOLE_WORKER_NAME="${CLOUDFLARE_CONSOLE_WORKER_NAME:-$(env_or_default CLOUDFLARE_CONSOLE_WORKER_NAME "")}"
CONSOLE_HOSTS="${CLOUDFLARE_CONSOLE_HOSTS:-$(env_or_default CLOUDFLARE_CONSOLE_HOSTS "")}"
ROLE="single"
if [[ -n "$CONSOLE_WORKER_NAME" ]]; then
  if [[ -z "$CONSOLE_HOSTS" ]]; then
    echo "CLOUDFLARE_CONSOLE_WORKER_NAME is set, so CLOUDFLARE_CONSOLE_HOSTS must name the console hostname (e.g. ${CONSOLE_WORKER_NAME}.<account-subdomain>.workers.dev)." >&2
    exit 1
  fi
  ROLE="client"
fi

ensure_r2_bucket() {
  local bucket="$1" output
  if output="$(wrangler r2 bucket create "$bucket" 2>&1)"; then
    echo "Created R2 bucket '$bucket'."
  elif grep -qiE "already exists|already owned|code: 10004" <<<"$output"; then
    echo "R2 bucket '$bucket' already exists."
  else
    echo "$output" >&2
    echo "Could not create the R2 bucket '$bucket'. Create it in the Cloudflare dashboard or unset CLOUDFLARE_R2_BUCKET to deploy without it." >&2
    return 1
  fi
}

ensure_queue() {
  local queue="$1" output
  if output="$(wrangler queues create "$queue" 2>&1)"; then
    echo "Created queue '$queue'."
  # Cloudflare answers an existing queue with "already taken" (code 11009),
  # which is not the wording it uses for buckets, so match both.
  elif grep -qiE "already exists|already taken|code: 11009" <<<"$output"; then
    echo "Queue '$queue' already exists."
  else
    echo "$output" >&2
    echo "Could not create the queue '$queue'. Create it in the Cloudflare dashboard or unset CLOUDFLARE_QUEUE to deploy without it." >&2
    return 1
  fi
}

# The safety net under Cinema's own deletion: `cinema/` objects expire after two
# days even if the cleanup job never runs, and an upload that was abandoned
# mid-flight has its parts aborted after one. Both are idempotent; an existing
# rule with the same name is left as it is.
ensure_r2_lifecycle() {
  local bucket="$1" output
  if output="$(wrangler r2 bucket lifecycle add "$bucket" cinema-temporary cinema/ --expire-days 2 --abort-multipart-days 1 --force 2>&1)"; then
    echo "Applied the Cinema lifecycle rule to R2 bucket '$bucket'."
  elif grep -qiE "already exists|already has|duplicate" <<<"$output"; then
    echo "R2 bucket '$bucket' already carries the Cinema lifecycle rule."
  else
    echo "$output" >&2
    echo "Could not apply the Cinema lifecycle rule to '$bucket'. Add it in the Cloudflare dashboard: prefix cinema/, expire objects after 2 days, abort incomplete multipart uploads after 1 day." >&2
    return 1
  fi
}

if [[ -n "$R2_BINDING" && -n "$R2_BUCKET" ]]; then
  ensure_r2_bucket "$R2_BUCKET"
  ensure_r2_lifecycle "$R2_BUCKET"
fi

if [[ -n "$QUEUE_BINDING" && -n "$QUEUE_NAME" ]]; then
  ensure_queue "$QUEUE_NAME"
  ensure_queue "${QUEUE_NAME}-dlq"
fi

if [[ -n "$SKIP_BUILD" ]]; then
  echo "Skipping the build (--skip-build): deploying the existing dist."
else
  npm run build
fi

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

# The console Worker goes first, so the console hostname is live before the
# client Worker starts refusing console paths.
if [[ -n "$CONSOLE_WORKER_NAME" ]]; then
  echo "==> console Worker: $CONSOLE_WORKER_NAME on $CONSOLE_HOSTS"
  node "$PROJECT_DIR/scripts/write-deploy-config.mjs" "$CONFIG_IN" "$CONFIG_CONSOLE_OUT" "$CONSOLE_WORKER_NAME" "$CONSOLE_HOST" console "$CONSOLE_HOSTS"
  wrangler deploy --config "$CONFIG_CONSOLE_OUT"
  echo "Remember: push the runtime secrets to the console Worker too."
  echo "  CLOUDFLARE_WORKER_NAME=$CONSOLE_WORKER_NAME scripts/push-secrets.sh"
fi

if [[ -z "$CONSOLE_HOST" ]]; then
  echo "CLOUDFLARE_CONSOLE_HOST is not set: deploying without the console custom domain."
  echo "The console then only answers on the workers.dev host listed in CONSOLE_HOSTS."
fi

echo "==> client Worker: $WORKER_NAME"
node "$PROJECT_DIR/scripts/write-deploy-config.mjs" "$CONFIG_IN" "$CONFIG_OUT" "$WORKER_NAME" "$CONSOLE_HOST" "$ROLE" "$CONSOLE_HOSTS"
wrangler deploy --config "$CONFIG_OUT"
