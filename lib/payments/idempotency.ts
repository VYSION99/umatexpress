import { CampusEngineError } from "@/lib/campus-engine/errors";
import { rowsToObjects, turso } from "@/lib/turso";
import { ensureFinanceSchema } from "@/lib/payments/schema";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([key,item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export async function fingerprint(value: unknown) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2,'0')).join('');
}

/** A lost worker never authorizes a second execution: ambiguous requests need review. */
export async function idempotentCheckout(request: Request, actor: string, scope: string, run: () => Promise<Response>) {
  const body = await request.clone().json();
  const hash = await fingerprint(body);
  const key = request.headers.get('Idempotency-Key') || hash;
  if (!/^[a-zA-Z0-9:_-]{8,160}$/.test(key)) throw new CampusEngineError('VALIDATION_ERROR','Invalid checkout request key.',400);
  await ensureFinanceSchema();
  const now = new Date().toISOString();
  const claimed = await turso(`INSERT INTO checkout_requests(scope,actor,request_key,fingerprint,status,created_at,updated_at)
    VALUES (?,?,?,?,'STARTED',?,?) ON CONFLICT DO NOTHING`, [scope,actor,key,hash,now,now]);
  if (!Number(claimed.affected_row_count)) {
    const row = rowsToObjects(await turso('SELECT * FROM checkout_requests WHERE scope=? AND actor=? AND request_key=?',[scope,actor,key]))[0];
    if (!row || row.fingerprint !== hash) throw new CampusEngineError('CONFLICT','This checkout key belongs to a different request.',409);
    if (row.status === 'COMPLETE') return Response.json(JSON.parse(String(row.response)), { status:Number(row.response_status),headers:{'Cache-Control':'no-store','Idempotent-Replayed':'true'} });
    return Response.json({ error:'This checkout is being checked. Open your bookings before starting another payment.', code:'PAYMENT_OUTCOME_PENDING' },{status:409,headers:{'Cache-Control':'no-store','Retry-After':'30'}});
  }
  try {
    const response = await run();
    const result = await response.clone().json();
    // No session cookies or payment bearer tokens are stored or replayed. All
    // these routes require an account, which owns the resulting booking.
    await turso(`UPDATE checkout_requests SET status=?,response=?,response_status=?,updated_at=? WHERE scope=? AND actor=? AND request_key=?`,
      [response.status >= 500 ? 'REVIEW' : 'COMPLETE',JSON.stringify(result),response.status,new Date().toISOString(),scope,actor,key]);
    return response;
  } catch (error) {
    await turso("UPDATE checkout_requests SET status='REVIEW',updated_at=? WHERE scope=? AND actor=? AND request_key=?",[new Date().toISOString(),scope,actor,key]);
    throw error;
  }
}
