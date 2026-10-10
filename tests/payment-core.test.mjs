import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { sqliteTurso } from './helpers/sqlite-turso.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const sql = sqliteTurso();
const originalFetch = globalThis.fetch;
globalThis.fetch = sql.fetch;
process.env.TURSO_DATABASE_URL = 'https://payment-core.test';
process.env.TURSO_AUTH_TOKEN = 'test-token';
let effects = 0;
let failEvent = false;
globalThis.__paymentCoreTest = { effect: () => effects++, process: async () => {
  if (failEvent) throw new Error('private upstream details');
  effects++; return { handled: true, status: 'SUCCESSFUL' };
} };
const vite = await createServer({ appType: 'custom', configFile: false, root,
  resolve: { alias: { '@': root } }, server: { middlewareMode: true, hmr: false },
  plugins: [{ name: 'payment-boundary-stubs', enforce: 'pre', load(id) {
    if (id.endsWith('/lib/organizer-payouts.ts')) return 'export const accrueForBooking = async () => globalThis.__paymentCoreTest.effect();';
    if (id.endsWith('/lib/vacation-notify.ts')) return 'export const notifyVacationBookingConfirmed = async () => {};';
    if (id.endsWith('/lib/payments/paystack-events.ts')) return 'export const processPaystackEvent = async event => globalThis.__paymentCoreTest.process(event);';
  } }],
});
after(async () => { await vite.close(); sql.db.close(); globalThis.fetch = originalFetch; delete globalThis.__paymentCoreTest; });
const inbox = await vite.ssrLoadModule('/lib/payments/inbox.ts');
const vacation = await vite.ssrLoadModule('/lib/payments/vacation.ts');
const turso = await vite.ssrLoadModule('/lib/turso.ts');
await turso.ensureBookingsTable(); await turso.ensurePaymentsTable();
const finance=await vite.ssrLoadModule('/lib/payments/schema.ts');
const accounting=await vite.ssrLoadModule('/lib/payments/accounting.ts');
const operations=await vite.ssrLoadModule('/lib/payments/operations.ts');
const idempotency=await vite.ssrLoadModule('/lib/payments/idempotency.ts');
const reversal=await vite.ssrLoadModule('/lib/payments/reversal.ts');
await finance.ensureFinanceSchema();

function booking(ref, status = 'AWAITING_PAYMENT', expires = '2099-01-01') {
  sql.db.prepare(`INSERT INTO bookings (id,reference,passenger_name,email,phone,seat,trip_id,travel_date,amount,booking_status,created_at)
    VALUES (?,?,'Student','student@example.test','0240000000',1,?,'2026-10-04',1000,?,'2026-10-04')`).run(ref, ref, ref, status);
  sql.db.prepare(`INSERT INTO payments (id,booking_id,provider,reference_id,external_id,payer_phone,amount,currency,status,created_at,updated_at)
    VALUES (?,?,'PAYSTACK',?,?,'0240000000',1000,'GHS','PENDING','2026-10-04','2026-10-04')`).run(ref, ref, ref, ref);
  sql.db.prepare(`INSERT INTO seat_holds (id,booking_id,trip_id,travel_date,seat,status,expires_at,created_at)
    VALUES (?,?,?,'2026-10-04',1,'HELD',?,'2026-10-04')`).run(ref, ref, ref, expires);
}
const state = ref => sql.db.prepare('SELECT p.status,b.booking_status FROM payments p JOIN bookings b ON b.id=p.booking_id WHERE reference_id=?').get(ref);

test('success and failure racing leave a consistent confirmed booking', async () => {
  booking('race');
  await Promise.all([vacation.markSuccessful('race', 1000, 'GHS', '1'), vacation.markFailed('race', 'declined', '1')]);
  assert.deepEqual({ ...state('race') }, { status: 'SUCCESSFUL', booking_status: 'CONFIRMED' });
  await vacation.markFailed('race', 'late failure', '1');
  assert.equal(state('race').status, 'SUCCESSFUL');
});

