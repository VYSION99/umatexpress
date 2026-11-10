import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { sqliteTurso } from './helpers/sqlite-turso.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const sql = sqliteTurso();
const originalFetch = globalThis.fetch;
const initialized = [];
const failedInitializations = new Set();
const verification = new Map();
globalThis.fetch = (url, options) => {
  const address = String(url);
  if (address.startsWith('https://cinema-room-plans.test')) return sql.fetch(url, options);
  if (address.endsWith('/transaction/initialize')) {
    const body = JSON.parse(options.body);
    initialized.push(body);
    if (failedInitializations.has(body.email)) throw new TypeError('Provider request timed out');
    return Promise.resolve(Response.json({ status: true, data: { authorization_url: `https://checkout.paystack.test/${body.reference}`, reference: body.reference } }));
  }
  if (address.includes('/transaction/verify/')) {
    const reference = decodeURIComponent(address.split('/').at(-1));
    if (verification.has(reference)) return Promise.resolve(verification.get(reference)());
    const checkout = initialized.find(payment => payment.reference === reference);
    return Promise.resolve(Response.json({ status: true, data: { reference, amount: checkout?.amount, currency: 'GHS', status: 'success' } }));
  }
  throw new Error(`Unexpected request: ${address}`);
};
process.env.TURSO_DATABASE_URL = 'https://cinema-room-plans.test';
process.env.TURSO_AUTH_TOKEN = 'test-token';
process.env.PAYSTACK_SECRET_KEY = 'test-secret';
process.env.PAYSTACK_CURRENCY = 'GHS';
process.env.PAYSTACK_FEE_PERCENT = '1.95';
process.env.CONSOLE_SESSION_SECRET = 'test-only-cinema-plan-console-session-secret';

const oldCheckoutSchema = readFileSync(new URL('../sql/048_cinema_room_plan_checkout.sql', import.meta.url), 'utf8');
sql.db.exec(oldCheckoutSchema);
sql.db.exec(`CREATE TABLE campus_schema_meta(id TEXT PRIMARY KEY,version TEXT NOT NULL,applied_at TEXT NOT NULL);
  INSERT INTO campus_schema_meta VALUES ('cinemaRoomPlans','048_cinema_room_plan_checkout','2026-10-25');`);

const vite = await createServer({ appType: 'custom', configFile: false, root,
  resolve: { alias: { '@': root } }, server: { middlewareMode: true, hmr: false },
});
after(async () => { await vite.close(); sql.db.close(); globalThis.fetch = originalFetch; });
const plans = await vite.ssrLoadModule('/lib/cinema-engine/room-plan-subscriptions.ts');
const schema = await vite.ssrLoadModule('/lib/cinema-engine/room-plans.ts');
const { findCinemaPlanFit } = await vite.ssrLoadModule('/lib/cinema-engine/plan-fit.ts');
await schema.ensureCinemaRoomPlans();

function insertOrder(reference, accountId = 'student-1', amount = 2958) {
  sql.db.prepare(`INSERT INTO cinema_room_plan_orders
    (id,account_id,plan,base_amount,checkout_amount,reference,status,valid_until,created_at,updated_at)
    VALUES (?,?,?,?,?,?,'PENDING','','2026-10-25','2026-10-25')`)
    .run(reference, accountId, 'STUDENT_PLUS', 2900, amount, reference);
}
const order = reference => sql.db.prepare('SELECT status,valid_until FROM cinema_room_plan_orders WHERE reference=?').get(reference);
const grant = accountId => sql.db.prepare('SELECT plan,valid_until,reason FROM cinema_room_plan_grants WHERE account_id=?').get(accountId);

