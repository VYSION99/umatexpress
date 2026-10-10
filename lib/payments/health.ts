import { rowsToObjects, turso } from "@/lib/turso";

export type FinanceAlert = { id: string; severity: "critical" | "warning"; title: string; count: number; oldestAt: string; detail: string };

/** Counts use the whole queue, independently of the desk's paginated samples. */
export async function paymentHealth(now = new Date()) {
  const tables = new Set(rowsToObjects(await turso("SELECT name FROM sqlite_master WHERE type='table'")).map(row => String(row.name)));
  const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
  const definitions: Array<Omit<FinanceAlert, "count" | "oldestAt"> & { table: string; date: string; where: string; args?: string[] }> = [
    { id: "webhook-review", severity: "critical", title: "Webhook events need review", detail: "Automatic processing stopped. Review the event before retrying.", table: "payment_inbox", date: "received_at", where: "status='REVIEW'" },
    { id: "webhook-delayed", severity: "warning", title: "Webhook processing is delayed", detail: "These stored events have waited more than five minutes.", table: "payment_inbox", date: "received_at", where: "status IN ('PENDING','PROCESSING') AND received_at<?", args: [minutesAgo(5)] },
    { id: "accounting-review", severity: "critical", title: "Accounting entries need review", detail: "These entries have not been posted to the ledger.", table: "financial_outbox", date: "created_at", where: "state='REVIEW'" },
    { id: "accounting-delayed", severity: "warning", title: "Accounting processing is delayed", detail: "Pending entries have waited more than fifteen minutes.", table: "financial_outbox", date: "created_at", where: "state='PENDING' AND created_at<?", args: [minutesAgo(15)] },
    { id: "provider-unknown", severity: "critical", title: "Provider outcomes are uncertain", detail: "Verify these charges, refunds, or transfers before making another request.", table: "provider_operations", date: "created_at", where: "state='UNKNOWN' OR (state='STARTED' AND created_at<?)", args: [minutesAgo(5)] },
    { id: "reconciliation-review", severity: "critical", title: "Reconciliation differences need review", detail: "Check mismatches and reversals against the provider and existing refunds.", table: "finance_reconciliation", date: "created_at", where: "status IN ('REVIEW','MISMATCH','REVERSED')" },
    { id: "checkout-recovery", severity: "warning", title: "Checkouts need recovery", detail: "These checkout requests need review or have been incomplete for five minutes.", table: "checkout_requests", date: "created_at", where: "status='REVIEW' OR (status='STARTED' AND created_at<?)", args: [minutesAgo(5)] },
  ];
  for (const [table, product, pending, review] of [
    ["payments", "Vacation ride", "PENDING", "PAID_REVIEW"],
    ["campus_payments", "Campus ride", "PENDING", "PAID_REVIEW"],
    ["hostel_bookings", "Hostel", "PENDING_PAYMENT", "PAYMENT_REVIEW"],
    ["hostel_plugin_subscriptions", "Hostel service", "PENDING_PAYMENT", "PAYMENT_REVIEW"],
  ]) {
    definitions.push(
      { id: `${table}-stuck`, severity: "warning", title: `${product} payments are overdue`, detail: "Payment has been pending for more than fifteen minutes. Verify the existing reference.", table, date: "created_at", where: "status=? AND created_at<?", args: [pending, minutesAgo(15)] },
      { id: `${table}-review`, severity: "critical", title: `${product} payments need review`, detail: "A payment, amount, currency, or reservation issue requires attention.", table, date: "created_at", where: "status IN (?, 'REVERSAL_REVIEW')", args: [review] },
    );
  }
  const refunds = [["campus_refunds", "Campus ride"], ["hostel_refunds", "Hostel"]] as const;
  for (const [table, product] of refunds) definitions.push({
    id: `${table}-delayed`, severity: "warning", title: `${product} refunds need attention`, detail: "A refund failed or has remained approved for more than 24 hours. Verify it before resubmitting.",
    table, date: "updated_at", where: "status='FAILED' OR (status='APPROVED' AND updated_at<?)", args: [minutesAgo(24 * 60)],
  });
  const available = definitions.filter(item => tables.has(item.table));
  const rows = available.length ? rowsToObjects(await turso(available.map(item => `SELECT '${item.id}' AS id,COUNT(*) AS count,MIN(${item.date}) AS oldest FROM ${item.table} WHERE ${item.where}`).join(" UNION ALL "), available.flatMap(item => item.args || []))) : [];
  const alerts: FinanceAlert[] = available.flatMap(({ id, severity, title, detail }) => {
    const row = rows.find(item => item.id === id);
    return row && Number(row.count) > 0 ? [{ id, severity, title, detail, count: Number(row.count), oldestAt: String(row.oldest || "") }] : [];
  });
  const refundTables = refunds.filter(([table]) => tables.has(table));
  const pendingRefunds = refundTables.length ? rowsToObjects(await turso(refundTables.map(([table, product]) => `SELECT '${product}' AS service,id,${table === "campus_refunds" ? "payment_reference" : "reference"} AS reference,amount,status,updated_at FROM ${table} WHERE status IN ('APPROVED','FAILED')`).join(" UNION ALL ") + " ORDER BY updated_at LIMIT 50")) : [];
  return { alerts, pendingRefunds, checkedAt: now.toISOString() };
}