test('cancelled and expired reservations record receipt without issuing a ticket', async () => {
  booking('cancelled', 'CANCELLED'); booking('expired', 'AWAITING_PAYMENT', '2020-01-01');
  await vacation.markSuccessful('cancelled', 1000, 'GHS', '2');
  await vacation.markSuccessful('expired', 1000, 'GHS', '3');
  assert.deepEqual({ ...state('cancelled') }, { status: 'PAID_REVIEW', booking_status: 'CANCELLED' });
  assert.deepEqual({ ...state('expired') }, { status: 'PAID_REVIEW', booking_status: 'PAYMENT_RECEIVED_REVIEW' });
});

test('amount and currency mismatches cannot confirm a booking', async () => {
  booking('amount'); booking('currency');
  await vacation.markSuccessful('amount', 999, 'GHS', '4');
  await vacation.markSuccessful('currency', 1000, 'USD', '5');
  assert.equal(state('amount').status, 'PAID_REVIEW');
  assert.equal(state('currency').status, 'PAID_REVIEW');
});

test('a provider reversal suspends fulfilment and creates a finance review', async () => {
  booking('reversed');
  await vacation.markSuccessful('reversed', 1000, 'GHS', 'reverse-tx');
  const result = await reversal.flagPaymentReversal('reversed', 'reverse-tx');
  assert.equal(result.status, 'REVERSAL_REVIEW');
  assert.deepEqual({ ...state('reversed') }, { status: 'REVERSAL_REVIEW', booking_status: 'PAYMENT_RECEIVED_REVIEW' });
  assert.equal(sql.db.prepare("SELECT status FROM finance_reconciliation WHERE reference='reversed'").get().status, 'REVIEW');
  await vacation.markSuccessful('reversed', 1000, 'GHS', 'late-success');
  await vacation.markFailed('reversed', 'late-failure', 'late-failure');
  assert.equal(state('reversed').status, 'REVERSAL_REVIEW');
  assert.equal(sql.db.prepare("SELECT payment_status FROM bookings WHERE id='reversed'").get().payment_status, 'REVERSAL_REVIEW');
  await reversal.flagPaymentReversal('reversed', 'reverse-tx');
  assert.equal(sql.db.prepare("SELECT COUNT(*) n FROM finance_audit WHERE target='reversed'").get().n, 1);
});

test('reversal racing a late success cannot resume fulfilment', async () => {
  booking('reversal-race');
  await Promise.all([reversal.flagPaymentReversal('reversal-race', 'reverse'), vacation.markSuccessful('reversal-race', 1000, 'GHS', 'success')]);
  assert.equal(state('reversal-race').status, 'REVERSAL_REVIEW');
  assert.equal(sql.db.prepare("SELECT payment_status FROM bookings WHERE id='reversal-race'").get().payment_status, 'REVERSAL_REVIEW');
});

test('transaction failure rolls back the seat claim and payment', async () => {
  booking('rollback');
  sql.db.exec("CREATE TRIGGER reject_confirmation BEFORE UPDATE ON bookings WHEN NEW.id='rollback' BEGIN SELECT RAISE(ABORT,'injected failure'); END");
  await assert.rejects(vacation.markSuccessful('rollback', 1000, 'GHS', '6'), /injected failure/);
  assert.equal(state('rollback').status, 'PENDING');
  assert.equal(sql.db.prepare("SELECT status FROM seat_holds WHERE booking_id='rollback'").get().status, 'HELD');
  sql.db.exec('DROP TRIGGER reject_confirmation');
});

const event = (type = 'transfer.success', id = 42) => ({ event: type, data: { id, reference: `ref-${id}`, status: 'success', amount: 1000 } });
test('lifecycle events for the same resource have separate durable identities', async () => {
  const success = await inbox.receivePaymentEvent(event());
  const reversed = await inbox.receivePaymentEvent(event('transfer.reversed'));
  assert.notEqual(success, reversed);
  assert.equal(await inbox.receivePaymentEvent(event()), success);
  assert.equal(sql.db.prepare('SELECT COUNT(*) AS n FROM payment_inbox').get().n, 2);
  const before = effects;
  await Promise.all([inbox.processPaymentInboxEvent(success), inbox.processPaymentInboxEvent(success)]);
  assert.equal(effects - before, 1);
  assert.equal(await inbox.processPaymentInboxEvent(success), null);
});