test('the runtime updates existing defaults and quotes the new 30-day prices', async () => {
  const prices = sql.db.prepare('SELECT plan,price_pesewas,enabled FROM cinema_room_plan_prices ORDER BY plan').all();
  assert.deepEqual(prices.map(row => ({ ...row })), [
    { plan: 'ORGANIZER_PRO', price_pesewas: 8600, enabled: 1 },
    { plan: 'PRO_PLUS', price_pesewas: 11900, enabled: 1 },
    { plan: 'STUDENT_PLUS', price_pesewas: 3700, enabled: 1 },
    { plan: 'STUDENT_POLITICS_PLUS', price_pesewas: 5900, enabled: 1 },
  ]);
  const catalogue = await plans.cinemaRoomPlanCatalogue('student-catalogue');
  assert.deepEqual(catalogue.plans.map(plan => plan.files), [1, 3, 6, 10, 15]);
  assert.equal(catalogue.plans.find(plan => plan.code === 'STUDENT_PLUS').checkoutPesewas, 3774);
  assert.equal(catalogue.plans.find(plan => plan.code === 'ORGANIZER_PRO').checkoutPesewas, 8772);
  assert.equal(catalogue.plans.find(plan => plan.code === 'STUDENT_POLITICS_PLUS').checkoutPesewas, 6018);
  assert.equal(catalogue.plans.find(plan => plan.code === 'PRO_PLUS').checkoutPesewas, 12137);
});

test('replaying the price migration preserves admin overrides, checkout switches and existing orders', () => {
  const { db } = sqliteTurso();
  try {
    db.exec(oldCheckoutSchema);
    db.exec(`UPDATE cinema_room_plan_prices SET enabled=0 WHERE plan='STUDENT_PLUS';
      UPDATE cinema_room_plan_prices SET updated_by='admin@example.test' WHERE plan='ORGANIZER_PRO';
      INSERT INTO cinema_room_plan_orders(id,account_id,plan,base_amount,checkout_amount,reference,valid_until,created_at,updated_at)
      VALUES ('existing','student','STUDENT_PLUS',2900,2958,'CRP-EXISTING','','2026-10-25','2026-10-25');`);
    const migration = readFileSync(new URL('../sql/057_cinema_room_plan_prices.sql', import.meta.url), 'utf8');
    db.exec(migration);
    db.exec(migration);
    const tiers = readFileSync(new URL('../sql/058_cinema_room_plan_tiers.sql', import.meta.url), 'utf8');
    db.exec(tiers);
    db.exec("UPDATE cinema_room_plan_prices SET price_pesewas=12900,enabled=0 WHERE plan='PRO_PLUS'");
    db.exec(tiers);
    const price = db.prepare('SELECT price_pesewas,enabled FROM cinema_room_plan_prices WHERE plan=?');
    assert.deepEqual({ ...price.get('STUDENT_PLUS') }, { price_pesewas: 3700, enabled: 0 });
    assert.deepEqual({ ...price.get('ORGANIZER_PRO') }, { price_pesewas: 7900, enabled: 1 });
    assert.deepEqual({ ...price.get('PRO_PLUS') }, { price_pesewas: 12900, enabled: 0 });
    const existing = db.prepare("SELECT base_amount,checkout_amount,status FROM cinema_room_plan_orders WHERE id='existing'").get();
    assert.deepEqual({ ...existing }, { base_amount: 2900, checkout_amount: 2958, status: 'PENDING' });
  } finally { db.close(); }
});

test('only a matching successful GHS payment activates a plan once', async () => {
  insertOrder('CRP-SUCCESS');
  assert.equal((await plans.settleCinemaRoomPlanPayment({ reference: 'CRP-SUCCESS', amount: 2957, currency: 'GHS' })).status, 'REVIEW');
  assert.equal(order('CRP-SUCCESS').status, 'REVIEW');
  assert.equal(grant('student-1'), undefined);

  insertOrder('CRP-VALID', 'student-1');
  await plans.settleCinemaRoomPlanPayment({ reference: 'CRP-VALID', amount: 2958, currency: 'GHS' });
  assert.equal(order('CRP-VALID').status, 'ACTIVE');
  assert.equal(grant('student-1').plan, 'STUDENT_PLUS');
  const expiry = grant('student-1').valid_until;
  assert.ok(Date.parse(expiry) > Date.now() + 29 * 86400_000);
  await plans.settleCinemaRoomPlanPayment({ reference: 'CRP-VALID', amount: 2958, currency: 'GHS' });
  assert.equal(grant('student-1').valid_until, expiry);
});

