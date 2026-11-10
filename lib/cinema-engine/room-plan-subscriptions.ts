import { CampusEngineError } from "@/lib/campus-engine/errors";
import { ensureCinemaEventTables } from "@/lib/cinema-engine/events";
import { activeCinemaRoomPlan, CINEMA_ROOM_PLANS, ensureCinemaRoomPlans, isCinemaRoomPlan, type CinemaRoomPlanApproval } from "@/lib/cinema-engine/room-plans";
import { cinemaUploadLimits } from "@/lib/cinema-engine/uploads";
import { isProviderOutcomeUnknown } from "@/lib/payments/operations";
import { ensureFinanceSchema } from "@/lib/payments/schema";
import { calculatePaystackCharge, getPaystackCurrencyRuntime, getPaystackFeePercentRuntime, initializePaystackTransaction, PaystackTransactionNotFound, verifyPaystackTransaction } from "@/lib/paystack";
import { platformSettingEnabled } from "@/lib/platform-settings";
import { rowsToObjects, turso, tursoTransaction } from "@/lib/turso";

const PERIOD_DAYS = 30;
const CHECKOUT_RECOVERY_GRACE_MS = 5 * 60_000;

const approvalQuery: Record<Exclude<CinemaRoomPlanApproval, null>, string> = {
  ORGANIZER: "SELECT 1 FROM cinema_organizers WHERE owner_student_id=? AND organizer_type IN ('CLUB','DEPARTMENT') AND status='ACTIVE' AND verified_at<>''",
  POLITICS: "SELECT 1 FROM cinema_room_plan_politics_approvals WHERE account_id=? AND (valid_until='' OR valid_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
};

async function roomPlanApproval(accountId: string, approval: Exclude<CinemaRoomPlanApproval, null>) {
  return rowsToObjects(await turso(`${approvalQuery[approval]} LIMIT 1`, [accountId])).length > 0;
}

const approvalMessage = {
  ORGANIZER: "Requires an approved club or department profile.",
  POLITICS: "Requires staff approval as a student election or campaign organizer.",
};

export async function cinemaRoomPlanCatalogue(accountId: string) {
  await Promise.all([ensureCinemaRoomPlans(), ensureCinemaEventTables()]);
  const [active, prices, pending, organizerEligible, politicsEligible, feePercent, uploadLimits, uploadsEnabled, paymentsReady] = await Promise.all([
    activeCinemaRoomPlan(accountId),
    turso("SELECT plan,price_pesewas,enabled FROM cinema_room_plan_prices"),
    turso("SELECT plan,reference,checkout_url,checkout_amount FROM cinema_room_plan_orders WHERE account_id=? AND status='PENDING' ORDER BY created_at DESC LIMIT 1", [accountId]),
    roomPlanApproval(accountId, "ORGANIZER"),
    roomPlanApproval(accountId, "POLITICS"),
    getPaystackFeePercentRuntime(),
    cinemaUploadLimits(),
    platformSettingEnabled("cinema_uploads_enabled"),
    getPaystackCurrencyRuntime().then(currency => currency === "GHS").catch(() => false),
  ]);
  const priceMap = new Map(rowsToObjects(prices).map(row => [String(row.plan), row]));
  const pendingOrder = rowsToObjects(pending)[0];
  return {
    current: { plan: active.plan, validUntil: active.validUntil },
    pending: pendingOrder ? {
      plan: String(pendingOrder.plan), reference: String(pendingOrder.reference),
      checkoutUrl: String(pendingOrder.checkout_url || ""), checkoutPesewas: Number(pendingOrder.checkout_amount),
    } : null,
    organizerEligible,
    uploadsEnabled,
    perFile: { bytes: uploadLimits.maxBytes, minutes: uploadLimits.maxMinutes },
    plans: Object.entries(CINEMA_ROOM_PLANS).map(([code, policy]) => {
      const price = priceMap.get(code);
      const pricePesewas = code === "FREE" ? 0 : Math.max(0, Number(price?.price_pesewas || 0));
      const eligible = policy.approval === "ORGANIZER" ? organizerEligible : policy.approval === "POLITICS" ? politicsEligible : true;
      return {
        code, label: policy.label, description: policy.description, files: policy.files, bytes: policy.bytes, minutes: policy.minutes,
        pricePesewas, checkoutPesewas: calculatePaystackCharge(pricePesewas, feePercent).totalAmount,
        available: code === "FREE" || Boolean(paymentsReady && uploadsEnabled && Number(price?.enabled || 0) && pricePesewas > 0),
        eligible, eligibilityMessage: policy.approval && !eligible ? approvalMessage[policy.approval] : "",
      };
    }),
    periodDays: PERIOD_DAYS,
  };
}

