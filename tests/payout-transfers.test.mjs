import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

/**
 * Phase 5's rules are about money leaving the platform, so these tests drive
 * the real release, reconcile and webhook paths against a fake Turso and a fake
 * Paystack. The criteria are: nothing is sent without a destination, the
 * settled balance is the ceiling, an in-flight transfer is not sent twice, a
 * failed transfer returns the entries rather than losing them, and an entry is
 * only released once Paystack says the money arrived.
 */

process.env.TURSO_DATABASE_URL = "https://payout-transfer-test.turso.io";
process.env.TURSO_AUTH_TOKEN = "test-token";
process.env.PAYSTACK_SECRET_KEY = "sk_test_payout_transfer_key";
process.env.PAYSTACK_CURRENCY = "GHS";
process.env.PAYMENT_PROVIDER = "PAYSTACK";
process.env.PAYOUT_ENCRYPTION_KEY = "test-payout-encryption-key-at-least-32-chars";

const SCHEMA_VERSIONS = { campusRide: "2026-09-18.1", scheduledTrips: "2026-09-18.2", tripOrganizers: "2026-09-18.3", organizerPayouts: "2026-09-18.2" };

const organizer = {
  id: "org-a",
  name: "Organizer A",
  email: "a@example.com",
  status: "APPROVED",
  kyc_status: "VERIFIED",
  payout_method: "MOMO",
  payout_account_name: "Organizer A",
  payout_account_number: "",
  payout_bank_code: "MTN",
  payout_bank_name: "MTN",
  paystack_recipient_code: "",
};