test('failures are retained and retryable without storing private error details', async () => {
  const id = await inbox.receivePaymentEvent(event('charge.success', 43));
  failEvent = true;
  await assert.rejects(inbox.processPaymentInboxEvent(id));
  let row = sql.db.prepare('SELECT * FROM payment_inbox WHERE id=?').get(id);
  assert.equal(row.status, 'PENDING'); assert.equal(row.attempts, 1);
  assert.equal(row.last_error, 'PROCESSING_FAILED');
  assert.equal(await inbox.processPaymentInboxEvent(id), null);
  sql.db.prepare("UPDATE payment_inbox SET available_at='2000-01-01' WHERE id=?").run(id);
  failEvent = false;
  await inbox.processPaymentInboxEvent(id);
  row = sql.db.prepare('SELECT * FROM payment_inbox WHERE id=?').get(id);
  assert.equal(row.status, 'PROCESSED'); assert.equal(row.attempts, 2);
});

test('expired processing leases recover after a process crash', async () => {
  const id = await inbox.receivePaymentEvent(event('charge.success', 44));
  sql.db.prepare("UPDATE payment_inbox SET status='PROCESSING', lease_token='dead-worker', lease_until='2000-01-01' WHERE id=?").run(id);
  await inbox.processPaymentInboxEvent(id);
  assert.equal(sql.db.prepare('SELECT status FROM payment_inbox WHERE id=?').get(id).status, 'PROCESSED');
});

test('exhausted events go to review instead of silently disappearing', async () => {
  const id = await inbox.receivePaymentEvent(event('charge.success', 45));
  sql.db.prepare('UPDATE payment_inbox SET attempts=11 WHERE id=?').run(id);
  failEvent = true; await assert.rejects(inbox.processPaymentInboxEvent(id)); failEvent = false;
  assert.equal(sql.db.prepare('SELECT status FROM payment_inbox WHERE id=?').get(id).status, 'REVIEW');
});


test('checkout retries are scoped to the owner and reject changed payloads',async()=>{
  const request=(body={seat:1},key='checkout-123')=>new Request('https://example.test/checkout',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify(body)});
  let executions=0;
  const run=async()=>{executions++;return Response.json({reference:'receipt-1'},{status:202,headers:{'Set-Cookie':'private-token'}});};
  const first=await idempotency.idempotentCheckout(request(),'one@example.test','VACATION',run);
  const repeated=await idempotency.idempotentCheckout(request(),'one@example.test','VACATION',run);
  assert.equal(executions,1);assert.equal(first.status,202);assert.equal(repeated.headers.get('Set-Cookie'),null);
  assert.equal((await repeated.json()).reference,'receipt-1');
  await assert.rejects(idempotency.idempotentCheckout(request({seat:2}),'one@example.test','VACATION',run),/different request/);
  await idempotency.idempotentCheckout(request(),'two@example.test','VACATION',run);
  assert.equal(executions,2);
});

test('simultaneous checkout retries execute only one side effect',async()=>{
  let executions=0;
  const requests=Array.from({length:25},()=>new Request('https://example.test/checkout',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'parallel-123'},body:'{"seat":3}'}));
  const results=await Promise.all(requests.map(request=>idempotency.idempotentCheckout(request,'race@example.test','VACATION',async()=>{executions++;return Response.json({reference:'one'},{status:202});})));
  assert.equal(executions,1);
  assert.ok(results.every(response=>[202,409].includes(response.status)));
});

test('a provider timeout cannot send the same transfer a second time',async()=>{
  let sends=0;
  const send=async()=>{sends++;throw new Error('socket disconnected after send');};
  await assert.rejects(operations.providerOperation('TRANSFER','unknown-1',{amount:100},send),operations.ProviderOutcomeUnknown);
  await assert.rejects(operations.providerOperation('TRANSFER','unknown-1',{amount:100},send),operations.ProviderOutcomeUnknown);
  assert.equal(sends,1);
  assert.equal(sql.db.prepare("SELECT state FROM provider_operations WHERE reference='unknown-1'").get().state,'UNKNOWN');
});

test('completed provider calls replay their result and validate request identity',async()=>{
  let sends=0;
  const send=async()=>{sends++;return {reference:'done-1',status:'SUCCESS'};};
  await operations.providerOperation('TRANSFER','done-1',{amount:100},send);
  assert.equal((await operations.providerOperation('TRANSFER','done-1',{amount:100},send)).status,'SUCCESS');
  assert.equal(sends,1);
  await assert.rejects(operations.providerOperation('TRANSFER','done-1',{amount:101},send),/different payment details/);
});