export async function startCinemaRoomPlanCheckout(input: { accountId: string; email: string; plan: string; origin: string; expectedCheckoutPesewas?: number }) {
  await ensureCinemaRoomPlans();
  if (!isCinemaRoomPlan(input.plan) || input.plan === "FREE") throw new CampusEngineError("VALIDATION_ERROR", "Choose a paid room plan.", 400);
  if (await getPaystackCurrencyRuntime() !== "GHS") throw new CampusEngineError("CONFIG_REQUIRED", "Cinema room plan checkout requires GHS payments.", 503);
  const active = await activeCinemaRoomPlan(input.accountId);
  if (active.plan !== "FREE") throw new CampusEngineError("CONFLICT", "Your room plan is already active. Renew after it expires.", 409);
  const { approval } = CINEMA_ROOM_PLANS[input.plan];
  if (approval) {
    if (approval === "ORGANIZER") await ensureCinemaEventTables();
    if (!await roomPlanApproval(input.accountId, approval)) throw new CampusEngineError("FORBIDDEN", approvalMessage[approval], 403);
  }
  const pending = rowsToObjects(await turso("SELECT plan,reference,checkout_url,checkout_amount FROM cinema_room_plan_orders WHERE account_id=? AND status='PENDING' ORDER BY created_at DESC LIMIT 1", [input.accountId]))[0];
  if (pending) {
    if (input.expectedCheckoutPesewas !== undefined && (pending.plan !== input.plan || Number(pending.checkout_amount) !== input.expectedCheckoutPesewas)) {
      throw new CampusEngineError("CONFLICT", "You already have a checkout in progress. Review it before continuing.", 409);
    }
    if (pending.checkout_url) return { reference: String(pending.reference), authorizationUrl: String(pending.checkout_url), resumed: true };
    throw new CampusEngineError("CONFLICT", "Your previous checkout is still being prepared. Please check its status shortly.", 409);
  }
  if (!await platformSettingEnabled("cinema_uploads_enabled")) throw new CampusEngineError("INVALID_STATE", "File uploads are currently closed.", 409);
  const price = rowsToObjects(await turso("SELECT price_pesewas,enabled FROM cinema_room_plan_prices WHERE plan=? LIMIT 1", [input.plan]))[0];
  const base = Number(price?.price_pesewas || 0);
  if (!Number(price?.enabled || 0) || !Number.isSafeInteger(base) || base <= 0) throw new CampusEngineError("INVALID_STATE", "This plan is not open for checkout yet.", 409);
  const charge = calculatePaystackCharge(base, await getPaystackFeePercentRuntime());
  if (input.expectedCheckoutPesewas !== undefined && charge.totalAmount !== input.expectedCheckoutPesewas) {
    throw new CampusEngineError("CONFLICT", "The checkout total changed. Review the current total and try again.", 409);
  }
  const reference = `CRP-${crypto.randomUUID().replaceAll("-", "").slice(0, 20).toUpperCase()}`;
  const now = new Date().toISOString();
  const order = await turso(`INSERT INTO cinema_room_plan_orders(id,account_id,plan,base_amount,checkout_amount,reference,status,valid_until,created_at,updated_at)
    SELECT ?,?,?,?,?,?,'PENDING','',?,? ${approval ? `WHERE EXISTS(${approvalQuery[approval]})` : ""}`,
  [crypto.randomUUID(), input.accountId, input.plan, base, charge.totalAmount, reference, now, now, ...(approval ? [input.accountId] : [])]);
  if (!Number(order.affected_row_count) && approval) throw new CampusEngineError("FORBIDDEN", approvalMessage[approval], 403);
  let checkout;
  try {
    checkout = await initializePaystackTransaction({ email: input.email, amount: charge.totalAmount, reference, callbackUrl: `${input.origin}/cinema/rooms/plans`, metadata: { purpose: "CINEMA_ROOM_PLAN", reference, plan: input.plan, baseAmount: base, feeAmount: charge.feeAmount } });
  } catch (error) {
    if (!isProviderOutcomeUnknown(error)) await turso("UPDATE cinema_room_plan_orders SET status='FAILED',updated_at=? WHERE reference=? AND status='PENDING'", [new Date().toISOString(), reference]).catch(() => undefined);
    throw error;
  }
  // The provider journal already contains this URL. If the local write fails,
  // keep the order pending so a status check can recover the existing checkout.
  await turso("UPDATE cinema_room_plan_orders SET checkout_url=?,updated_at=? WHERE reference=? AND status='PENDING'", [checkout.authorizationUrl, new Date().toISOString(), reference]);
  return { reference, authorizationUrl: checkout.authorizationUrl, resumed: false };
}

