import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { sqliteTurso } from './helpers/sqlite-turso.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const sql = sqliteTurso();
const originalFetch = globalThis.fetch;
process.env.TURSO_DATABASE_URL = 'https://payment-recovery.test';
process.env.TURSO_AUTH_TOKEN = 'test-token';
process.env.PAYSTACK_SECRET_KEY = 'sk_test_local_signature_only';
let deliveries = 0;
globalThis.__paymentRecovery = { process: async () => { deliveries++; return { handled: true }; } };
const vite = await createServer({ appType: 'custom', configFile: false, root,
  resolve: { alias: { '@': root } }, server: { middlewareMode: true, hmr: false },
  plugins: [{ name: 'payment-events', enforce: 'pre', load(id) {
    if (id.endsWith('/lib/payments/paystack-events.ts')) return 'export const actionablePaystackEvent = () => true; export const processPaystackEvent = event => globalThis.__paymentRecovery.process(event);';
  } }],
});
after(async () => { await vite.close(); sql.db.close(); globalThis.fetch = originalFetch; delete globalThis.__paymentRecovery; });
const { pollPaymentVerification, verificationState } = await vite.ssrLoadModule('/lib/payments/verification-client.ts');
const { paymentReceipt } = await vite.ssrLoadModule('/lib/payments/receipt.ts');
const paystack = await vite.ssrLoadModule('/lib/paystack.ts');

test('verification survives a network error and pending result before success', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) throw new Error('offline');
    return Response.json(calls === 2 ? { status: 'PENDING' } : { status: 'SUCCESSFUL', ticket: { reference: 'ticket-1' } });
  };
  const result = await pollPaymentVerification('/verify', new AbortController().signal, { attempts: 3, intervalMs: 0 });
  assert.equal(result.state, 'success');
  assert.equal(result.ticket.reference, 'ticket-1');
});

test('timeouts, rate limits and provider errors never become payment failures', async () => {
  for (const status of [429, 500, 502, 503]) {
    globalThis.fetch = async () => new Response('', { status });
    assert.equal((await pollPaymentVerification('/verify', new AbortController().signal, { attempts: 1 })).state, 'pending');
  }
  globalThis.fetch = async () => { throw new Error('network'); };
  assert.equal((await pollPaymentVerification('/verify', new AbortController().signal, { attempts: 1 })).state, 'pending');
});

test('failure, ownership, missing references and review have distinct UI states', async () => {
  for (const [http, body, state] of [[200, { status: 'FAILED' }, 'failed'], [403, {}, 'signin'], [404, {}, 'unavailable'], [200, { status: 'REVERSAL_REVIEW' }, 'review']]) {
    globalThis.fetch = async () => Response.json(body, { status: http });
    assert.equal((await pollPaymentVerification('/verify', new AbortController().signal, { attempts: 1 })).state, state);
  }
  assert.equal(verificationState('REVERSAL_REVIEW', true), 'review');
});

test('unmount cancels verification without publishing a result', async () => {
  const controller = new AbortController();
  globalThis.fetch = async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    controller.abort();
  });
  assert.equal(await pollPaymentVerification('/verify', controller.signal), null);
});

test('receipt uses only a consistent historical fee snapshot', () => {
  assert.deepEqual(paymentReceipt(18358, 18000, 358), { totalAmount: 18358, fareAmount: 18000, feeAmount: 358 });
  assert.deepEqual(paymentReceipt(1000, 1000, 0), { totalAmount: 1000, fareAmount: 1000, feeAmount: 0 });
  for (const split of [[0, 0], [undefined, undefined], [null, null], [17000, 358]]) {
    assert.deepEqual(paymentReceipt(18358, ...split), { totalAmount: 18358, fareAmount: null, feeAmount: null });
  }
});

test('Paystack reversal is distinct from pending and missing currency cannot match', async () => {
  globalThis.fetch = async () => Response.json({ status: true, data: { status: 'reversed', amount: 1000, id: 99 } });
  const result = await paystack.verifyPaystackTransaction('ref-1');
  assert.equal(result.status, 'REVERSED');
  assert.equal(result.currency, 'MISSING');
});

