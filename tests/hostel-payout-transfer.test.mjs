import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

/**
 * Phase 3's transfer half: a landlord's payable balance leaves through Paystack,
 * and the ledger only calls it paid once the transfer settles. The tests run
 * the engine against a fake Turso and a fake Paystack, so the claim on the
 * entries, the webhook, and the reconcile job can each be asserted separately.
 */

process.env.TURSO_DATABASE_URL = "https://hostel-payout-test.turso.io";
process.env.TURSO_AUTH_TOKEN = "test-token";
process.env.CONSOLE_SESSION_SECRET = "test-console-session-secret-at-least-32-chars";
process.env.PAYOUT_ENCRYPTION_KEY = "test-payout-encryption-key-at-least-32-chars";
process.env.PAYSTACK_SECRET_KEY = "sk_test_hostel_payout_key";
process.env.PAYSTACK_CURRENCY = "GHS";

const landlords = [];
const payouts = [];
const batches = [];
const outbox = [];
const paystack = { recipients: [], transfers: [], transfersByReference: new Map(), refuseTransfer: "", balance: 500_000_00 };

function cell(value) {
  if (value === null || value === undefined) return { type: "null" };
  if (typeof value === "number") return { type: Number.isInteger(value) ? "integer" : "real", value: String(value) };
  return { type: "text", value: String(value) };
}
function table(columns, rows) {
  return { cols: columns.map((name) => ({ name })), rows: rows.map((row) => columns.map((name) => cell(row[name]))) };
}
const empty = { cols: [], rows: [] };
const ok = (result) => ({ type: "ok", response: { result: result || {} } });
const affected = (count) => ok({ affected_row_count: count });

const LANDLORD_COLUMNS = ["id", "name", "phone", "email", "organization", "status", "kyc_status", "review_reason", "commission_bps", "created_at", "updated_at"];

