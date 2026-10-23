-- Food M4: guarded checkout, refunds and vendor settlement accounting.
-- All collection remains disabled until both the global and provider gates are enabled.

CREATE TABLE IF NOT EXISTS food_payment_profiles (
  provider_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  commission_bps INTEGER NOT NULL DEFAULT 1000 CHECK(commission_bps BETWEEN 0 AND 5000),
  settlement_delay_minutes INTEGER NOT NULL DEFAULT 1440 CHECK(settlement_delay_minutes BETWEEN 0 AND 43200),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(provider_id) REFERENCES food_providers(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS food_payments (
  id TEXT PRIMARY KEY,
  preorder_id TEXT NOT NULL UNIQUE,
  provider_id TEXT NOT NULL,
  reference TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL DEFAULT 'PAYSTACK',
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','SUCCESSFUL','FAILED','REVIEW')),
  currency TEXT NOT NULL DEFAULT 'GHS',
  base_amount INTEGER NOT NULL CHECK(base_amount > 0),
  fee_amount INTEGER NOT NULL CHECK(fee_amount >= 0),
  amount INTEGER NOT NULL CHECK(amount = base_amount + fee_amount),
  commission_amount INTEGER NOT NULL CHECK(commission_amount >= 0),
  vendor_amount INTEGER NOT NULL CHECK(vendor_amount >= 0 AND base_amount = commission_amount + vendor_amount),
  settlement_delay_minutes INTEGER NOT NULL DEFAULT 1440 CHECK(settlement_delay_minutes BETWEEN 0 AND 43200),
  transaction_id TEXT NOT NULL DEFAULT '',
  failure_reason TEXT NOT NULL DEFAULT '',
  paid_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(preorder_id) REFERENCES food_preorders(id) ON DELETE RESTRICT,
  FOREIGN KEY(provider_id) REFERENCES food_providers(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_food_payments_status ON food_payments(status,created_at DESC);

CREATE TABLE IF NOT EXISTS food_refunds (
  id TEXT PRIMARY KEY,
  preorder_id TEXT NOT NULL,
  payment_reference TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK(amount = base_amount + fee_amount),
  base_amount INTEGER NOT NULL CHECK(base_amount > 0),
  fee_amount INTEGER NOT NULL CHECK(fee_amount >= 0),
  commission_amount INTEGER NOT NULL CHECK(commission_amount >= 0),
  vendor_amount INTEGER NOT NULL CHECK(vendor_amount >= 0 AND base_amount = commission_amount + vendor_amount),
  status TEXT NOT NULL DEFAULT 'REQUESTED' CHECK(status IN ('REQUESTED','APPROVED','PAID','FAILED','REVIEW')),
  cause TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  requested_by TEXT NOT NULL,
  decided_by TEXT NOT NULL DEFAULT '',
  paystack_reference TEXT NOT NULL DEFAULT '',
  provider_status TEXT NOT NULL DEFAULT '',
  settled_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(preorder_id) REFERENCES food_preorders(id) ON DELETE RESTRICT,
  FOREIGN KEY(provider_id) REFERENCES food_providers(id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_food_refunds_open ON food_refunds(preorder_id) WHERE status IN ('REQUESTED','APPROVED');
CREATE UNIQUE INDEX IF NOT EXISTS idx_food_refunds_provider ON food_refunds(paystack_reference) WHERE paystack_reference <> '';

CREATE TABLE IF NOT EXISTS food_settlements (
  id TEXT PRIMARY KEY,
  preorder_id TEXT NOT NULL UNIQUE,
  provider_id TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'GHS',
  gross_amount INTEGER NOT NULL CHECK(gross_amount > 0),
  commission_amount INTEGER NOT NULL CHECK(commission_amount >= 0),
  net_amount INTEGER NOT NULL CHECK(net_amount >= 0 AND gross_amount = commission_amount + net_amount),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','AVAILABLE','PAID','REVERSED')),
  available_at TEXT NOT NULL,
  paid_reference TEXT NOT NULL DEFAULT '',
  paid_by TEXT NOT NULL DEFAULT '',
  paid_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(preorder_id) REFERENCES food_preorders(id) ON DELETE RESTRICT,
  FOREIGN KEY(provider_id) REFERENCES food_providers(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_food_settlements_provider ON food_settlements(provider_id,status,available_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_food_settlements_paid_reference ON food_settlements(paid_reference) WHERE paid_reference <> '';