test('webhook responds after durable persistence and before settlement work', async () => {
  globalThis.fetch = sql.fetch;
  const { POST } = await vite.ssrLoadModule('/app/api/payments/webhook/route.ts');
  const body = JSON.stringify({ event: 'charge.success', data: { id: 99, reference: 'ref-99', status: 'success', amount: 1000, currency: 'GHS' } });
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(process.env.PAYSTACK_SECRET_KEY), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']);
  const signature = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))), byte => byte.toString(16).padStart(2, '0')).join('');
  const request = () => new Request('https://app.test/api/payments/webhook', { method: 'POST', headers: { 'x-paystack-signature': signature }, body });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  globalThis.__paymentRecovery.process = async () => { deliveries++; await gate; return { handled: true }; };
  let timer;
  const response = await Promise.race([POST(request()), new Promise((_resolve, reject) => { timer = setTimeout(() => { release(); reject(new Error('Webhook waited for settlement')); }, 500); })]);
  clearTimeout(timer);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).accepted, true);
  assert.notEqual(sql.db.prepare('SELECT status FROM payment_inbox').get().status, 'PROCESSED');
  release();
  await new Promise(resolve => setImmediate(resolve));
  await POST(request());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(deliveries, 1);
  assert.equal(sql.db.prepare('SELECT status FROM payment_inbox').get().status, 'PROCESSED');
  const rejected = await POST(new Request('https://app.test/api/payments/webhook', { method: 'POST', body }));
  assert.equal(rejected.status, 401);
  assert.equal(deliveries, 1);
});

test('finance health counts all records and excludes fresh activity', async () => {
  globalThis.fetch = sql.fetch;
  const { ensureFinanceSchema } = await vite.ssrLoadModule('/lib/payments/schema.ts');
  const { paymentHealth } = await vite.ssrLoadModule('/lib/payments/health.ts');
  await ensureFinanceSchema();
  const now = new Date('2026-10-09T12:00:00.000Z');
  for (let i = 0; i < 125; i++) sql.db.prepare("INSERT INTO finance_reconciliation VALUES (?,?, 'CHARGE',1000,900,'GHS','MISMATCH','{}',?,?)").run(`diff-${i}`, `ref-${i}`, now.toISOString(), now.toISOString());
  sql.db.prepare("INSERT INTO provider_operations VALUES ('fresh','INITIALIZE','fresh','fp','STARTED',NULL,?,?)").run(now.toISOString(), now.toISOString());
  sql.db.exec("CREATE TABLE hostel_refunds(id TEXT PRIMARY KEY,reference TEXT,amount INTEGER,status TEXT,updated_at TEXT)");
  sql.db.exec("INSERT INTO hostel_refunds VALUES ('refund-1','ref-1',1000,'APPROVED','2026-10-07T12:00:00.000Z'), ('refund-2','ref-2',2000,'APPROVED','2026-10-09T11:59:00.000Z')");
  const health = await paymentHealth(now);
  assert.equal(health.alerts.find(alert => alert.id === 'reconciliation-review').count, 125);
  assert.equal(health.alerts.find(alert => alert.id === 'provider-unknown'), undefined);
  assert.equal(health.alerts.find(alert => alert.id === 'hostel_refunds-delayed').count, 1);
  assert.equal(health.pendingRefunds.length, 2);
});

test('reversal review never creates a second receipt or changes posted balances', async () => {
  const { sourceBalances } = await vite.ssrLoadModule('/lib/payments/accounting.ts');
  const original = sourceBalances('hostel_bookings', { status: 'PAID', total_amount: 1020, price: 1000, utilities_fee: 0, paid_at: '2026-10-08' });
  assert.deepEqual(sourceBalances('hostel_bookings', { status: 'PAYMENT_REVIEW', total_amount: 1020, price: 1000, utilities_fee: 0, paid_at: '2026-10-08' }, original), original);
  assert.deepEqual(sourceBalances('hostel_bookings', { status: 'PAYMENT_REVIEW', total_amount: 1020, price: 1000, utilities_fee: 0 }, {}), {});
  assert.deepEqual(sourceBalances('payments', { status: 'REVERSAL_REVIEW', amount: 1020 }, original), original);
});