function handle(sql, args) {
  if (/^SELECT version FROM campus_schema_meta/.test(sql)) return ok(table(["version"], [{ version: "test-version" }]));
  if (/^CREATE |^ALTER |^INSERT OR REPLACE INTO campus_schema_meta|^INSERT INTO admin_audit_logs/.test(sql)) return affected(1);
  if (/^INSERT INTO notification_outbox/.test(sql)) {
    const [id, , recipient, template, subject, message, reference, , nowIso] = args;
    if (outbox.some((item) => item.reference === reference && item.template === template)) return affected(0);
    outbox.push({ id, recipient, template, subject, message, reference, createdAt: nowIso });
    return affected(1);
  }

  if (/^SELECT id,name,phone,email,COALESCE\(organization,''\) AS organization/.test(sql) && /FROM hostel_landlords WHERE id = \? LIMIT 1/.test(sql)) {
    const row = landlords.find((item) => item.id === args[0]);
    return ok(row ? table(LANDLORD_COLUMNS, [row]) : empty);
  }
  if (/^SELECT COALESCE\(payout_method,''\) AS payout_method/.test(sql)) {
    const row = landlords.find((item) => item.id === args[0]);
    return ok(row ? table(["payout_method", "payout_account_name", "payout_account_last4", "payout_bank_code", "payout_bank_name", "payout_updated_at"], [row]) : empty);
  }
  if (/^SELECT COALESCE\(paystack_recipient_code,''\) AS paystack_recipient_code/.test(sql)) {
    const row = landlords.find((item) => item.id === args[0]);
    return ok(row ? table(["paystack_recipient_code", "payout_account_number"], [row]) : empty);
  }
  if (/^UPDATE hostel_landlords SET payout_method=\?/.test(sql)) {
    const [method, accountName, sealed, last4, bankCode, bankName, payoutUpdatedAt, updatedAt, landlordId] = args;
    const row = landlords.find((item) => item.id === landlordId);
    if (row) Object.assign(row, {
      payout_method: method, payout_account_name: accountName, payout_account_number: sealed, payout_account_last4: last4,
      payout_bank_code: bankCode, payout_bank_name: bankName, payout_updated_at: payoutUpdatedAt, updated_at: updatedAt,
      paystack_recipient_code: "",
    });
    return affected(row ? 1 : 0);
  }
  if (/^UPDATE hostel_landlords SET paystack_recipient_code=\?,updated_at=\? WHERE id=\?/.test(sql)) {
    const row = landlords.find((item) => item.id === args[2]);
    if (row) Object.assign(row, { paystack_recipient_code: args[0], updated_at: args[1] });
    return affected(row ? 1 : 0);
  }

  if (/SELECT COUNT\(\*\) AS entry_count, COALESCE\(SUM\(net_amount\),0\) AS total_amount FROM hostel_payouts WHERE landlord_id = \? AND status = 'ACCRUED' AND release_after <= \?/.test(sql)) {
    const rows = payouts.filter((item) => item.landlord_id === args[0] && item.status === "ACCRUED" && String(item.release_after) <= args[1]);
    return ok(table(["entry_count", "total_amount"], [{ entry_count: rows.length, total_amount: rows.reduce((sum, item) => sum + Number(item.net_amount), 0) }]));
  }
  if (/SELECT COUNT\(\*\) AS entry_count, COALESCE\(SUM\(net_amount\),0\) AS total_amount FROM hostel_payouts WHERE batch_id = \?/.test(sql)) {
    const rows = payouts.filter((item) => item.batch_id === args[0]);
    return ok(table(["entry_count", "total_amount"], [{ entry_count: rows.length, total_amount: rows.reduce((sum, item) => sum + Number(item.net_amount), 0) }]));
  }
  if (/^SELECT id FROM hostel_payout_batches WHERE landlord_id = \? AND status = 'PENDING' LIMIT 1/.test(sql)) {
    const row = batches.find((item) => item.landlord_id === args[0] && item.status === "PENDING");
    return ok(row ? table(["id"], [row]) : empty);
  }
  if (/^INSERT INTO hostel_payout_batches/.test(sql)) {
    const [id, landlordId, reference, note, actor, initiatedAt, createdAt, updatedAt] = args;
    batches.push({
      id, landlord_id: landlordId, total_amount: 0, entry_count: 0, transfer_reference: reference, note, created_by: actor,
      mode: "AUTO", status: "PENDING", transfer_code: "", recipient_code: "", reason: "",
      initiated_at: initiatedAt, settled_at: "", created_at: createdAt, updated_at: updatedAt,
    });
    return affected(1);
  }
  if (/^UPDATE hostel_payouts SET status = 'PROCESSING'/.test(sql)) {
    const [batchId, reference, updatedAt, landlordId, stamp] = args;
    const rows = payouts.filter((item) => item.landlord_id === landlordId && item.status === "ACCRUED" && String(item.release_after) <= stamp);
    rows.forEach((item) => Object.assign(item, { status: "PROCESSING", batch_id: batchId, transfer_reference: reference, updated_at: updatedAt }));
    return affected(rows.length);
  }
  if (/^UPDATE hostel_payout_batches SET total_amount=\?,entry_count=\?,transfer_code=\?,recipient_code=\?,status=\?,reason=\?,updated_at=\? WHERE id=\?/.test(sql)) {
    const [total, count, transferCode, recipientCode, status, reason, updatedAt, id] = args;
    const row = batches.find((item) => item.id === id);
    if (row) Object.assign(row, { total_amount: total, entry_count: count, transfer_code: transferCode, recipient_code: recipientCode, status, reason, updated_at: updatedAt });
    return affected(row ? 1 : 0);
  }
  if (/^UPDATE hostel_payouts SET status = 'RELEASED'/.test(sql)) {
    const [releasedAt, releasedBy, updatedAt, batchId] = args;
    const rows = payouts.filter((item) => item.batch_id === batchId && item.status === "PROCESSING");
    rows.forEach((item) => Object.assign(item, { status: "RELEASED", released_at: releasedAt, released_by: releasedBy, last_error: "", updated_at: updatedAt }));
    return affected(rows.length);
  }
  if (/^UPDATE hostel_payout_batches SET status='RELEASED'/.test(sql)) {
    const row = batches.find((item) => item.id === args[2]);
    if (row) Object.assign(row, { status: "RELEASED", settled_at: args[0], reason: "", updated_at: args[1] });
    return affected(row ? 1 : 0);
  }
  if (/^UPDATE hostel_payouts\s+SET status = CASE WHEN payout_attempts \+ 1 >= \?/.test(sql)) {
    const [maxAttempts, reason, updatedAt, batchId] = args;
    const rows = payouts.filter((item) => item.batch_id === batchId && item.status === "PROCESSING");
    rows.forEach((item) => {
      item.payout_attempts = Number(item.payout_attempts || 0) + 1;
      item.status = item.payout_attempts >= Number(maxAttempts) ? "FAILED" : "ACCRUED";
      item.last_error = reason; item.batch_id = ""; item.updated_at = updatedAt;
    });
    return affected(rows.length);
  }
  if (/^UPDATE hostel_payout_batches SET status='FAILED'/.test(sql)) {
    const row = batches.find((item) => item.id === args[3]);
    if (row) Object.assign(row, { status: "FAILED", reason: args[0], settled_at: args[1], updated_at: args[2] });
    return affected(row ? 1 : 0);
  }
  if (/SELECT COALESCE\(b\.total_amount,0\) AS total_amount/.test(sql)) {
    const row = batches.find((item) => item.id === args[0]);
    const landlord = row && landlords.find((item) => item.id === row.landlord_id);
    return ok(row ? table(["total_amount", "entry_count", "transfer_reference", "email", "note"], [{ ...row, email: landlord?.email || "" }]) : empty);
  }
  if (/^SELECT \* FROM hostel_payout_batches WHERE id = \? LIMIT 1/.test(sql)) {
    const row = batches.find((item) => item.id === args[0]);
    return ok(row ? table(Object.keys(row), [row]) : empty);
  }
  if (/SELECT id,COALESCE\(transfer_reference,''\) AS transfer_reference,COALESCE\(created_by,''\) AS created_by\s+FROM hostel_payout_batches/.test(sql)) {
    const rows = batches.filter((item) => item.status === "PENDING" && item.mode === "AUTO" && String(item.initiated_at || item.created_at) <= args[0]);
    return ok(rows.length ? table(["id", "transfer_reference", "created_by"], rows) : empty);
  }
  if (/SELECT id,COALESCE\(status,''\) AS status,COALESCE\(created_by,''\) AS created_by FROM hostel_payout_batches/.test(sql)) {
    const row = batches.find((item) => item.transfer_reference === args[0] || item.transfer_code === args[1]);
    return ok(row ? table(["id", "status", "created_by"], [row]) : empty);
  }
  if (/SELECT p\.landlord_id, MIN\(p\.release_after\) AS oldest/.test(sql)) {
    const due = payouts.filter((item) => item.status === "ACCRUED" && !item.batch_id && String(item.release_after) <= args[0]);
    const ids = [...new Set(due.map((item) => item.landlord_id))];
    const rows = ids.map((id) => ({ p_landlord_id: id, landlord_id: id, oldest: due.filter((item) => item.landlord_id === id).map((item) => item.release_after).sort()[0] }));
    return ok(rows.length ? table(["landlord_id", "oldest"], rows) : empty);
  }
  if (/^SELECT \* FROM hostel_payout_batches WHERE landlord_id = \? ORDER BY created_at DESC/.test(sql)) {
    const rows = batches.filter((item) => item.landlord_id === args[0]).sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)));
    return ok(rows.length ? table(Object.keys(rows[0]), rows) : empty);
  }
  if (/^SELECT p\.id,p\.booking_id,p\.landlord_id,p\.gross_amount/.test(sql)) {
    const rows = payouts.filter((item) => item.landlord_id === args[0]).map((item) => ({
      ...item,
      booking_reference: `HL-${item.booking_id}`,
      student_name: "Ama Mensah",
      property_name: "Owusu Lodge",
      period_name: "2026/27",
    }));
    const columns = [
      "id", "booking_id", "landlord_id", "gross_amount", "commission_bps", "commission_amount", "net_amount", "status",
      "release_after", "released_at", "transfer_reference", "created_at", "booking_reference", "student_name", "property_name", "period_name",
    ];
    return ok(rows.length ? table(columns, rows) : empty);
  }
  if (/FROM hostel_landlords l\s+JOIN hostel_payouts p ON p\.landlord_id = l\.id/.test(sql)) {
    const [stampA, stampB] = [args[0], args[1]];
    const rows = landlords.map((landlord) => {
      const entries = payouts.filter((item) => item.landlord_id === landlord.id);
      const accrued = entries.filter((item) => item.status === "ACCRUED");
      const payable = accrued.filter((item) => String(item.release_after) <= stampA);
      const sum = (list) => list.reduce((total, item) => total + Number(item.net_amount), 0);
      return {
        ...landlord, accrued_amount: sum(accrued), payable_amount: sum(payable.filter((item) => String(item.release_after) <= stampB)),
        payable_count: payable.length, released_amount: sum(entries.filter((item) => item.status === "RELEASED")), entry_count: entries.length,
      };
    }).filter((landlord) => landlord.entry_count > 0);
    const columns = [...LANDLORD_COLUMNS, "accrued_amount", "payable_amount", "payable_count", "released_amount", "entry_count"];
    return ok(rows.length ? table(columns, rows) : empty);
  }
  return ok(empty);
}

