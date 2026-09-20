-- 019: hostel payouts leave through Paystack.
--
-- A batch now records how it was sent (AUTO through Paystack, MANUAL by hand),
-- where it is in the transfer lifecycle, and the codes Paystack gave back. An
-- entry that fails to send returns to the ledger through payout_attempts, so
-- money that never moved is still owed.

ALTER TABLE hostel_payout_batches ADD COLUMN mode TEXT NOT NULL DEFAULT 'MANUAL';
ALTER TABLE hostel_payout_batches ADD COLUMN status TEXT NOT NULL DEFAULT 'RECORDED';
ALTER TABLE hostel_payout_batches ADD COLUMN transfer_code TEXT NOT NULL DEFAULT '';
ALTER TABLE hostel_payout_batches ADD COLUMN recipient_code TEXT NOT NULL DEFAULT '';
ALTER TABLE hostel_payout_batches ADD COLUMN reason TEXT NOT NULL DEFAULT '';
ALTER TABLE hostel_payout_batches ADD COLUMN initiated_at TEXT NOT NULL DEFAULT '';
ALTER TABLE hostel_payout_batches ADD COLUMN settled_at TEXT NOT NULL DEFAULT '';

ALTER TABLE hostel_payouts ADD COLUMN payout_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hostel_payouts ADD COLUMN last_error TEXT NOT NULL DEFAULT '';

ALTER TABLE hostel_landlords ADD COLUMN paystack_recipient_code TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_hostel_payout_batches_inflight ON hostel_payout_batches(status, mode, initiated_at);