test('reversals hold unsent payouts without reopening terminal bookings or journeys', async () => {
  globalThis.fetch = sql.fetch;
  const { flagPaymentReversal } = await vite.ssrLoadModule('/lib/payments/reversal.ts');
  sql.db.exec(`
    CREATE TABLE campus_payments(reference TEXT PRIMARY KEY,queue_entry_id TEXT,provider TEXT,amount INTEGER,currency TEXT,status TEXT,raw_response TEXT,updated_at TEXT);
    CREATE TABLE campus_queue_entries(id TEXT PRIMARY KEY,payment_status TEXT,ticket_image_ready INTEGER,queue_status TEXT,updated_at TEXT);
    CREATE TABLE hostel_bookings(id TEXT PRIMARY KEY,reference TEXT,total_amount INTEGER,status TEXT,provider TEXT,provider_reference TEXT,updated_at TEXT);
    CREATE TABLE hostel_payouts(id TEXT PRIMARY KEY,booking_id TEXT,status TEXT,updated_at TEXT);
    CREATE TABLE hostel_plugin_subscriptions(id TEXT PRIMARY KEY,reference TEXT,checkout_amount INTEGER,status TEXT,updated_at TEXT);
  `);
  for (const state of ['PAID_WAITING', 'BOARDED', 'COMPLETED', 'CANCELLED_BY_STUDENT', 'EXPIRED']) {
    const ref = `campus-${state}`;
    sql.db.prepare("INSERT INTO campus_payments VALUES (?,?,'PAYSTACK',1000,'GHS','SUCCESSFUL',NULL,NULL)").run(ref, ref);
    sql.db.prepare("INSERT INTO campus_queue_entries VALUES (?,'SUCCESSFUL',1,?,NULL)").run(ref, state);
    await flagPaymentReversal(ref, '99');
    const entry = sql.db.prepare('SELECT * FROM campus_queue_entries WHERE id=?').get(ref);
    assert.equal(entry.queue_status, state === 'PAID_WAITING' ? 'PAYMENT_RECEIVED_REVIEW' : state);
    assert.equal(entry.payment_status, 'REVERSAL_REVIEW');
    assert.equal(entry.ticket_image_ready, 0);
  }
  for (const state of ['PAID', 'PENDING_PAYMENT', 'CANCELLED', 'EXPIRED', 'REFUNDED']) {
    const ref = `hostel-${state}`;
    sql.db.prepare('INSERT INTO hostel_bookings VALUES (?,?,1000,?,NULL,NULL,NULL)').run(ref, ref, state);
    sql.db.prepare("INSERT INTO hostel_payouts VALUES (?,?,'ACCRUED',NULL)").run(`${ref}-unsent`, ref);
    sql.db.prepare("INSERT INTO hostel_payouts VALUES (?,?,'PAID',NULL)").run(`${ref}-sent`, ref);
    await flagPaymentReversal(ref, '99');
    await flagPaymentReversal(ref, '99');
    assert.equal(sql.db.prepare('SELECT status FROM hostel_bookings WHERE id=?').get(ref).status, ['PAID', 'PENDING_PAYMENT'].includes(state) ? 'PAYMENT_REVIEW' : state);
    assert.equal(sql.db.prepare('SELECT status FROM hostel_payouts WHERE id=?').get(`${ref}-unsent`).status, 'FAILED');
    assert.equal(sql.db.prepare('SELECT status FROM hostel_payouts WHERE id=?').get(`${ref}-sent`).status, 'PAID');
    assert.equal(sql.db.prepare('SELECT COUNT(*) AS count FROM finance_audit WHERE target=?').get(ref).count, 1);
  }
  sql.db.exec("INSERT INTO hostel_plugin_subscriptions VALUES ('plugin-reversed','plugin-reversed',1000,'ACTIVE',NULL)");
  await flagPaymentReversal('plugin-reversed', '99');
  assert.equal(sql.db.prepare("SELECT status FROM hostel_plugin_subscriptions WHERE id='plugin-reversed'").get().status, 'CANCELLED');
});

test('reversal and payout hold roll back together when the audit cannot be saved', async () => {
  globalThis.fetch = sql.fetch;
  const { flagPaymentReversal } = await vite.ssrLoadModule('/lib/payments/reversal.ts');
  sql.db.exec(`
    INSERT INTO hostel_bookings VALUES ('atomic-reversal','atomic-reversal',1000,'PAID',NULL,NULL,NULL);
    INSERT INTO hostel_payouts VALUES ('atomic-payout','atomic-reversal','ACCRUED',NULL);
    CREATE TRIGGER reject_reversal_audit BEFORE INSERT ON finance_audit
    WHEN NEW.target='atomic-reversal' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END;
  `);
  await assert.rejects(flagPaymentReversal('atomic-reversal', '99'), /audit unavailable/);
  assert.equal(sql.db.prepare("SELECT status FROM hostel_bookings WHERE id='atomic-reversal'").get().status, 'PAID');
  assert.equal(sql.db.prepare("SELECT status FROM hostel_payouts WHERE id='atomic-payout'").get().status, 'ACCRUED');
  assert.equal(sql.db.prepare("SELECT COUNT(*) AS count FROM finance_reconciliation WHERE reference='atomic-reversal'").get().count, 0);
});