test('a completed full refund revokes the paid plan without touching a later grant', async () => {
  await plans.refundCinemaRoomPlanPayment({ reference: 'CRP-VALID', refundId: 'refund-valid', amount: 2958, currency: 'GHS' });
  assert.equal(order('CRP-VALID').status, 'REFUNDED');
  assert.equal(grant('student-1'), undefined);
  await plans.refundCinemaRoomPlanPayment({ reference: 'CRP-VALID', refundId: 'refund-valid', amount: 2958, currency: 'GHS' });
  assert.equal(grant('student-1'), undefined);
});

test('a failed payment never creates access', async () => {
  insertOrder('CRP-FAIL', 'student-2');
  await plans.failCinemaRoomPlanPayment('CRP-FAIL');
  assert.equal(order('CRP-FAIL').status, 'FAILED');
  assert.equal(grant('student-2'), undefined);
});

test('processed refund installments accumulate once and revoke only the matching purchase', async () => {
  const { receivePaymentEvent, processPaymentInboxEvent } = await vite.ssrLoadModule('/lib/payments/inbox.ts');
  const reference = 'CRP-INSTALLMENTS';
  insertOrder(reference, 'installment-buyer');
  await plans.settleCinemaRoomPlanPayment({ reference, amount: 2958, currency: 'GHS' });
  const refund = async (id, amount) => processPaymentInboxEvent(await receivePaymentEvent({ event: 'refund.processed', data: { id, amount, currency: 'GHS', transaction: { reference } } }));
  await refund(101, 1800);
  await refund(101, 1800);
  assert.equal(order(reference).status, 'REVIEW');
  assert.equal(grant('installment-buyer').plan, 'STUDENT_PLUS');
  await refund(102, 1158);
  assert.equal(order(reference).status, 'REFUNDED');
  assert.equal(grant('installment-buyer'), undefined);
  assert.equal(sql.db.prepare('SELECT COUNT(*) AS n FROM cinema_room_plan_refunds WHERE order_reference=?').get(reference).n, 2);
});

test('unknown checkout can expire only after a confirmed missing reference and the recovery window', async () => {
  const input = { accountId: 'unknown-checkout', email: 'unknown-checkout@st.umat.edu.gh', plan: 'STUDENT_PLUS', origin: 'https://umatexpress.test' };
  failedInitializations.add(input.email);
  await assert.rejects(plans.startCinemaRoomPlanCheckout(input), /pending verification/);
  failedInitializations.delete(input.email);
  const { pending } = await plans.cinemaRoomPlanCatalogue(input.accountId);
  const reference = pending.reference;
  assert.equal(pending.checkoutUrl, '');
  verification.set(reference, () => Response.json({ status: false, message: 'Transaction reference not found' }, { status: 404 }));
  assert.equal((await plans.verifyCinemaRoomPlanPayment(input.accountId, reference)).status, 'PENDING');
  sql.db.prepare("UPDATE cinema_room_plan_orders SET created_at='2000-01-01' WHERE reference=?").run(reference);
  // A scheduled verification may have updated the journal just now.
  sql.db.prepare("UPDATE provider_operations SET created_at='2000-01-01' WHERE reference=?").run(reference);
  verification.set(reference, () => Response.json({ status: false }, { status: 503 }));
  await assert.rejects(plans.verifyCinemaRoomPlanPayment(input.accountId, reference), /503/);
  assert.equal(order(reference).status, 'PENDING');
  verification.set(reference, () => Response.json({ status: false, message: 'Transaction reference not found' }, { status: 404 }));
  assert.equal((await plans.verifyCinemaRoomPlanPayment(input.accountId, reference)).status, 'EXPIRED');
  assert.equal(sql.db.prepare('SELECT state FROM provider_operations WHERE reference=?').get(reference).state, 'REJECTED');
  const replacement = await plans.startCinemaRoomPlanCheckout(input);
  assert.notEqual(replacement.reference, reference);
  assert.equal((await plans.settleCinemaRoomPlanPayment({ reference, amount: 3774, currency: 'GHS' })).status, 'REVIEW');
  assert.equal(sql.db.prepare('SELECT state FROM payment_attempts WHERE reference=?').get(reference).state, 'REVIEW');
  assert.equal(grant(input.accountId), undefined);
});