globalThis.fetch = async (url, init) => {
  const target = String(typeof url === "string" ? url : url?.url || "");
  if (target.includes("api.paystack.co")) {
    const path = new URL(target).pathname;
    if (path === "/bank") {
      return { ok: true, json: async () => ({ status: true, data: [{ name: "MTN", code: "MTN", type: "mobile_money" }, { name: "GCB Bank Limited", code: "040100", type: "ghipss" }] }) };
    }
    if (path === "/balance") {
      return { ok: true, json: async () => ({ status: true, data: [{ currency: "GHS", balance: paystack.balance }] }) };
    }
    if (path === "/transferrecipient") {
      const body = JSON.parse(init.body);
      const recipientCode = `RCP-${paystack.recipients.length + 1}`;
      paystack.recipients.push({ recipientCode, ...body });
      return { ok: true, json: async () => ({ status: true, data: { recipient_code: recipientCode, type: body.type } }) };
    }
    if (path === "/transfer") {
      const body = JSON.parse(init.body);
      if (paystack.refuseTransfer) return { ok: false, json: async () => ({ status: false, message: paystack.refuseTransfer }) };
      // Paystack accepts the transfer and settles asynchronously, so every
      // initiated transfer starts `pending` and the webhook decides the rest.
      const saved = { transferCode: `TRF-${paystack.transfers.length + 1}`, reference: body.reference, amount: body.amount, status: "pending" };
      paystack.transfers.push(saved);
      paystack.transfersByReference.set(body.reference, saved);
      return { ok: true, json: async () => ({ status: true, data: { transfer_code: saved.transferCode, reference: body.reference, amount: body.amount, status: saved.status, recipient: body.recipient } }) };
    }
    if (path.startsWith("/transfer/verify/")) {
      const reference = decodeURIComponent(path.split("/transfer/verify/")[1]);
      const saved = paystack.transfersByReference.get(reference);
      if (!saved) return { ok: false, json: async () => ({ status: false, message: "Transfer not found" }) };
      return { ok: true, json: async () => ({ status: true, data: { transfer_code: saved.transferCode, reference, amount: saved.amount, status: saved.status } }) };
    }
    return { ok: false, json: async () => ({ status: false, message: `Unhandled ${path}` }) };
  }
  const body = JSON.parse(init.body);
  const results = body.requests
    .filter((request) => request.type === "execute")
    .map(({ stmt }) => {
      const args = (stmt.args || []).map((arg) => (arg.type === "null" ? null : arg.value));
      return handle(stmt.sql, args);
    });
  results.push({ type: "ok" });
  return { ok: true, json: async () => ({ results }) };
};

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => vite.close());

