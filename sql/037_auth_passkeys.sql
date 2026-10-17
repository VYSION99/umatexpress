-- WebAuthn credentials and one-time registration/sign-in challenges.
CREATE TABLE IF NOT EXISTS auth_passkeys (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL, account_id TEXT NOT NULL,
  rp_id TEXT NOT NULL, public_key TEXT NOT NULL, counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, last_used_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_auth_passkeys_account ON auth_passkeys(scope, account_id);
CREATE TABLE IF NOT EXISTS auth_passkey_challenges (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL, account_id TEXT NOT NULL DEFAULT '',
  challenge TEXT NOT NULL, origin TEXT NOT NULL, rp_id TEXT NOT NULL,
  expires_at TEXT NOT NULL, used_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_auth_passkey_challenges_expiry ON auth_passkey_challenges(expires_at);
