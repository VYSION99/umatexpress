-- Optional curiosity pilot feedback: aggregate daily counts only.
CREATE TABLE IF NOT EXISTS curiosity_feedback_daily (
  day TEXT NOT NULL, policy_version TEXT NOT NULL, service_id TEXT NOT NULL,
  outcome TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(day,policy_version,service_id,outcome)
);
-- A one-day hash of anonymous cohort, service, policy, and day prevents
-- repeat ratings without storing a student or browser ID.
CREATE TABLE IF NOT EXISTS curiosity_feedback_claims (
  dedupe_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_curiosity_feedback_claims_expiry ON curiosity_feedback_claims(expires_at);