const {
  applyHostelPaystackTransferEvent, ensureHostelRecipient, hostelPayoutStatement, listHostelPayoutLandlords,
  platformHostelPayoutBalance, runHostelPayoutReconcileJob, runHostelPayoutReleaseJob, saveHostelPayoutAccount,
  sendHostelPayoutBatch, HOSTEL_PAYOUT_MAX_ATTEMPTS,
} = await vite.ssrLoadModule("/lib/hostel-engine/payouts.ts");

function seed() {
  landlords.length = 0; payouts.length = 0; batches.length = 0; outbox.length = 0;
  paystack.recipients.length = 0; paystack.transfers.length = 0; paystack.transfersByReference.clear();
  paystack.refuseTransfer = ""; paystack.balance = 500_000_00;
  landlords.push({
    id: "landlord-a", name: "Mr. Owusu", organization: "Owusu Hostels", phone: "0551234567",
    email: "owusu@example.com", status: "ACTIVE", kyc_status: "VERIFIED", review_reason: "", commission_bps: 300,
    payout_method: "", payout_account_name: "", payout_account_number: "", payout_account_last4: "",
    payout_bank_code: "", payout_bank_name: "", payout_updated_at: "", paystack_recipient_code: "",
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
  });
  payouts.push(
    { id: "entry-1", booking_id: "booking-1", landlord_id: "landlord-a", gross_amount: 120_000, commission_amount: 3_600, net_amount: 116_400, status: "ACCRUED", release_after: "2026-09-01", payout_attempts: 0, last_error: "", batch_id: "", transfer_reference: "", released_at: "", released_by: "", created_at: "2026-08-01T00:00:00.000Z", updated_at: "2026-08-01T00:00:00.000Z" },
    { id: "entry-2", booking_id: "booking-2", landlord_id: "landlord-a", gross_amount: 50_000, commission_amount: 1_500, net_amount: 48_500, status: "ACCRUED", release_after: "2026-09-01", payout_attempts: 0, last_error: "", batch_id: "", transfer_reference: "", released_at: "", released_by: "", created_at: "2026-08-02T00:00:00.000Z", updated_at: "2026-08-02T00:00:00.000Z" },
  );
}