export async function settleCinemaRoomPlanPayment(input: { reference: string; amount: number; currency: string }) {
  if (!input.reference.startsWith("CRP-")) return { handled: false as const };
  await ensureCinemaRoomPlans();
  const row = rowsToObjects(await turso("SELECT account_id,plan,checkout_amount,status,valid_until FROM cinema_room_plan_orders WHERE reference=? LIMIT 1", [input.reference]))[0];
  if (!row) return { handled: false as const };
  if (Number(row.checkout_amount) !== input.amount || input.currency.toUpperCase() !== "GHS") {
    await turso("UPDATE cinema_room_plan_orders SET status='REVIEW',updated_at=? WHERE reference=? AND status IN ('PENDING','EXPIRED')", [new Date().toISOString(), input.reference]);
    return { handled: true as const, status: "REVIEW" as const };
  }
  if (row.status === "ACTIVE") return { handled: true as const, status: "ACTIVE" as const };
  if (row.status !== "PENDING" && row.status !== "EXPIRED") return { handled: true as const, status: String(row.status) };
  const now = new Date();
  const stamp = now.toISOString();
  const validUntil = new Date(now.getTime() + PERIOD_DAYS * 86400_000).toISOString();
  await ensureFinanceSchema();
  const results = await tursoTransaction([
    { sql: "UPDATE cinema_room_plan_orders SET status='ACTIVE',paid_at=?,valid_until=?,updated_at=? WHERE reference=? AND status='PENDING'", args: [stamp, validUntil, stamp, input.reference] },
    { sql: `INSERT INTO cinema_room_plan_grants(account_id,plan,valid_until,granted_by,reason,updated_at)
      SELECT account_id,plan,valid_until,'PAYSTACK',reference,? FROM cinema_room_plan_orders WHERE reference=? AND status='ACTIVE' AND changes()=1
      ON CONFLICT(account_id) DO UPDATE SET plan=excluded.plan,valid_until=excluded.valid_until,granted_by=excluded.granted_by,reason=excluded.reason,updated_at=excluded.updated_at`, args: [stamp, input.reference] },
    { sql: "UPDATE cinema_room_plan_orders SET status='REVIEW',updated_at=? WHERE reference=? AND status='EXPIRED'", args: [stamp, input.reference] },
    { sql: `INSERT INTO finance_reconciliation(id,reference,kind,expected,observed,currency,status,details,created_at,updated_at)
      SELECT ?,?,'CHARGE',?,?,'GHS','REVIEW',?,?,? WHERE changes()=1
      ON CONFLICT(id) DO UPDATE SET status='REVIEW',observed=excluded.observed,details=excluded.details,updated_at=excluded.updated_at`,
    args: [`charge:${input.reference}`, input.reference, Number(row.checkout_amount), input.amount, "Provider reported payment after this checkout was closed. Verify settlement before granting access.", stamp, stamp] },
    { sql: "UPDATE payment_attempts SET state='REVIEW',updated_at=? WHERE reference=? AND changes()=1", args: [stamp, input.reference] },
    { sql: "SELECT status FROM cinema_room_plan_orders WHERE reference=?", args: [input.reference] },
  ]);
  return { handled: true as const, status: String(rowsToObjects(results[results.length - 1])[0]?.status || "REVIEW") };
}

