CREATE TABLE IF NOT EXISTS hostel_new_period_alerts (
  watch_id TEXT NOT NULL,
  period_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (watch_id, period_id)
);
