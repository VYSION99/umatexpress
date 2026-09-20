-- 016: hostel payouts — the money-out half of a paid booking.
--
-- 015 wrote an ACCRUED row into hostel_payouts for every paid bed. This pass
-- adds what releasing that money needs: the batch a transfer is recorded under,
-- and the account each landlord wants to be paid into.

CREATE TABLE IF NOT EXISTS hostel_payout_batches (
  id TEXT PRIMARY KEY,
  landlord_id TEXT NOT NULL,
  total_amount INTEGER NOT NULL DEFAULT 0,
  entry_count INTEGER NOT NULL DEFAULT 0,
  transfer_reference TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hostel_payout_batches_landlord ON hostel_payout_batches(landlord_id, created_at DESC);

-- One entry is released under exactly one batch, and carries the reference it
-- was paid under, so a statement can explain the money without a second lookup.
ALTER TABLE hostel_payouts ADD COLUMN batch_id TEXT NOT NULL DEFAULT '';
ALTER TABLE hostel_payouts ADD COLUMN transfer_reference TEXT NOT NULL DEFAULT '';
ALTER TABLE hostel_payouts ADD COLUMN released_by TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_hostel_payouts_batch ON hostel_payouts(batch_id);

-- The destination. The account number is sealed with PAYOUT_ENCRYPTION_KEY and
-- only the last four are ever read back except through an audited reveal.
ALTER TABLE hostel_landlords ADD COLUMN payout_method TEXT NOT NULL DEFAULT '';
ALTER TABLE hostel_landlords ADD COLUMN payout_account_name TEXT NOT NULL DEFAULT '';
ALTER TABLE hostel_landlords ADD COLUMN payout_account_number TEXT NOT NULL DEFAULT '';
ALTER TABLE hostel_landlords ADD COLUMN payout_account_last4 TEXT NOT NULL DEFAULT '';
ALTER TABLE hostel_landlords ADD COLUMN payout_bank_code TEXT NOT NULL DEFAULT '';
ALTER TABLE hostel_landlords ADD COLUMN payout_bank_name TEXT NOT NULL DEFAULT '';
ALTER TABLE hostel_landlords ADD COLUMN payout_updated_at TEXT NOT NULL DEFAULT '';