function entry(overrides = {}) {
  return {
    id: `po-${Math.random().toString(36).slice(2, 8)}`,
    organizer_id: "org-a",
    booking_id: `bk-${Math.random().toString(36).slice(2, 8)}`,
    booking_reference: "UMX-TEST",
    trip_id: "trip-a",
    gross_amount: 10000,
    commission_amount: 300,
    net_amount: 9700,
    commission_bps: 300,
    release_after: "2026-01-02T00:00:00.000Z",
    status: "ACCRUED",
    batch_id: "",
    transfer_reference: "",
    payout_attempts: 0,
    last_error: "",
    released_at: "",
    transferred_at: "",
    reversed_at: "",
    reversed_reason: "",
    created_at: "2026-01-02T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

const payouts = [];
const batches = [];
const audits = [];

/** What the fake Paystack answers next; each test sets what it needs. */
const paystack = {
  balance: 1000000,
  transferStatus: "pending",
  transferError: "",
  verifyStatus: "success",
  recipients: 0,
  transfers: 0,
};

const NOW = new Date("2026-01-03T00:00:00.000Z");

function cell(value) {
  if (value === null || value === undefined) return { type: "null" };
  if (typeof value === "number") return { type: "integer", value: String(value) };
  return { type: "text", value: String(value) };
}

function table(columns, rows) {
  return { cols: columns.map((name) => ({ name })), rows: rows.map((row) => columns.map((name) => cell(row[name]))) };
}

const empty = { cols: [], rows: [] };
const ok = (result) => ({ type: "ok", response: { result: result || {} } });
const okRows = (count) => ok({ affected_row_count: count });

function handle(sql, args) {
  if (/^CREATE |^ALTER |^INSERT OR REPLACE INTO campus_schema_meta/.test(sql)) return ok(empty);
  const version = sql.match(/SELECT version FROM campus_schema_meta WHERE id = '([^']+)'/);
  if (version) return ok(table(["version"], [{ version: SCHEMA_VERSIONS[version[1]] || "0" }]));

  // The release queue: due entries, joinable to an organizer who can be paid.
  if (/FROM organizer_payouts p\s+LEFT JOIN trip_organizers o/.test(sql)) {
    const limit = Number(args[1]) || 4;
    const due = payouts.filter((row) => row.organizer_id === organizer.id && row.status === "ACCRUED" && !row.batch_id && row.release_after <= String(args[0]));
    if (!due.length) return ok(empty);
    if (payouts.some((row) => row.status === "REVERSED" && row.released_at)) return ok(empty);
    if (batches.some((row) => row.status === "PENDING")) return ok(empty);
    const grouped = due.slice(0, limit);
    return ok(table(
      ["organizer_id", "oldest", "entry_count", "total_amount", "organizer_status", "kyc_status", "payout_method", "payout_bank_code"],
      [{
        organizer_id: organizer.id,
        oldest: grouped[0].release_after,
        entry_count: grouped.length,
        total_amount: grouped.reduce((total, row) => total + row.net_amount, 0),
        organizer_status: organizer.status,
        kyc_status: organizer.kyc_status,
        payout_method: organizer.payout_method,
        payout_bank_code: organizer.payout_bank_code,
      }],
    ));
  }
  if (/COALESCE\(payout_bank_code,''\) AS payout_bank_code/.test(sql)) {
    return ok(table(Object.keys(organizer), [organizer]));
  }
  if (/^UPDATE trip_organizers SET paystack_recipient_code=\?,updated_at=\? WHERE id=\?/.test(sql)) {
    organizer.paystack_recipient_code = String(args[0]);
    return okRows(1);
  }
  if (/^INSERT INTO organizer_payout_batches/.test(sql)) {
    // Two shapes: the manual record (Phase 4) and the automatic send.
    if (/mode,status,attempts/.test(sql)) {
      batches.push({
        id: String(args[0]), organizer_id: String(args[1]), total_amount: 0, entry_count: 0,
        transfer_reference: String(args[2]), mode: "AUTO", status: "PENDING", transfer_code: "",
        recipient_code: "", reason: "", attempts: 1, note: "", created_by: String(args[3]),
        initiated_at: String(args[4]), settled_at: "", updated_at: String(args[5]), created_at: String(args[6]),
      });
      return okRows(1);
    }
    batches.push({
      id: String(args[0]), organizer_id: String(args[1]), total_amount: 0, entry_count: 0,
      transfer_reference: String(args[2]), mode: "MANUAL", status: "RECORDED", transfer_code: "",
      recipient_code: "", reason: "", attempts: 0, note: String(args[3]), created_by: String(args[4]),
      initiated_at: "", settled_at: "", updated_at: "", created_at: String(args[5]),
    });
    return okRows(1);
  }
  if (/^UPDATE organizer_payouts SET status = 'PROCESSING'/.test(sql)) {
    let affected = 0;
    for (const row of payouts) {
      if (row.organizer_id === args[3] && row.status === "ACCRUED" && !row.batch_id && row.release_after <= String(args[4])) {
        row.status = "PROCESSING";
        row.batch_id = String(args[0]);
        row.transfer_reference = String(args[1]);
        row.updated_at = String(args[2]);
        affected += 1;
      }
    }
    return okRows(affected);
  }
  if (/^SELECT COUNT\(\*\) AS entry_count, COALESCE\(SUM\(net_amount\),0\) AS total_amount FROM organizer_payouts WHERE batch_id = \?/.test(sql)) {
    const claimed = payouts.filter((row) => row.batch_id === args[0]);
    return ok(table(["entry_count", "total_amount"], [{ entry_count: claimed.length, total_amount: claimed.reduce((total, row) => total + row.net_amount, 0) }]));
  }
  if (/^UPDATE organizer_payout_batches SET total_amount=/ && /transfer_code=\?/.test(sql)) {
    const batch = batches.find((item) => item.id === args[7]);
    if (batch) {
      batch.total_amount = Number(args[0]);
      batch.entry_count = Number(args[1]);
      batch.transfer_code = String(args[2]);
      batch.recipient_code = String(args[3]);
      batch.status = String(args[4]);
      batch.reason = String(args[5]);
      batch.updated_at = String(args[6]);
    }
    return okRows(batch ? 1 : 0);
  }
  if (/^UPDATE organizer_payouts\s+SET status = CASE WHEN payout_attempts \+ 1 >= \?/.test(sql)) {
    let affected = 0;
    for (const row of payouts) {
      if (row.batch_id === args[3] && row.status === "PROCESSING") {
        row.payout_attempts += 1;
        row.status = row.payout_attempts >= Number(args[0]) ? "FAILED" : "ACCRUED";
        row.last_error = String(args[1]);
        row.batch_id = "";
        row.updated_at = String(args[2]);
        affected += 1;
      }
    }
    return okRows(affected);
  }
  if (/^UPDATE organizer_payouts SET status='RELEASED'/.test(sql)) {
    let affected = 0;
    for (const row of payouts) {
      if (row.batch_id === args[3] && row.status === "PROCESSING") {
        row.status = "RELEASED";
        row.released_at = String(args[0]);
        row.transferred_at = String(args[1]);
        row.last_error = "";
        row.updated_at = String(args[2]);
        affected += 1;
      }
    }
    return okRows(affected);
  }
  const batchStatus = sql.match(/^UPDATE organizer_payout_batches SET status='(SUCCESS|FAILED)'/);
  if (batchStatus) {
    const batch = batches.find((item) => item.id === args[batchStatus[1] === "SUCCESS" ? 2 : 3]);
    if (batch) {
      batch.status = batchStatus[1];
      if (batchStatus[1] === "SUCCESS") {
        batch.settled_at = String(args[0]);
        batch.reason = "";
        batch.updated_at = String(args[1]);
      } else {
        batch.reason = String(args[0]);
        batch.settled_at = String(args[1]);
        batch.updated_at = String(args[2]);
      }
    }
    return okRows(batch ? 1 : 0);
  }
  if (/FROM organizer_payout_batches\s+WHERE status='PENDING' AND mode='AUTO'/.test(sql)) {
    const pending = batches.filter((row) => row.status === "PENDING" && row.mode === "AUTO" && (row.initiated_at || row.created_at) <= String(args[0]));
    return ok(table(["id", "transfer_reference", "transfer_code"], pending.slice(0, Number(args[1]) || 5)));
  }
  if (/^SELECT id,COALESCE\(status,''\) AS status FROM organizer_payout_batches/.test(sql)) {
    const batch = batches.find((row) => (row.transfer_reference && row.transfer_reference === args[0]) || (row.transfer_code && row.transfer_code === args[1]));
    return ok(batch ? table(["id", "status"], [batch]) : empty);
  }
  if (/^UPDATE organizer_payouts SET status='ACCRUED', payout_attempts=0/.test(sql)) {
    let affected = 0;
    for (const row of payouts) {
      if (row.organizer_id === args[1] && row.status === "FAILED") {
        row.status = "ACCRUED";
        row.payout_attempts = 0;
        row.last_error = "";
        affected += 1;
      }
    }
    return okRows(affected);
  }
  if (/^INSERT INTO admin_audit_logs/.test(sql)) {
    audits.push({ actor: String(args[1]), action: String(args[2]), details: String(args[5]) });
    return okRows(1);
  }
  return ok(empty);
}

globalThis.fetch = async (url, init) => {
  const target = String(url);
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  if (target.includes("api.paystack.co/balance")) {
    return { ok: true, status: 200, json: async () => ({ status: true, data: [{ currency: "GHS", balance: paystack.balance }] }) };
  }
  if (target.includes("api.paystack.co/transferrecipient")) {
    paystack.recipients += 1;
    return { ok: true, status: 200, json: async () => ({ status: true, data: { recipient_code: `RCP_test_${paystack.recipients}`, type: body.type } }) };
  }
  if (target.includes("api.paystack.co/transfer/verify/")) {
    return { ok: true, status: 200, json: async () => ({ status: true, data: { transfer_code: "TRF_verify", reference: decodeURIComponent(target.split("/").pop()), status: paystack.verifyStatus, amount: 9700 } }) };
  }
  if (target.includes("api.paystack.co/transfer")) {
    paystack.transfers += 1;
    if (paystack.transferError) {
      return { ok: false, status: 400, json: async () => ({ status: false, message: paystack.transferError }) };
    }
    return { ok: true, status: 200, json: async () => ({ status: true, data: { transfer_code: `TRF_test_${paystack.transfers}`, reference: body.reference, status: paystack.transferStatus, amount: body.amount, reason: "" } }) };
  }
  const payload = JSON.parse(String(init.body));
  const results = payload.requests
    .filter((request) => request.type === "execute")
    .map(({ stmt }) => handle(stmt.sql, (stmt.args || []).map((arg) => (arg.type === "null" ? null : arg.value))));
  results.push({ type: "ok" });
  return { ok: true, json: async () => ({ results }) };
};

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true } });
after(async () => vite.close());

