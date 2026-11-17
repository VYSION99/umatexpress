-- Print & Copy: verified shop directory and student quote requests. Safe to rerun.
CREATE TABLE IF NOT EXISTS print_copy_providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL,
  contact_label TEXT NOT NULL,
  contact_href TEXT NOT NULL,
  hours TEXT NOT NULL,
  services_json TEXT NOT NULL DEFAULT '[]',
  indicative_pricing TEXT NOT NULL DEFAULT '',
  turnaround TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'DRAFT',
  verification_note TEXT NOT NULL DEFAULT '',
  verified_by TEXT NOT NULL DEFAULT '',
  verified_at TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_print_copy_providers_public
  ON print_copy_providers(status, verified_at, updated_at DESC);

CREATE TABLE IF NOT EXISTS print_copy_settings (
  id TEXT PRIMARY KEY,
  quotes_enabled INTEGER NOT NULL DEFAULT 0,
  support_owner TEXT NOT NULL DEFAULT '',
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS print_copy_quotes (
  id TEXT PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  provider_id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  student_name TEXT NOT NULL,
  student_email TEXT NOT NULL,
  requirements TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'NEW',
  staff_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY(provider_id) REFERENCES print_copy_providers(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_print_copy_quotes_queue
  ON print_copy_quotes(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_print_copy_quotes_student
  ON print_copy_quotes(student_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_print_copy_quotes_expiry
  ON print_copy_quotes(expires_at);

CREATE TABLE IF NOT EXISTS print_copy_listing_reports (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  category TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN',
  resolved_by TEXT NOT NULL DEFAULT '',
  resolution_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  resolved_at TEXT NOT NULL DEFAULT '',
  FOREIGN KEY(provider_id) REFERENCES print_copy_providers(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_print_copy_reports_queue
  ON print_copy_listing_reports(status, created_at DESC);
