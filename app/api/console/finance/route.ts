import { requireConsoleRole } from "@/lib/console-auth";
import { campusErrorPayload, CampusEngineError } from "@/lib/campus-engine/errors";
import { rowsToObjects, turso } from "@/lib/turso";
import { ensureFinanceSchema } from "@/lib/payments/schema";
import { replayFinanceItem, reconcilePaymentReference, reconcileSettlementPage, runFinanceMaintenance } from "@/lib/payments/reconcile";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { consoleAudit } from "@/lib/console-audit";

import { paymentHealth } from "@/lib/payments/health";

const headers={'Cache-Control':'no-store'};
export async function GET(request:Request) {
  try {
    await requireConsoleRole(request,['ADMIN']);
    const limited=await rateLimit(request,'finance-read',{limit:60,windowMs:60_000});
    if(!limited.ok) return rateLimitResponse(limited.retryAfter);
    await ensureFinanceSchema();
    const [balances,events,operations,reconciliation,audit,backlog,checkouts]=await Promise.all([
      turso('SELECT account,SUM(amount) AS balance FROM ledger_lines l JOIN ledger_journals j ON j.id=l.journal_id WHERE j.posted=1 GROUP BY account ORDER BY account LIMIT 500'),
      turso("SELECT sequence,source,source_id,state,error,created_at FROM financial_outbox WHERE state!='PROCESSED' ORDER BY sequence LIMIT 100"),
      turso("SELECT id,kind,reference,state,created_at,updated_at FROM provider_operations WHERE state IN ('STARTED','UNKNOWN') ORDER BY updated_at LIMIT 100"),
      turso("SELECT * FROM finance_reconciliation ORDER BY updated_at DESC LIMIT 100"),
      turso('SELECT * FROM finance_audit ORDER BY created_at DESC LIMIT 50'),
      turso("SELECT state,COUNT(*) AS count,MIN(created_at) AS oldest FROM financial_outbox GROUP BY state"),
      turso("SELECT scope,actor,request_key,status,created_at FROM checkout_requests WHERE status!='COMPLETE' ORDER BY created_at LIMIT 100"),
    ]);
    // The inbox is independently migrated; a fresh finance desk should still load.
    const exists=rowsToObjects(await turso("SELECT name FROM sqlite_master WHERE type='table' AND name='payment_inbox'"));
    const inbox=exists.length?rowsToObjects(await turso("SELECT id,event_type,reference,status,attempts,last_error,received_at FROM payment_inbox WHERE status!='PROCESSED' ORDER BY received_at LIMIT 100")):[];
    const eventRows=rowsToObjects(events),operationRows=rowsToObjects(operations),reconciliationRows=rowsToObjects(reconciliation),checkoutRows=rowsToObjects(checkouts);
    const health = await paymentHealth();
    return Response.json({balances:rowsToObjects(balances),events:eventRows,operations:operationRows,reconciliation:reconciliationRows,audit:rowsToObjects(audit),backlog:rowsToObjects(backlog),checkouts:checkoutRows,inbox,...health},{headers});
  } catch(error) {const result=campusErrorPayload(error);return Response.json({error:result.status<500?result.body.error:'Finance data is unavailable.'},{status:result.status,headers});}
}
export async function POST(request:Request) {
  try {
    const account=await requireConsoleRole(request,['ADMIN']);
    const origin=request.headers.get('origin');
    if(origin && origin!==new URL(request.url).origin) throw new CampusEngineError('FORBIDDEN','Cross-origin finance action refused.',403);
    const limited=await rateLimit(request,'finance-write',{limit:20,windowMs:60_000});
    if(!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body=await request.json() as {action?:string;id?:string;reason?:string;reference?:string;page?:number};
    const reason=String(body.reason||'').trim();
    if(reason.length<8 || reason.length>500) throw new CampusEngineError('VALIDATION_ERROR','Enter a reason between 8 and 500 characters.',400);
    await ensureFinanceSchema();
    let result:unknown;
    if(body.action==='REPLAY_INBOX' || body.action==='REPLAY_OUTBOX') {
      await replayFinanceItem(body.action==='REPLAY_INBOX'?'INBOX':'OUTBOX',String(body.id||''),account.email,reason);
      result={queued:true};
    } else {
      if(!['RECONCILE','SETTLEMENT','MAINTENANCE'].includes(String(body.action))) throw new CampusEngineError('VALIDATION_ERROR','Unknown finance action.',400);
      await consoleAudit({actor:account.email,action:`FINANCE_${body.action}`,targetType:'finance',targetReference:String(body.reference||''),details:{reason,page:body.page}});
      if(body.action==='RECONCILE') result=await reconcilePaymentReference(String(body.reference||''));
      else if(body.action==='SETTLEMENT') result=await reconcileSettlementPage(String(body.reference||''),Number(body.page||1));
      else result=await runFinanceMaintenance();
    }
    return Response.json({ok:true,result},{headers});
  } catch(error) {const result=campusErrorPayload(error);return Response.json({error:result.status<500?result.body.error:'Finance action could not complete. Check the exception list before retrying.'},{status:result.status,headers});}
}