const { sealSecret } = await vite.ssrLoadModule("/lib/secret-box.ts");
const {
  applyPaystackTransferEvent,
  ensureOrganizerRecipient,
  retryFailedPayouts,
  runPayoutReconcileJob,
  runPayoutReleaseJob,
} = await vite.ssrLoadModule("/lib/organizer-payouts.ts");

const ATTENDED = { actor: "admin@example.com", now: NOW };

organizer.payout_account_number = await sealSecret("0244000001");

function reset() {
  payouts.length = 0;
  batches.length = 0;
  audits.length = 0;
  organizer.paystack_recipient_code = "";
  organizer.payout_account_number = "";
  Object.assign(paystack, { balance: 1000000, transferStatus: "pending", transferError: "", verifyStatus: "success", recipients: 0, transfers: 0 });
}

test.afterEach(async () => { reset(); });

test("a due entry with no bank code is never sent anywhere", async () => {
  organizer.payout_account_number = await sealSecret("0244000001");
  organizer.payout_bank_code = "";
  payouts.push(entry());
  const result = await runPayoutReleaseJob(ATTENDED);
  assert.equal(result.status, "RAN");
  assert.equal(paystack.transfers, 0, "no transfer may be attempted without a destination");
  assert.equal(result.skipped[0].reason, "NO_DESTINATION");
  assert.equal(payouts[0].status, "ACCRUED");
  organizer.payout_bank_code = "MTN";
});

