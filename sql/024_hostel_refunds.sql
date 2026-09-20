-- 024: hostel refunds — cancelled beds, money on its way back.
--
-- A refund is a request at the policy price, a person's decision, then a
-- Paystack transfer back to the student. The row keeps every step: the quote
-- the student was offered, the override (if a person made one) and why, the
-- provider reference, and the settlement that closes the booking. The bed's
-- accrual is reversed when the refund is approved, so a refunded bed never
-- pays the landlord; money already transferred becomes a debt on the next
-- payout (see hostel_payout_debt in lib/hostel-engine/payouts.ts).

CREATE TABLE IF NOT EXISTS hostel_refunds (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL,
  reference TEXT NOT NULL,
  landlord_id TEXT NOT NULL DEFAULT '',
  student_email TEXT NOT NULL DEFAULT '',
  amount INTEGER NOT NULL DEFAULT 0,
  gross_amount INTEGER NOT NULL DEFAULT 0,
  commission_amount INTEGER NOT NULL DEFAULT 0,
  net_amount INTEGER NOT NULL DEFAULT 0,
  policy TEXT NOT NULL DEFAULT 'NONE',
  percent INTEGER NOT NULL DEFAULT 0,
  override_reason TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'REQUESTED',
  requested_by TEXT NOT NULL DEFAULT '',
  decided_by TEXT NOT NULL DEFAULT '',
  decided_at TEXT NOT NULL DEFAULT '',
  paystack_reference TEXT NOT NULL DEFAULT '',
  provider_status TEXT NOT NULL DEFAULT '',
  settled_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hostel_refunds_booking ON hostel_refunds(booking_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hostel_refunds_status ON hostel_refunds(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hostel_refunds_landlord ON hostel_refunds(landlord_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hostel_refunds_provider ON hostel_refunds(paystack_reference) WHERE paystack_reference <> '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_hostel_refunds_open ON hostel_refunds(booking_id) WHERE status IN ('REQUESTED','APPROVED');
