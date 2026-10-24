-- Tracks requested Cinema study-pack work; the existing five-minute Cinema
-- maintenance pass processes one queued job at a time.
CREATE TABLE IF NOT EXISTS cinema_study_jobs (
  session_id TEXT PRIMARY KEY,
  requested_by TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('QUEUED','RUNNING','DONE','FAILED')),
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cinema_study_jobs_queue ON cinema_study_jobs(status,created_at);
