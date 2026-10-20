-- Food M3: controlled operations pilot. Still no payment or delivery.

CREATE TABLE IF NOT EXISTS food_pilot_settings (
  id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  support_contact TEXT NOT NULL DEFAULT '',
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS food_provider_operations (
  provider_id TEXT PRIMARY KEY,
  pilot_enabled INTEGER NOT NULL DEFAULT 0,
  service_status TEXT NOT NULL DEFAULT 'CLOSED',
  current_hours TEXT NOT NULL DEFAULT '',
  availability_note TEXT NOT NULL DEFAULT '',
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS food_operation_audit (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  actor_account_id TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  action TEXT NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_food_operation_audit_provider ON food_operation_audit(provider_id,created_at DESC);

CREATE TABLE IF NOT EXISTS food_order_issues (
  id TEXT PRIMARY KEY,
  preorder_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  category TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN',
  assigned_to TEXT NOT NULL DEFAULT '',
  resolution_note TEXT NOT NULL DEFAULT '',
  resolved_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  resolved_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_food_order_issues_queue ON food_order_issues(status,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_food_order_issue_active ON food_order_issues(preorder_id) WHERE status IN ('OPEN','IN_REVIEW');

CREATE TABLE IF NOT EXISTS food_order_feedback (
  id TEXT PRIMARY KEY,
  preorder_id TEXT NOT NULL UNIQUE,
  provider_id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  rating INTEGER NOT NULL,
  comment TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_food_feedback_provider ON food_order_feedback(provider_id,created_at DESC);