const account = () => saveHostelPayoutAccount({
  landlordId: "landlord-a", method: "MOMO", accountName: "Mr. Owusu", accountNumber: "0244000111",
  bankCode: "MTN", actor: "owusu@example.com",
});

test("a sent transfer claims the entries, then releases them when Paystack settles", async () => {
  seed();
  await account();
  const result = await sendHostelPayoutBatch({ landlordId: "landlord-a", actor: "admin@umat.edu.gh" });
  assert.equal(result.status, "PENDING", "Paystack is asynchronous, so the batch starts in flight");
  assert.equal(result.batch.totalAmount, 164_900);
  assert.equal(result.batch.entryCount, 2);
  assert.equal(result.batch.mode, "AUTO");
  assert.equal(result.batch.recipientCode, "RCP-1");
  assert.equal(result.batch.transferCode, "TRF-1");
  assert.equal(paystack.recipients.length, 1);
  assert.equal(paystack.recipients[0].type, "mobile_money", "a mobile money destination is not sent as a bank transfer");
  assert.equal(paystack.transfers[0].amount, 164_900);

  // The entries are processing, so nothing else can claim them while Paystack
  // has the money in hand.
  assert.deepEqual(payouts.map((entry) => entry.status), ["PROCESSING", "PROCESSING"]);
  const statement = await hostelPayoutStatement("landlord-a");
  assert.equal(statement.totals.releasedAmount, 0, "an in-flight transfer is not paid yet");
  assert.deepEqual(statement.batches.map((batch) => batch.status), ["PENDING"]);

  paystack.transfersByReference.get(result.batch.transferReference).status = "success";
  const settled = await applyHostelPaystackTransferEvent({ event: "transfer.success", data: { reference: result.batch.transferReference, transfer_code: "TRF-1" } });
  assert.equal(settled.status, "RELEASED");
  assert.deepEqual(payouts.map((entry) => entry.status), ["RELEASED", "RELEASED"]);
  const after = await hostelPayoutStatement("landlord-a");
  assert.equal(after.totals.releasedAmount, 164_900);
  assert.equal((await platformHostelPayoutBalance()).payableAmount, 0);
  assert.equal(outbox.filter((item) => item.template === "hostel_payout_recorded").length, 1, "the landlord is told once");
});

