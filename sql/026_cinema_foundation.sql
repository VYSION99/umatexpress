-- 026: cinema foundation — a room two students can be in at the same time.
--
-- Phase 1 of the Cinema plan (docs/Cinema/collaborative_study_video_architecture_plan.md):
-- the room and its membership, with no upload surface and no video object. The
-- host is a student_accounts row, the room carries the platform's uppercase
-- status vocabulary, and every timestamp is an ISO-8601 TEXT value, which is
-- what the rest of the schema speaks.
--
-- `cinema_participants` is membership, not presence: the Durable Object owns
-- who is connected while a room is live, and this table is how a join survives
-- a restart and how a moderator can answer "who was in this room" afterwards.
-- Chat, uploads and the retention fields arrive with the milestones that use
-- them (M4 and Phase 2), which is why they are absent here.

CREATE TABLE IF NOT EXISTS cinema_sessions (
  id                TEXT PRIMARY KEY,
  host_student_id   TEXT NOT NULL,
  title             TEXT NOT NULL DEFAULT '',
  video_source_type TEXT NOT NULL DEFAULT 'YOUTUBE',
  video_id          TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'CREATED',
  join_locked       INTEGER NOT NULL DEFAULT 0,
  started_at        TEXT NOT NULL DEFAULT '',
  ended_at          TEXT NOT NULL DEFAULT '',
  expired_at        TEXT NOT NULL DEFAULT '',
  deleted_at        TEXT NOT NULL DEFAULT '',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cinema_sessions_host ON cinema_sessions(host_student_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cinema_sessions_due ON cinema_sessions(status, ended_at);

CREATE TABLE IF NOT EXISTS cinema_participants (
  session_id   TEXT NOT NULL,
  student_id   TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  joined_at    TEXT NOT NULL,
  last_seen_at TEXT NOT NULL DEFAULT '',
  left_at      TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (session_id, student_id)
);

CREATE INDEX IF NOT EXISTS idx_cinema_participants_session ON cinema_participants(session_id, joined_at);
CREATE INDEX IF NOT EXISTS idx_cinema_participants_student ON cinema_participants(student_id, joined_at DESC);
