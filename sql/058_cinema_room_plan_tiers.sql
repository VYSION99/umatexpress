CREATE TABLE IF NOT EXISTS cinema_room_plan_politics_approvals (
  account_id TEXT PRIMARY KEY, valid_until TEXT NOT NULL DEFAULT '');

INSERT OR IGNORE INTO cinema_room_plan_prices(plan,price_pesewas,enabled)
VALUES ('STUDENT_POLITICS_PLUS',5900,1),('PRO_PLUS',11900,1);
