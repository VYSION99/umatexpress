-- Old bookmarks remain unbound: their original video cannot safely be inferred.
CREATE TABLE IF NOT EXISTS cinema_bookmark_video_context (
    bookmark_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,source_type TEXT NOT NULL,video_id TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_cinema_bookmark_video ON cinema_bookmark_video_context(session_id,source_type,video_id);
