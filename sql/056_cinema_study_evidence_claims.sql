-- Dependency hashes do not extend the retention of the source text.
-- Existing packs without evidence are invalidated when read and require regeneration.
CREATE TABLE IF NOT EXISTS cinema_study_pack_evidence (
  pack_id TEXT NOT NULL,session_id TEXT NOT NULL,kind TEXT NOT NULL,source_id TEXT NOT NULL,
  digest TEXT NOT NULL,expires_at TEXT NOT NULL DEFAULT '',PRIMARY KEY(pack_id,kind,source_id));
CREATE INDEX IF NOT EXISTS idx_cinema_study_evidence_session ON cinema_study_pack_evidence(session_id,pack_id);
CREATE INDEX IF NOT EXISTS idx_cinema_study_evidence_source ON cinema_study_pack_evidence(kind,source_id);
CREATE TABLE IF NOT EXISTS cinema_study_job_claims (
  session_id TEXT PRIMARY KEY,claim_token TEXT NOT NULL DEFAULT '',lease_until TEXT NOT NULL DEFAULT '',attempts INTEGER NOT NULL DEFAULT 0);
