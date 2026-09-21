#!/usr/bin/env bash
# Push the Worker's runtime secrets from .env to the account the deploy targets.
#
# Moving UMaTeXPRESS to its own Cloudflare account is "deploy the same code with
# a new token, then re-add the secrets"; this script is the second half. Values
# never leave the machine and are never echoed: only key names are printed.
#
# Usage:
#   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... scripts/push-secrets.sh
#   scripts/push-secrets.sh --dry-run     # key names only, no API call
#
# With no environment overrides the token and account are read from .env
# (CLOUDFLARE_KEY / CLOUDFLARE_ACCOUNT_ID), matching deploy-cloudflare.sh.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$PROJECT_DIR/.env"
WORKER_NAME="${CLOUDFLARE_WORKER_NAME:-umatexpress}"
DRY_RUN="${1:-}"

# Every secret the Worker reads at runtime. CLOUDFLARE_API_TOKEN is absent from
# .env on purpose: the deploy token (CLOUDFLARE_KEY) is the same value the
# Worker expects under that name, and the script copies it across.
KEYS="ADMIN_EMAILS ADMIN_PASSWORD ADMIN_SESSION_SECRET AUTH_RECOVERY_SECRET CAMPUS_APP_URL CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_AI_MODEL CLOUDFLARE_AI_TOKEN CLOUDFLARE_TURN_KEY_ID CLOUDFLARE_TURN_API_TOKEN PAYMENT_PROVIDER PAYOUT_ENCRYPTION_KEY PAYSTACK_CURRENCY PAYSTACK_SECRET_KEY RESEND_API_KEY RESEND_FROM RESEND_REPLY_TO STUDENT_SESSION_SECRET TURSO_AUTH_TOKEN TURSO_DATABASE_URL YOUTUBE_API_KEY"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE: copy .env.example and fill it in first." >&2
  exit 1
fi

PAYLOAD="$(mktemp)"
trap 'rm -f "$PAYLOAD"' EXIT

node - "$ENV_FILE" "$KEYS" "$PAYLOAD" <<'NODE'
const fs = require("node:fs");
const [envFile, keysArg, payloadPath] = process.argv.slice(2);
const keys = keysArg.split(/\s+/).filter(Boolean);
const wanted = new Set([...keys, "CLOUDFLARE_KEY"]);
const values = {};
for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
  const match = /^([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (!match || !wanted.has(match[1])) continue;
  values[match[1]] = match[2].replace(/^["']|["']$/g, "").trim();
}
const payload = {};
const missing = [];
for (const key of keys) {
  const value = values[key];
  if (!value || value.startsWith("replace-with")) { missing.push(key); continue; }
  payload[key] = value;
}
if (!payload.CLOUDFLARE_API_TOKEN && values.CLOUDFLARE_KEY) payload.CLOUDFLARE_API_TOKEN = values.CLOUDFLARE_KEY;
const names = Object.keys(payload).sort();
if (!names.length) {
  console.error("No usable values found in .env; nothing to push.");
  process.exit(1);
}
fs.writeFileSync(payloadPath, JSON.stringify(payload));
console.log(`Prepared ${names.length} secrets: ${names.join(", ")}`);
if (missing.length) console.log(`Skipped (unset or placeholder): ${missing.join(", ")}`);
NODE

if [[ "$DRY_RUN" == "--dry-run" ]]; then
  echo "Dry run: nothing was pushed."
  exit 0
fi

from_env() {
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -1 | tr -d '"' | tr -d "'" | xargs || true
}

export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-$(from_env CLOUDFLARE_ACCOUNT_ID)}"
export CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN:-$(from_env CLOUDFLARE_KEY)}"
if [[ -z "$CLOUDFLARE_ACCOUNT_ID" || -z "$CLOUDFLARE_API_TOKEN" ]]; then
  echo "Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (or CLOUDFLARE_KEY in .env) before pushing." >&2
  exit 1
fi

npx wrangler secret bulk --name "$WORKER_NAME" "$PAYLOAD"
echo "Pushed to Worker '$WORKER_NAME'; verify with: npx wrangler secret list --name $WORKER_NAME"
