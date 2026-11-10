-- Explicit Ask Cinema requests and evidence references; no source text is copied here.
CREATE TABLE IF NOT EXISTS cinema_chat_ai_jobs (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, requested_by TEXT NOT NULL, status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, claim_token TEXT NOT NULL DEFAULT '', lease_until TEXT NOT NULL DEFAULT '',
  answer_id TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cinema_chat_ai_queue ON cinema_chat_ai_jobs(status,lease_until,created_at);
CREATE INDEX IF NOT EXISTS idx_cinema_chat_ai_room ON cinema_chat_ai_jobs(session_id,created_at);
CREATE INDEX IF NOT EXISTS idx_cinema_chat_ai_requester ON cinema_chat_ai_jobs(requested_by,created_at);
CREATE TABLE IF NOT EXISTS cinema_chat_ai_evidence (
  job_id TEXT NOT NULL, kind TEXT NOT NULL, source_id TEXT NOT NULL, digest TEXT NOT NULL,
  PRIMARY KEY(job_id,kind,source_id)
);
CREATE INDEX IF NOT EXISTS idx_cinema_chat_ai_source ON cinema_chat_ai_evidence(kind,source_id);
-- Legacy transcript rows stay unbound; do not guess which playlist entry they describe.
CREATE TABLE IF NOT EXISTS cinema_transcript_video_context (
  segment_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, source_type TEXT NOT NULL, video_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cinema_transcript_video ON cinema_transcript_video_context(session_id,source_type,video_id);