test('a completed initialization journal restores a missing checkout link', async () => {
  const input = { accountId: 'recover-link', email: 'recover-link@st.umat.edu.gh', plan: 'STUDENT_PLUS', origin: 'https://umatexpress.test' };
  const opened = await plans.startCinemaRoomPlanCheckout(input);
  sql.db.prepare("UPDATE cinema_room_plan_orders SET checkout_url='' WHERE reference=?").run(opened.reference);
  verification.set(opened.reference, () => Response.json({ status: false, message: 'Transaction reference not found' }, { status: 404 }));
  assert.equal((await plans.verifyCinemaRoomPlanPayment(input.accountId, opened.reference)).status, 'PENDING');
  assert.equal((await plans.cinemaRoomPlanCatalogue(input.accountId)).pending.checkoutUrl, opened.authorizationUrl);
  assert.equal((await plans.startCinemaRoomPlanCheckout(input)).resumed, true);
});

test('student checkout quotes the configured price and activates after provider verification', async () => {
  const checkout = await plans.startCinemaRoomPlanCheckout({ accountId: 'student-3', email: 'student-3@st.umat.edu.gh', plan: 'STUDENT_PLUS', origin: 'https://umatexpress.test' });
  assert.match(checkout.reference, /^CRP-/);
  assert.equal(checkout.authorizationUrl, `https://checkout.paystack.test/${checkout.reference}`);
  const stored = sql.db.prepare('SELECT base_amount,checkout_amount,status FROM cinema_room_plan_orders WHERE reference=?').get(checkout.reference);
  assert.deepEqual({ ...stored }, { base_amount: 3700, checkout_amount: 3774, status: 'PENDING' });
  const verified = await plans.verifyCinemaRoomPlanPayment('student-3', checkout.reference);
  assert.equal(verified.status, 'ACTIVE');
  assert.equal(grant('student-3').plan, 'STUDENT_PLUS');
  await assert.rejects(() => plans.startCinemaRoomPlanCheckout({ accountId: 'student-3', email: 'student-3@st.umat.edu.gh', plan: 'STUDENT_PLUS', origin: 'https://umatexpress.test' }), /already active/);
});

