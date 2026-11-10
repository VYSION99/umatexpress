CREATE TABLE IF NOT EXISTS cinema_room_plan_refunds (
  refund_id TEXT PRIMARY KEY, order_reference TEXT NOT NULL, amount INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_cinema_plan_refunds_order ON cinema_room_plan_refunds(order_reference);
