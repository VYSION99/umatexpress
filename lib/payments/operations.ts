import { installFinancialCapture } from "@/lib/payments/accounting";
import { rowsToObjects, turso } from "@/lib/turso";
import { ensureFinanceSchema } from "@/lib/payments/schema";
import { fingerprint } from "@/lib/payments/idempotency";

export class ProviderOutcomeUnknown extends Error {
  constructor(public reference: string) { super('Provider outcome is pending verification. Do not submit another payment.'); }
}
export class ProviderRejected extends Error {}
export function isProviderOutcomeUnknown(error: unknown) { return error instanceof ProviderOutcomeUnknown; }

/** Persist before sending. An uncertain operation can be verified, never blindly resent. */
export async function providerOperation<T>(kind: string, reference: string, input: unknown, send: () => Promise<T>): Promise<T> {
  await ensureFinanceSchema();
  if (kind !== "INITIALIZE") await installFinancialCapture();
  const id = `PAYSTACK:${kind}:${reference}`;
  const hash = await fingerprint(input);
  const now = new Date().toISOString();
  const claimed = await turso(`INSERT INTO provider_operations(id,kind,reference,fingerprint,state,created_at,updated_at)
    VALUES (?,?,?,?,'STARTED',?,?) ON CONFLICT DO NOTHING`,[id,kind,reference,hash,now,now]);
  if (!Number(claimed.affected_row_count)) {
    const row = rowsToObjects(await turso('SELECT * FROM provider_operations WHERE id=?',[id]))[0];
    if (!row || row.fingerprint !== hash) throw new ProviderRejected('Operation key reused with different payment details.');
    if (row.state === 'COMPLETE') return JSON.parse(String(row.result)) as T;
    if (row.state === 'REJECTED') throw new ProviderRejected('Provider previously rejected this operation.');
    throw new ProviderOutcomeUnknown(reference);
  }
  try {
    const result = await send();
    await turso("UPDATE provider_operations SET state='COMPLETE',result=?,updated_at=? WHERE id=?",[JSON.stringify(result),new Date().toISOString(),id]);
    return result;
  } catch (error) {
    const rejected = error instanceof ProviderRejected;
    await turso('UPDATE provider_operations SET state=?,updated_at=? WHERE id=?',[rejected?'REJECTED':'UNKNOWN',new Date().toISOString(),id]).catch(()=>undefined);
    if (rejected) throw error;
    throw new ProviderOutcomeUnknown(reference);
  }
}