export async function failCinemaRoomPlanPayment(reference: string) {
  if (!reference.startsWith("CRP-")) return { handled: false, changed: false };
  await ensureCinemaRoomPlans();
  const result = await turso("UPDATE cinema_room_plan_orders SET status='FAILED',updated_at=? WHERE reference=? AND status='PENDING'", [new Date().toISOString(), reference]);
  const exists = rowsToObjects(await turso("SELECT id FROM cinema_room_plan_orders WHERE reference=? LIMIT 1", [reference]))[0];
  return { handled: Boolean(exists), changed: Number(result.affected_row_count || 0) > 0 };
}

export async function refundCinemaRoomPlanPayment(input: { reference: string; refundId: string; amount: number; currency: string }) {
  if (!input.reference.startsWith("CRP-")) return { handled: false };
  await ensureCinemaRoomPlans();
  const order = rowsToObjects(await turso("SELECT account_id,checkout_amount FROM cinema_room_plan_orders WHERE reference=? LIMIT 1", [input.reference]))[0];
  if (!order) return { handled: false };
  if (input.currency.toUpperCase() !== "GHS") throw new CampusEngineError("CONFLICT", "Cinema plan refund currency needs review.", 409);
  const refundId = input.refundId.trim();
  if (!refundId || !Number.isSafeInteger(input.amount) || input.amount <= 0 || input.amount > Number(order.checkout_amount)) {
    throw new CampusEngineError("CONFLICT", "Cinema plan refund identity or amount needs review.", 409);
  }
  const stamp = new Date().toISOString();
  await tursoTransaction([
    { sql: "INSERT OR IGNORE INTO cinema_room_plan_refunds(refund_id,order_reference,amount,created_at) VALUES (?,?,?,?)", args: [refundId, input.reference, input.amount, stamp] },
    { sql: `UPDATE cinema_room_plan_orders SET status='REFUNDED',updated_at=? WHERE reference=? AND status<>'REFUNDED'
      AND (SELECT COALESCE(SUM(amount),0) FROM cinema_room_plan_refunds WHERE order_reference=?)>=checkout_amount`, args: [stamp, input.reference, input.reference] },
    { sql: `DELETE FROM cinema_room_plan_grants WHERE account_id=? AND granted_by='PAYSTACK' AND reason=?
      AND EXISTS(SELECT 1 FROM cinema_room_plan_orders WHERE reference=? AND status='REFUNDED')`, args: [String(order.account_id), input.reference, input.reference] },
    { sql: "UPDATE cinema_room_plan_orders SET status='REVIEW',updated_at=? WHERE reference=? AND status='ACTIVE'", args: [stamp, input.reference] },
  ]);
  return { handled: true };
}

async function recoverCheckoutUrl(reference: string) {
  await ensureFinanceSchema();
  // Copy only a completed initialization result for this exact reference.
  await turso(`UPDATE cinema_room_plan_orders SET checkout_url=(SELECT json_extract(result,'$.authorizationUrl') FROM provider_operations WHERE id=?),updated_at=?
    WHERE reference=? AND status='PENDING' AND checkout_url='' AND EXISTS(SELECT 1 FROM provider_operations
      WHERE id=? AND state='COMPLETE' AND json_extract(result,'$.reference')=? AND json_extract(result,'$.currency')='GHS'
        AND json_extract(result,'$.authorizationUrl') LIKE 'https://%')`,
  [`PAYSTACK:INITIALIZE:${reference}`, new Date().toISOString(), reference, `PAYSTACK:INITIALIZE:${reference}`, reference]);
}

