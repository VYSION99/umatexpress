import { installFinancialCapture } from "@/lib/payments/accounting";
import { rowsToObjects, tursoTransaction, turso } from "@/lib/turso";
import { ensureFinanceSchema } from "@/lib/payments/schema";

export async function registerPaymentAttempt(input: { reference: string; email: string; amount: number; metadata: Record<string,string|number> }, currency: string) {
  if (!Number.isSafeInteger(input.amount) || input.amount<=0 || !/^[A-Z]{3}$/.test(currency)) throw new Error('Invalid payment amount or currency.');
  await ensureFinanceSchema();
  await installFinancialCapture();
  const product = String(input.metadata.purpose || input.metadata.module || 'VACATION');
  const order = String(input.metadata.bookingReference || input.metadata.queueReference || input.metadata.reference || input.reference);
  const id = `${product}:${order}`;
  const now = new Date().toISOString();
  await tursoTransaction([
    { sql:`INSERT INTO payment_intents(id,product,order_reference,customer,amount,currency,created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`, args:[id,product,order,input.email,input.amount,currency,now] },
    { sql:`INSERT INTO payment_attempts(reference,intent_id,provider,state,amount,currency,updated_at) VALUES (?,?,'PAYSTACK','CREATED',?,?,?) ON CONFLICT DO NOTHING`,args:[input.reference,id,input.amount,currency,now] },
  ]);
  const saved = rowsToObjects(await turso('SELECT i.customer,i.amount,i.currency,a.intent_id FROM payment_intents i JOIN payment_attempts a ON a.intent_id=i.id WHERE a.reference=?',[input.reference]))[0];
  if (!saved || saved.intent_id!==id || saved.customer!==input.email || Number(saved.amount)!==input.amount || saved.currency!==currency) throw new Error('Payment intent does not match the checkout.');
}