test("the settled balance is the ceiling for a run", async () => {
  organizer.payout_account_number = await sealSecret("0244000001");
  payouts.push(entry({ net_amount: 9700 }));
  paystack.balance = 5000;
  const result = await runPayoutReleaseJob(ATTENDED);
  assert.equal(paystack.transfers, 0);
  assert.equal(result.skipped[0].reason, "INSUFFICIENT_BALANCE");
  assert.equal(payouts[0].status, "ACCRUED");
  assert.ok(result.balance === 5000);
});

test("a transfer is addressed, sent, and only released once Paystack confirms", async () => {
  organizer.payout_account_number = await sealSecret("0244000001");
  payouts.push(entry({ net_amount: 9700 }));
  paystack.transferStatus = "pending";

  const inFlight = await runPayoutReleaseJob(ATTENDED);
  assert.equal(inFlight.inFlight, 1);
  assert.equal(inFlight.transferred, 0);
  assert.equal(paystack.transfers, 1);
  assert.equal(paystack.recipients, 1, "the recipient is created once and reused");
  assert.equal(payouts[0].status, "PROCESSING", "in flight is not released");
  assert.equal(batches[0].mode, "AUTO");
  assert.equal(batches[0].entry_count, 1);
  assert.equal(batches[0].total_amount, 9700);

  // The reconcile job is what settles it, and it is idempotent.
  paystack.verifyStatus = "success";
  const settled = await runPayoutReconcileJob({ now: new Date(NOW.getTime() + 5 * 60_000) });
  assert.equal(settled.settled, 1);
  assert.equal(payouts[0].status, "RELEASED");
  assert.equal(batches[0].status, "SUCCESS");

  paystack.transfers = 0;
  const again = await runPayoutReleaseJob(ATTENDED);
  assert.equal(again.considered, 0, "a released entry is not due again");
  assert.equal(paystack.transfers, 0);
});

test("an immediate success releases in the same run", async () => {
  organizer.payout_account_number = await sealSecret("0244000001");
  payouts.push(entry({ net_amount: 9700 }));
  paystack.transferStatus = "success";
  const result = await runPayoutReleaseJob(ATTENDED);
  assert.equal(result.transferred, 1);
  assert.equal(payouts[0].status, "RELEASED");
  assert.equal(batches[0].status, "SUCCESS");
});

test("a failed transfer returns the entries to the ledger instead of losing them", async () => {
  organizer.payout_account_number = await sealSecret("0244000001");
  payouts.push(entry({ net_amount: 9700 }));
  paystack.transferError = "Transfer cannot be processed at this time";

  const result = await runPayoutReleaseJob(ATTENDED);
  assert.equal(result.failed.length, 1);
  assert.equal(payouts[0].status, "ACCRUED", "the organizer is still owed the money");
  assert.equal(payouts[0].payout_attempts, 1);
  assert.match(payouts[0].last_error, /cannot be processed/);
  assert.equal(payouts[0].batch_id, "", "the claim is released so a later run can retry");
  assert.equal(batches[0].status, "FAILED");
});