test('source updates atomically create accounting work and immutable balanced journals',async()=>{
  sql.db.exec(`CREATE TABLE organizer_payouts(id TEXT PRIMARY KEY,status TEXT,organizer_id TEXT,gross_amount INTEGER,commission_amount INTEGER,net_amount INTEGER,batch_id TEXT,released_at TEXT,transferred_at TEXT)`);
  await accounting.installFinancialCapture();
  sql.db.prepare("INSERT INTO organizer_payouts VALUES ('earned-1','ACCRUED','seller-1',1000,30,970,'','','')").run();
  // A rolled-back domain write must leave no financial event behind.
  const countBefore=sql.db.prepare('SELECT COUNT(*) n FROM financial_outbox').get().n;
  sql.db.exec("BEGIN;UPDATE organizer_payouts SET status='PROCESSING' WHERE id='earned-1';ROLLBACK;");
  assert.equal(sql.db.prepare('SELECT COUNT(*) n FROM financial_outbox').get().n,countBefore);
  for(let i=0;i<5;i++) await accounting.drainFinancialOutbox(100);
  assert.equal(sql.db.prepare("SELECT SUM(amount) n FROM ledger_lines WHERE account='seller_pending:vacation:seller-1:GHS'").get().n,-970);
  sql.db.exec("UPDATE organizer_payouts SET status='PROCESSING' WHERE id='earned-1'");
  await accounting.drainFinancialOutbox(100);
  assert.equal(sql.db.prepare("SELECT SUM(amount) n FROM ledger_lines WHERE account='seller_reserved:vacation:seller-1:GHS'").get().n,-970);
  assert.equal(sql.db.prepare("SELECT SUM(amount) n FROM ledger_lines WHERE account='seller_pending:vacation:seller-1:GHS'").get().n,0);
  assert.equal(sql.db.prepare('SELECT COUNT(*) n FROM (SELECT journal_id FROM ledger_lines GROUP BY journal_id HAVING SUM(amount)!=0)').get().n,0);
  assert.throws(()=>sql.db.exec("UPDATE ledger_lines SET amount=1"),/IMMUTABLE/);
  assert.throws(()=>sql.db.exec("DELETE FROM organizer_payouts WHERE id='earned-1'"),/FINANCIAL_HISTORY/);
});

test('concurrent accounting drains cannot post a source snapshot twice',async()=>{
  sql.db.exec("UPDATE organizer_payouts SET status='RELEASED',released_at='2026-10-04' WHERE id='earned-1'");
  await Promise.all(Array.from({length:10},()=>accounting.drainFinancialOutbox(100)));
  assert.equal(sql.db.prepare("SELECT SUM(amount) n FROM ledger_lines WHERE account='payout_clearing:GHS'").get().n,-970);
  const exceptions=sql.db.prepare("SELECT COUNT(*) n FROM financial_outbox WHERE state='REVIEW' AND source='organizer_payouts'").get().n;
  assert.equal(exceptions,0);
});

test('a broken commission snapshot is quarantined and blocks later source events',async()=>{
  sql.db.exec("INSERT INTO organizer_payouts VALUES ('broken-1','ACCRUED','seller-2',1000,30,980,'','','')");
  const result=await accounting.drainFinancialOutbox(100);
  assert.equal(result.failed,1);
  sql.db.exec("UPDATE organizer_payouts SET status='PROCESSING' WHERE id='broken-1'");
  await accounting.drainFinancialOutbox(100);
  const rows=sql.db.prepare("SELECT state FROM financial_outbox WHERE source_id='broken-1' ORDER BY sequence").all();
  assert.deepEqual(rows.map(row=>row.state),['REVIEW','PENDING']);
});

test('database rejects an unbalanced journal even when application checks are bypassed',()=>{
  sql.db.exec("INSERT INTO ledger_journals(id,source,source_id,currency,created_at) VALUES ('bad','test','test','GHS','now')");
  sql.db.exec("INSERT INTO ledger_lines VALUES ('bad','cash:GHS',100)");
  assert.throws(()=>sql.db.exec("UPDATE ledger_journals SET posted=1 WHERE id='bad'"),/UNBALANCED_JOURNAL/);
});
