-- Private Cinema room playlist and subscription allowances.
-- Existing single-file rooms keep their video and become position 1.
DROP INDEX IF EXISTS idx_cinema_uploads_session;
ALTER TABLE cinema_uploads ADD COLUMN playlist_position INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_cinema_uploads_playlist ON cinema_uploads(session_id, playlist_position);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cinema_uploads_active_position ON cinema_uploads(session_id, playlist_position) WHERE status IN ('READY','UPLOADING');
CREATE UNIQUE INDEX IF NOT EXISTS idx_cinema_uploads_one_inflight ON cinema_uploads(session_id) WHERE status = 'UPLOADING';

CREATE TABLE IF NOT EXISTS cinema_room_plan_grants (
  account_id TEXT PRIMARY KEY,
  plan TEXT NOT NULL CHECK (plan IN ('FREE', 'STUDENT_PLUS', 'ORGANIZER_PRO')),
  valid_until TEXT NOT NULL DEFAULT '',
  granted_by TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cinema_room_allowances (
  room_id TEXT PRIMARY KEY,
  plan TEXT NOT NULL,
  max_files INTEGER NOT NULL,
  max_bytes INTEGER NOT NULL,
  max_minutes INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
