-- Food M1: verified, read-only campus directory. Safe to rerun.

CREATE TABLE IF NOT EXISTS food_providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL,
  contact_label TEXT NOT NULL,
  contact_href TEXT NOT NULL,
  hours TEXT NOT NULL,
  pickup_details TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'DRAFT',
  verification_note TEXT NOT NULL DEFAULT '',
  verified_by TEXT NOT NULL DEFAULT '',
  verified_at TEXT NOT NULL DEFAULT '',
  last_confirmed_at TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_food_providers_public
  ON food_providers(status, verified_at, updated_at DESC);

CREATE TABLE IF NOT EXISTS food_menu_items (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_pesewas INTEGER NOT NULL,
  dietary_note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'LISTED',
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(provider_id) REFERENCES food_providers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_food_menu_provider
  ON food_menu_items(provider_id, status, display_order, created_at);

CREATE TABLE IF NOT EXISTS food_listing_reports (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  category TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN',
  resolved_by TEXT NOT NULL DEFAULT '',
  resolution_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  resolved_at TEXT NOT NULL DEFAULT '',
  FOREIGN KEY(provider_id) REFERENCES food_providers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_food_reports_queue
  ON food_listing_reports(status, created_at DESC);