test("a second transfer cannot start while one is in flight", async () => {
  seed();
  await account();
  await sendHostelPayoutBatch({ landlordId: "landlord-a", actor: "admin@umat.edu.gh" });
  await assert.rejects(
    () => sendHostelPayoutBatch({ landlordId: "landlord-a", actor: "admin@umat.edu.gh" }),
    (error) => error?.code === "INVALID_STATE" && /in flight/.test(error.message),
    "a double-click must not pay twice",
  );
  assert.equal(paystack.transfers.length, 1);
});

test("a refused transfer returns the entries to the ledger with the reason", async () => {
  seed();
  await account();
  paystack.refuseTransfer = "Insufficient balance";
  await assert.rejects(
    () => sendHostelPayoutBatch({ landlordId: "landlord-a", actor: "admin@umat.edu.gh" }),
    (error) => error?.code === "ENGINE_ERROR" && /Insufficient balance/.test(error.message),
  );
  assert.deepEqual(payouts.map((entry) => entry.status), ["ACCRUED", "ACCRUED"], "money that never moved is still owed");
  assert.deepEqual(payouts.map((entry) => entry.payout_attempts), [1, 1]);
  assert.equal(payouts[0].last_error, "Insufficient balance");
  assert.equal(batches[0].status, "FAILED");
  const { landlords: owed } = await listHostelPayoutLandlords();
  assert.equal(owed[0].payableAmount, 164_900, "the statement still shows it as payable");
});

test("a failed transfer is retried until the attempt ceiling", async () => {
  seed();
  await account();
  paystack.refuseTransfer = "Network timeout";
  for (let attempt = 1; attempt <= HOSTEL_PAYOUT_MAX_ATTEMPTS; attempt += 1) {
    await assert.rejects(() => sendHostelPayoutBatch({ landlordId: "landlord-a", actor: "admin@umat.edu.gh" }));
    assert.deepEqual(payouts.map((entry) => entry.payout_attempts), [attempt, attempt]);
  }
  assert.deepEqual(payouts.map((entry) => entry.status), ["FAILED", "FAILED"], "after the ceiling a person has to look");
  await assert.rejects(
    () => sendHostelPayoutBatch({ landlordId: "landlord-a", actor: "admin@umat.edu.gh" }),
    (error) => error?.code === "INVALID_STATE" && /No hostel payout is ready/.test(error.message),
  );
});

test("the reconcile job settles a pending transfer whose webhook never arrived", async () => {
  seed();
  await account();
  const first = await sendHostelPayoutBatch({ landlordId: "landlord-a", actor: "admin@umat.edu.gh" });
  // A fresh transfer is not stuck: the wait keeps the job off its own send.
  const early = await runHostelPayoutReconcileJob({ limit: 4 });
  assert.deepEqual([early.scanned, early.settled], [0, 0]);

  paystack.transfersByReference.get(first.batch.transferReference).status = "success";
  const late = await runHostelPayoutReconcileJob({ limit: 4, now: new Date(Date.now() + 5 * 60_000) });
  assert.equal(late.scanned, 1);
  assert.equal(late.settled, 1);
  assert.deepEqual(payouts.map((entry) => entry.status), ["RELEASED", "RELEASED"]);
});

