-- Private account avatars. A student and a console user may share an email,
-- but their authentication identities and photos remain separate.
CREATE TABLE IF NOT EXISTS account_profile_photos (
  scope TEXT NOT NULL CHECK (scope IN ('STUDENT', 'CONSOLE')),
  account_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, account_id)
);
