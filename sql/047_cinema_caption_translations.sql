-- Run once on an existing Cinema database. The application also applies this
-- change through its runtime schema pass when deployed.
ALTER TABLE cinema_session_privacy ADD COLUMN translation_enabled INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS cinema_caption_translations (
  session_id TEXT NOT NULL,
  segment_id TEXT NOT NULL,
  language TEXT NOT NULL,
  text TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  claimed_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (segment_id, language)
);
CREATE INDEX IF NOT EXISTS idx_cinema_caption_translations_expiry ON cinema_caption_translations(expires_at);