test("a reversed transfer returns the money to the ledger, and a settle webhook is idempotent", async () => {
  seed();
  await account();
  const sent = await sendHostelPayoutBatch({ landlordId: "landlord-a", actor: "admin@umat.edu.gh" });
  const reference = sent.batch.transferReference;
  const reversed = await applyHostelPaystackTransferEvent({ event: "transfer.reversed", data: { reference, reason: "Recipient account closed" } });
  assert.equal(reversed.status, "RETURNED_TO_LEDGER");
  assert.deepEqual(payouts.map((entry) => entry.status), ["ACCRUED", "ACCRUED"]);
  assert.equal(payouts[0].last_error, "Recipient account closed");
  assert.equal(batches[0].status, "FAILED");

  // A later success for the same batch finds nothing to settle.
  const again = await applyHostelPaystackTransferEvent({ event: "transfer.success", data: { reference } });
  assert.equal(again.handled, true);
  assert.equal(again.reason, "ALREADY_SETTLED");
  assert.deepEqual(payouts.map((entry) => entry.status), ["ACCRUED", "ACCRUED"]);
});

test("a webhook for another product's transfer is left for that product", async () => {
  seed();
  const result = await applyHostelPaystackTransferEvent({ event: "transfer.success", data: { reference: "UMX-PAYOUT-someone-else" } });
  assert.equal(result.handled, false);
  assert.equal(result.reason, "BATCH_NOT_FOUND");
});

test("the money gates hold: KYC, a destination, and something payable", async () => {
  seed();
  await assert.rejects(
    () => sendHostelPayoutBatch({ landlordId: "landlord-a", actor: "admin@umat.edu.gh" }),
    (error) => error?.code === "INVALID_STATE" && /payout account/.test(error.message),
  );
  await account();
  landlords[0].kyc_status = "PENDING";
  await assert.rejects(
    () => sendHostelPayoutBatch({ landlordId: "landlord-a", actor: "admin@umat.edu.gh" }),
    (error) => error?.code === "INVALID_STATE" && /KYC/.test(error.message),
  );
  landlords[0].kyc_status = "VERIFIED";
  payouts.forEach((entry) => { entry.release_after = "2999-01-01"; });
  await assert.rejects(
    () => sendHostelPayoutBatch({ landlordId: "landlord-a", actor: "admin@umat.edu.gh" }),
    (error) => error?.code === "INVALID_STATE" && /No hostel payout is ready/.test(error.message),
  );
});

test("a recipient is created once and rebuilt when the account changes", async () => {
  seed();
  await account();
  const first = await ensureHostelRecipient("landlord-a");
  assert.deepEqual([first.created, paystack.recipients.length], [true, 1]);
  const second = await ensureHostelRecipient("landlord-a");
  assert.deepEqual([second.created, paystack.recipients.length], [false, 1], "the stored recipient code is reused");

  await saveHostelPayoutAccount({
    landlordId: "landlord-a", method: "BANK", accountName: "Owusu Hostels Ltd", accountNumber: "0401001234567",
    bankCode: "040100", actor: "owusu@example.com",
  });
  const rebuilt = await ensureHostelRecipient("landlord-a");
  assert.equal(rebuilt.created, true, "new details must not be sent to the old recipient");
  assert.equal(paystack.recipients.length, 2);
  assert.equal(paystack.recipients[1].type, "ghipss");
  assert.equal(paystack.recipients[1].account_number, "0401001234567");
});

test("the unattended release only runs when the deployment opts in", async () => {
  seed();
  await account();
  const skipped = await runHostelPayoutReleaseJob({ limit: 2 });
  assert.equal(skipped.status, "SKIPPED");
  assert.equal(skipped.reason, "AUTO_DISABLED");
  assert.equal(paystack.transfers.length, 0);

  const attended = await runHostelPayoutReleaseJob({ limit: 2, actor: "admin@umat.edu.gh" });
  assert.equal(attended.status, "RAN");
  assert.equal(attended.sent, 1);
  assert.equal(attended.pending, 1);
  assert.equal(paystack.transfers.length, 1);
  assert.equal(batches[0].created_by, "admin@umat.edu.gh");
});
