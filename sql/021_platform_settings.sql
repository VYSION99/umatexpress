-- 021: platform settings — the deployment switches an administrator owns.
--
-- A cron that releases money is a policy. Until now the answer lived in an
-- environment variable, so changing it meant a redeploy. One row per switch
-- lets the console hold that answer; the variable remains the fallback, and
-- every write carries the administrator who made it for the audit log.

CREATE TABLE IF NOT EXISTS platform_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_by TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
