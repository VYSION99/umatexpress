-- 020: password resets and one-time sign-in codes for every auth surface.
--
-- Only the HMAC of each token or code is stored, so a database read cannot mint
-- a working link. A row carries its scope (STUDENT or CONSOLE), its purpose
-- (RESET or LOGIN), an expiry and an attempt counter, and it is burned once used
-- or once the attempts run out.

CREATE TABLE IF NOT EXISTS auth_recovery_requests (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  account_id TEXT NOT NULL,
  email TEXT NOT NULL,
  purpose TEXT NOT NULL,
  token_hash TEXT NOT NULL DEFAULT '',
  code_hash TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  used_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_recovery_lookup ON auth_recovery_requests(scope, email, purpose, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_recovery_token ON auth_recovery_requests(token_hash);
