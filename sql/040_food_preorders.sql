-- Food M2: bounded pickup preorders. No payment or delivery tables.

CREATE TABLE IF NOT EXISTS food_vendor_profiles (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL UNIQUE,
  business_name TEXT NOT NULL,
  provider_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'PENDING',
  review_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_food_vendor_provider ON food_vendor_profiles(provider_id) WHERE provider_id<>'';

CREATE TABLE IF NOT EXISTS food_preorder_settings (
  provider_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  minimum_lead_minutes INTEGER NOT NULL DEFAULT 60,
  maximum_days_ahead INTEGER NOT NULL DEFAULT 3,
  daily_order_limit INTEGER NOT NULL DEFAULT 20,
  response_minutes INTEGER NOT NULL DEFAULT 20,
  cancellation_minutes INTEGER NOT NULL DEFAULT 30,
  pickup_instructions TEXT NOT NULL DEFAULT '',
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS food_preorders (
  id TEXT PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  provider_id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  student_name TEXT NOT NULL,
  student_email TEXT NOT NULL,
  student_phone TEXT NOT NULL DEFAULT '',
  pickup_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'REQUESTED',
  total_pesewas INTEGER NOT NULL,
  student_note TEXT NOT NULL DEFAULT '',
  vendor_note TEXT NOT NULL DEFAULT '',
  response_due_at TEXT NOT NULL,
  accepted_at TEXT NOT NULL DEFAULT '',
  declined_at TEXT NOT NULL DEFAULT '',
  cancelled_at TEXT NOT NULL DEFAULT '',
  ready_at TEXT NOT NULL DEFAULT '',
  collected_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_food_preorders_provider ON food_preorders(provider_id,status,pickup_at);
CREATE INDEX IF NOT EXISTS idx_food_preorders_student ON food_preorders(student_id,created_at DESC);

CREATE TABLE IF NOT EXISTS food_preorder_items (
  id TEXT PRIMARY KEY,
  preorder_id TEXT NOT NULL,
  menu_item_id TEXT NOT NULL,
  item_name TEXT NOT NULL,
  unit_price_pesewas INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_food_preorder_items_order ON food_preorder_items(preorder_id,created_at);