test('checkout rejects a stale displayed total and preserves the original quote for a pending order', async () => {
  const accountId = 'student-quote';
  const request = { accountId, email: 'student-quote@st.umat.edu.gh', plan: 'STUDENT_PLUS', origin: 'https://umatexpress.test' };
  const studentPlus = catalogue => catalogue.plans.find(plan => plan.code === request.plan);
  const original = studentPlus(await plans.cinemaRoomPlanCatalogue(accountId));
  const setPrice = amount => sql.db.prepare('UPDATE cinema_room_plan_prices SET price_pesewas=? WHERE plan=?').run(amount, request.plan);
  try {
    const count = initialized.length;
    setPrice(3900);
    await assert.rejects(plans.startCinemaRoomPlanCheckout({ ...request, expectedCheckoutPesewas: original.checkoutPesewas }), error => error.status === 409 && /total changed/.test(error.message));
    assert.equal(initialized.length, count);
    assert.equal((await plans.cinemaRoomPlanCatalogue(accountId)).pending, null);

    const updated = studentPlus(await plans.cinemaRoomPlanCatalogue(accountId));
    const checkout = await plans.startCinemaRoomPlanCheckout({ ...request, expectedCheckoutPesewas: updated.checkoutPesewas });
    assert.equal(initialized.at(-1).amount, updated.checkoutPesewas);
    setPrice(4900);
    const catalogue = await plans.cinemaRoomPlanCatalogue(accountId);
    assert.equal(catalogue.pending.checkoutPesewas, updated.checkoutPesewas);
    assert.equal(catalogue.pending.reference, checkout.reference);
    await assert.rejects(plans.startCinemaRoomPlanCheckout({ ...request, expectedCheckoutPesewas: studentPlus(catalogue).checkoutPesewas }), error => error.status === 409 && /checkout in progress/.test(error.message));
    assert.equal(initialized.length, count + 1);
  } finally { setPrice(original.pricePesewas); }
});

test('new tiers require the matching approval at checkout and apply their allowances after payment', async () => {
  const buyer = (accountId, plan) => ({ accountId, email: `${accountId}@st.umat.edu.gh`, plan, origin: 'https://umatexpress.test' });
  const politics = buyer('student-election', 'STUDENT_POLITICS_PLUS');
  const pro = buyer('club-owner', 'PRO_PLUS');
  const price = (catalogue, code) => catalogue.plans.find(plan => plan.code === code);
  assert.equal(price(await plans.cinemaRoomPlanCatalogue(politics.accountId), politics.plan).eligible, false);
  await assert.rejects(plans.startCinemaRoomPlanCheckout(politics), error => error.status === 403);
  sql.db.prepare('INSERT INTO cinema_room_plan_politics_approvals(account_id,valid_until) VALUES (?,?)').run(politics.accountId, '2000-01-01');
  await assert.rejects(plans.startCinemaRoomPlanCheckout(politics), error => error.status === 403);
  sql.db.prepare("UPDATE cinema_room_plan_politics_approvals SET valid_until='' WHERE account_id=?").run(politics.accountId);
  assert.equal(price(await plans.cinemaRoomPlanCatalogue(politics.accountId), politics.plan).eligible, true);
  await assert.rejects(plans.startCinemaRoomPlanCheckout({ ...politics, plan: 'PRO_PLUS' }), error => error.status === 403);
  await assert.rejects(plans.startCinemaRoomPlanCheckout(pro), error => error.status === 403);

  sql.db.prepare(`INSERT INTO cinema_organizers(id,owner_student_id,name,organizer_type,status,created_at,updated_at,verified_at)
    VALUES ('club',?,'Student club','CLUB','ACTIVE','2026-10-25','2026-10-25','2026-10-25')`).run(pro.accountId);
  assert.equal(price(await plans.cinemaRoomPlanCatalogue(pro.accountId), pro.plan).eligible, true);
  await assert.rejects(plans.startCinemaRoomPlanCheckout({ ...pro, plan: 'STUDENT_POLITICS_PLUS' }), error => error.status === 403);

  for (const [request, checkoutPesewas, files, gigabytes, minutes] of [[politics, 6018, 6, 3, 240], [pro, 12137, 15, 8, 300]]) {
    const { reference } = await plans.startCinemaRoomPlanCheckout({ ...request, expectedCheckoutPesewas: checkoutPesewas });
    assert.equal(initialized.at(-1).amount, checkoutPesewas);
    assert.equal((await plans.verifyCinemaRoomPlanPayment(request.accountId, reference)).status, 'ACTIVE');
    const allowance = await schema.snapshotCinemaRoomAllowance(`${request.accountId}-room`, request.accountId);
    assert.deepEqual(allowance, { plan: request.plan, maxFiles: files, maxBytes: gigabytes * 1024 ** 3, maxMinutes: minutes });
  }
});

