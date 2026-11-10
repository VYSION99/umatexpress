-- Monotonic chat cursors and reply relationships. Rows without a message are
-- moderation placeholders; removed message text is not retained here.
CREATE TABLE IF NOT EXISTS cinema_message_order (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL,
  parent_id TEXT NOT NULL DEFAULT '',
  thread_id TEXT NOT NULL DEFAULT ''
);
INSERT OR IGNORE INTO cinema_message_order(message_id,session_id,thread_id)
  SELECT id,session_id,id FROM cinema_messages ORDER BY created_at,rowid;
CREATE INDEX IF NOT EXISTS idx_cinema_chat_order ON cinema_message_order(session_id,sequence);
CREATE INDEX IF NOT EXISTS idx_cinema_chat_thread ON cinema_message_order(session_id,thread_id,sequence);
