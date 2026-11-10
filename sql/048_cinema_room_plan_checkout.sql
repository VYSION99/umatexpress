-- Prepaid Cinema room plan checkout. Safe to apply after 043; the runtime
-- schema pass creates the same tables and seeds missing prices when needed.
CREATE TABLE IF NOT EXISTS cinema_room_plan_prices (
  plan TEXT PRIMARY KEY,
  price_pesewas INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS cinema_room_plan_orders (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  plan TEXT NOT NULL,
  base_amount INTEGER NOT NULL,
  checkout_amount INTEGER NOT NULL,
  reference TEXT NOT NULL UNIQUE,
  checkout_url TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'PENDING',
  valid_until TEXT NOT NULL,
  paid_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cinema_room_orders_account ON cinema_room_plan_orders(account_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cinema_room_orders_one_pending ON cinema_room_plan_orders(account_id) WHERE status = 'PENDING';
INSERT OR IGNORE INTO cinema_room_plan_prices(plan, price_pesewas, enabled)
VALUES ('STUDENT_PLUS', 2900, 1), ('ORGANIZER_PRO', 7900, 1);
