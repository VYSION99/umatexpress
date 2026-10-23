-- Saved watch-room identity. Each use has a separate, retention-bound session.
-- Events do not register here.
CREATE TABLE IF NOT EXISTS cinema_reusable_rooms (
  id TEXT PRIMARY KEY,
  host_student_id TEXT NOT NULL,
  current_session_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  source_type TEXT NOT NULL,
  video_id TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'PUBLIC',
  duration_minutes INTEGER NOT NULL DEFAULT 0,
  busy_token TEXT NOT NULL DEFAULT '',
  busy_until TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cinema_reusable_rooms_host ON cinema_reusable_rooms(host_student_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS cinema_reusable_room_guests (
  room_id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  invited_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(room_id, student_id)
);