test('the finder compares live checkout totals and accounts for access and capacity', async () => {
  const catalogue = await plans.cinemaRoomPlanCatalogue('club-owner');
  const planList = catalogue.plans;
  const needs = { files: 4, bytes: 3 * 1024 ** 3, minutes: 180 };
  const fit = (items, current = 'FREE', request = needs) => findCinemaPlanFit(items, current, request, catalogue.perFile);
  assert.equal(fit(planList).plan.code, 'ORGANIZER_PRO', 'a lower-priced plan requiring another approval is skipped');
  assert.equal(fit(planList, 'PRO_PLUS').kind, 'current');
  assert.equal(fit(planList.map(plan => ({ ...plan, eligible: plan.code === 'FREE' }))).kind, 'approval');
  assert.equal(fit(planList.map(plan => ({ ...plan, available: plan.code === 'FREE' }))).kind, 'closed');
  assert.equal(fit(planList, 'FREE', { ...needs, files: 10 }).plan.code, 'ORGANIZER_PRO');
  assert.equal(fit(planList, 'FREE', { ...needs, files: 15 }).plan.code, 'PRO_PLUS');
  assert.equal(fit(planList, 'FREE', { ...needs, files: 16 }).kind, 'no-fit');
  assert.equal(fit(planList, 'FREE', { ...needs, files: 1 }).kind, 'file-limit');
  assert.equal(fit(planList, 'FREE', { files: 1, bytes: 500 * 1024 ** 2, minutes: 60 }).plan.code, 'FREE');
  const repriced = planList.map(plan => plan.code === 'PRO_PLUS' ? { ...plan, checkoutPesewas: 100 } : plan);
  assert.equal(fit(repriced).plan.code, 'PRO_PLUS');
});

test('Cinema admins can approve and revoke Politics Plus checkout without granting a paid plan', async () => {
  const { ensureStudentAccountsTable } = await vite.ssrLoadModule('/lib/student-auth.ts');
  const { createConsoleAccount, consoleSessionCookie } = await vite.ssrLoadModule('/lib/console-auth.ts');
  const { PATCH } = await vite.ssrLoadModule('/app/api/console/cinema/room-plans/route.ts');
  await ensureStudentAccountsTable();
  const email = 'organizer-review@st.umat.edu.gh';
  const accountId = 'organizer-review';
  sql.db.prepare(`INSERT INTO student_accounts(id,email,password_hash,password_salt,password_iterations,email_verified,created_at,updated_at)
    VALUES (?,?,'test','test',1,1,'2026-10-25','2026-10-25')`).run(accountId, email);
  const url = 'https://console.example.test/api/console/cinema/room-plans';
  const admin = await createConsoleAccount({ email: 'plan-admin@example.test', name: 'Plan Admin', role: 'ADMIN', status: 'ACTIVE', password: 'test-password-only' });
  const cookie = (await consoleSessionCookie({ id: admin, role: 'ADMIN' }, new Request(url))).split(';')[0];
  const decide = (politicsApproval, session) => PATCH(new Request(url, {
    method: 'PATCH', headers: { 'content-type': 'application/json', ...(session ? { cookie: session } : {}) },
    body: JSON.stringify({ email, politicsApproval, reason: 'Organizer role reviewed.' }),
  }));
  const eligible = async () => (await plans.cinemaRoomPlanCatalogue(accountId)).plans.find(plan => plan.code === 'STUDENT_POLITICS_PLUS').eligible;
  assert.equal((await decide('APPROVE')).status, 401);
  assert.equal((await decide('APPROVE', cookie)).status, 200);
  assert.equal(await eligible(), true);
  assert.equal(grant(accountId), undefined);
  assert.equal((await decide('REVOKE', cookie)).status, 200);
  assert.equal(await eligible(), false);
});