/** Called only after the provider explicitly reports that the reference does not exist. */
export async function expireMissingCinemaRoomPlanCheckout(reference: string) {
  if (!reference.startsWith("CRP-")) return false;
  await Promise.all([ensureCinemaRoomPlans(), ensureFinanceSchema()]);
  const now = new Date();
  const stamp = now.toISOString();
  const cutoff = new Date(now.getTime() - CHECKOUT_RECOVERY_GRACE_MS).toISOString();
  const operationId = `PAYSTACK:INITIALIZE:${reference}`;
  const [closed] = await tursoTransaction([
    { sql: `UPDATE cinema_room_plan_orders SET status='EXPIRED',updated_at=? WHERE reference=? AND status='PENDING'
      AND checkout_url='' AND created_at<=? AND NOT EXISTS(SELECT 1 FROM provider_operations WHERE id=? AND (state='COMPLETE' OR created_at>?))`, args: [stamp, reference, cutoff, operationId, cutoff] },
    { sql: `UPDATE provider_operations SET state='REJECTED',updated_at=? WHERE id=? AND state IN ('STARTED','UNKNOWN')
      AND EXISTS(SELECT 1 FROM cinema_room_plan_orders WHERE reference=? AND status='EXPIRED')`, args: [stamp, operationId, reference] },
    { sql: `UPDATE payment_attempts SET state='FAILED',updated_at=? WHERE reference=? AND state IN ('CREATED','PENDING')
      AND EXISTS(SELECT 1 FROM cinema_room_plan_orders WHERE reference=? AND status='EXPIRED')`, args: [stamp, reference, reference] },
  ]);
  return Number(closed.affected_row_count) === 1;
}

export async function verifyCinemaRoomPlanPayment(accountId: string, reference: string) {
  await ensureCinemaRoomPlans();
  const order = rowsToObjects(await turso("SELECT account_id,status,checkout_url,plan,valid_until FROM cinema_room_plan_orders WHERE reference=? LIMIT 1", [reference]))[0];
  if (!order) throw new CampusEngineError("NOT_FOUND", "This checkout was not found.", 404);
  if (String(order.account_id) !== accountId) throw new CampusEngineError("FORBIDDEN", "This checkout belongs to another account.", 403);
  if (order.status === "ACTIVE") return { status: "ACTIVE", plan: String(order.plan), validUntil: String(order.valid_until) };
  if (order.status !== "PENDING") return { status: String(order.status), plan: String(order.plan), validUntil: "" };
  if (!order.checkout_url) await recoverCheckoutUrl(reference);
  try {
    const payment = await verifyPaystackTransaction(reference);
    if (payment.status === "SUCCESSFUL") await settleCinemaRoomPlanPayment({ reference, amount: payment.amount, currency: payment.currency });
    else if (payment.status === "FAILED") await failCinemaRoomPlanPayment(reference);
    else if (payment.status === "REVERSED") await turso("UPDATE cinema_room_plan_orders SET status='REVIEW',updated_at=? WHERE reference=? AND status='PENDING'", [new Date().toISOString(), reference]);
  } catch (error) {
    if (!(error instanceof PaystackTransactionNotFound)) throw error;
    if (!order.checkout_url) await expireMissingCinemaRoomPlanCheckout(reference);
  }
  const latest = rowsToObjects(await turso("SELECT status,plan,valid_until FROM cinema_room_plan_orders WHERE reference=? LIMIT 1", [reference]))[0];
  return { status: String(latest.status), plan: String(latest.plan), validUntil: String(latest.valid_until || "") };
}