test("an entry that exhausts its attempts is parked for a human, and can be reopened", async () => {
  organizer.payout_account_number = await sealSecret("0244000001");
  payouts.push(entry({ net_amount: 9700, payout_attempts: 2 }));
  paystack.transferError = "Recipient account is invalid";

  await runPayoutReleaseJob(ATTENDED);
  assert.equal(payouts[0].status, "FAILED", "three failures stop the retry loop");

  const retried = await retryFailedPayouts({ organizerId: organizer.id, actor: "admin@example.com" });
  assert.equal(retried.entries, 1);
  assert.equal(payouts[0].status, "ACCRUED");
  assert.equal(payouts[0].payout_attempts, 0);
});

test("a refund after a payout is still a debt and blocks the next run", async () => {
  organizer.payout_account_number = await sealSecret("0244000001");
  payouts.push(entry({ status: "REVERSED", released_at: "2026-01-02T00:00:00.000Z", net_amount: 9700 }));
  const result = await runPayoutReleaseJob(ATTENDED);
  assert.equal(result.considered, 0);
  assert.equal(paystack.transfers, 0);
});

test("the unattended cron is off unless the deployment opts in", async () => {
  payouts.push(entry());
  delete process.env.PAYOUT_AUTO_ENABLED;
  const off = await runPayoutReleaseJob({ now: NOW });
  assert.equal(off.status, "SKIPPED");
  assert.equal(off.reason, "AUTO_DISABLED");
  assert.equal(paystack.transfers, 0);

  process.env.PAYOUT_AUTO_ENABLED = "true";
  organizer.payout_account_number = await sealSecret("0244000001");
  const on = await runPayoutReleaseJob({ now: NOW });
  assert.equal(on.status, "RAN");
  assert.equal(paystack.transfers, 1);
  delete process.env.PAYOUT_AUTO_ENABLED;
});

test("the transfer webhook settles a pending batch and ignores a replay", async () => {
  organizer.payout_account_number = await sealSecret("0244000001");
  payouts.push(entry({ net_amount: 9700 }));
  await runPayoutReleaseJob(ATTENDED);
  assert.equal(payouts[0].status, "PROCESSING");

  const applied = await applyPaystackTransferEvent({
    event: "transfer.success",
    data: { reference: batches[0].transfer_reference, transfer_code: batches[0].transfer_code, status: "success" },
  });
  assert.equal(applied.handled, true);
  assert.equal(applied.status, "RELEASED");
  assert.equal(payouts[0].status, "RELEASED");

  const replay = await applyPaystackTransferEvent({
    event: "transfer.success",
    data: { reference: batches[0].transfer_reference, transfer_code: batches[0].transfer_code, status: "success" },
  });
  assert.equal(replay.handled, true);
  assert.equal(replay.reason, "ALREADY_SETTLED");
});

test("a reversed transfer returns the money to the ledger rather than to debt", async () => {
  organizer.payout_account_number = await sealSecret("0244000001");
  payouts.push(entry({ net_amount: 9700 }));
  await runPayoutReleaseJob(ATTENDED);

  await applyPaystackTransferEvent({
    event: "transfer.reversed",
    data: { reference: batches[0].transfer_reference, transfer_code: batches[0].transfer_code, status: "reversed" },
  });
  assert.equal(payouts[0].status, "ACCRUED", "the platform still holds the money, so the organizer is still owed it");
  assert.equal(payouts[0].released_at, "");
  assert.equal(batches[0].status, "FAILED");
});

test("a transfer without a reachable destination is refused before any call", async () => {
  organizer.payout_account_number = "";
  payouts.push(entry({ net_amount: 9700 }));
  const result = await runPayoutReleaseJob(ATTENDED);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].reason, /save it again|not recorded|missing/i);
  assert.equal(payouts[0].status, "ACCRUED");
});

test("the organizer's recipient is created once and reused across runs", async () => {
  organizer.payout_account_number = await sealSecret("0244000001");
  const first = await ensureOrganizerRecipient(organizer.id, { actor: "admin@example.com" });
  assert.equal(first.created, true);
  const second = await ensureOrganizerRecipient(organizer.id, { actor: "admin@example.com" });
  assert.equal(second.created, false);
  assert.equal(second.recipientCode, first.recipientCode);
  assert.equal(paystack.recipients, 1);
  assert.ok(audits.some((row) => row.action === "ORGANIZER_RECIPIENT_CREATED"));
});
