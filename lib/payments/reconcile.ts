import { rowsToObjects, turso, tursoTransaction, isTursoConfiguredRuntime } from "@/lib/turso";
import { readPaystackPage, verifyPaystackTransaction, verifyPaystackTransfer } from "@/lib/paystack";
import { ensureFinanceSchema } from "@/lib/payments/schema";
import { installFinancialCapture, drainFinancialOutbox } from "@/lib/payments/accounting";
import { processPaystackEvent } from "@/lib/payments/paystack-events";
import { drainPaymentInbox } from "@/lib/payments/inbox";

export async function recordReconciliation(input:{id:string;reference:string;kind:string;expected:number|null;observed:number|null;currency:string;status:string;details:string}) {
  const now=new Date().toISOString();
  await turso(`INSERT INTO finance_reconciliation(id,reference,kind,expected,observed,currency,status,details,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET expected=excluded.expected,observed=excluded.observed,
    status=excluded.status,details=excluded.details,updated_at=excluded.updated_at`,
    [input.id,input.reference,input.kind,input.expected,input.observed,input.currency,input.status,input.details,now,now]);
}

export async function reconcilePaymentReference(reference:string) {
  await ensureFinanceSchema();
  const payment=await verifyPaystackTransaction(reference);
  const attempt=rowsToObjects(await turso('SELECT amount,currency FROM payment_attempts WHERE reference=?',[reference]))[0];
  const mismatch=attempt && (Number(attempt.amount)!==payment.amount || attempt.currency!==payment.currency);
  const success=payment.status==='SUCCESSFUL';
  await recordReconciliation({id:`charge:${reference}`,reference,kind:'CHARGE',expected:attempt?Number(attempt.amount):null,
    observed:payment.amount,currency:payment.currency,status:mismatch?'MISMATCH':success?'VERIFIED':payment.status,
    details:JSON.stringify({providerStatus:payment.status,fees:payment.fees,transactionId:payment.financialTransactionId})});
  if(success || payment.status==='FAILED') {
    const result=await processPaystackEvent({event:success?'charge.success':'charge.failed',data:{reference,amount:payment.amount,currency:payment.currency,status:success?'success':'failed',fees:payment.fees}});
    await turso("UPDATE payment_attempts SET state=?,updated_at=? WHERE reference=? AND state!='SUCCESSFUL'",[mismatch?'REVIEW':payment.status,new Date().toISOString(),reference]);
    return result;
  }
  return {handled:true,status:'PENDING'};
}

export async function reconcileUnknownOperations(limit=2) {
  await ensureFinanceSchema();
  const cutoff=new Date(Date.now()-2*60_000).toISOString();
  const rows=rowsToObjects(await turso("SELECT * FROM provider_operations WHERE state IN ('STARTED','UNKNOWN') AND updated_at<? ORDER BY updated_at LIMIT ?",[cutoff,Math.min(10,Math.max(1,limit))]));
  let resolved=0;
  for(const row of rows) {
    try {
      if(row.kind==='INITIALIZE') {
        const result=await reconcilePaymentReference(String(row.reference));
        if(('status' in result && result.status==='PENDING') || !result.handled) continue;
        // Verification result is not an authorization URL; don't replay it as initialization.
        await recordReconciliation({id:`operation:${row.id}`,reference:String(row.reference),kind:'INITIALIZE',expected:null,observed:null,currency:'GHS',status:'VERIFIED',details:'Charge outcome recovered; the original checkout must not be restarted.'});
        await turso("UPDATE provider_operations SET state='COMPLETE',result=?,updated_at=? WHERE id=?",[JSON.stringify({authorizationUrl:'',reference:row.reference,recovered:true}),new Date().toISOString(),String(row.id)]);
      } else if(row.kind==='TRANSFER') {
        const transfer=await verifyPaystackTransfer(String(row.reference));
        if(!['SUCCESS','FAILED','REVERSED'].includes(transfer.status)) continue;
        await processPaystackEvent({event:transfer.status==='SUCCESS'?'transfer.success':transfer.status==='REVERSED'?'transfer.reversed':'transfer.failed',data:{reference:String(row.reference),amount:transfer.amount,status:transfer.rawStatus,transfer_code:transfer.transferCode}});
        await turso("UPDATE provider_operations SET state='COMPLETE',result=?,updated_at=? WHERE id=?",[JSON.stringify(transfer),new Date().toISOString(),String(row.id)]);
      } else if(row.kind==='REFUND') {
        const reference=String(row.reference);
        const campus=rowsToObjects(await turso('SELECT payment_reference AS charge_reference,amount FROM campus_refunds WHERE id=?',[reference]))[0];
        const hostel=campus?null:rowsToObjects(await turso('SELECT reference AS charge_reference,amount FROM hostel_refunds WHERE id=?',[reference]))[0];
        const refund=campus||hostel;
        if(!refund) continue;
        const matched=await reconcileUnknownRefund(reference,String(refund.charge_reference),Number(refund.amount));
        if(!matched.matched) continue;
      } else {
        continue;
      }
      resolved++;
    } catch {
      await recordReconciliation({id:`operation:${row.id}`,reference:String(row.reference),kind:String(row.kind),expected:null,observed:null,currency:'GHS',status:'REVIEW',details:'Provider verification is unavailable or the reference is not yet visible. No second request was sent.'});
    } finally {
      await turso('UPDATE provider_operations SET updated_at=? WHERE id=?',[new Date().toISOString(),String(row.id)]);
    }
  }
  return {checked:rows.length,resolved};
}

/** One page per invocation. A partial page is never reported as reconciled. */
export async function reconcileSettlementPage(settlementId:string,page=1) {
  if(!/^[0-9]+$/.test(settlementId) || !Number.isSafeInteger(page) || page<1) throw new Error('Invalid settlement page.');
  await ensureFinanceSchema();
  const result=await readPaystackPage(`settlement/${settlementId}/transactions`,{page:String(page),perPage:'25'});
  let mismatches=0;
  for(const item of result.rows) {
    const reference=String(item.reference||'');
    const local=rowsToObjects(await turso('SELECT amount,currency FROM payment_attempts WHERE reference=?',[reference]))[0];
    const observed=Number(item.amount);
    const matches=Boolean(local && Number(local.amount)===observed && local.currency===item.currency);
    if(!matches) mismatches++;
    await recordReconciliation({id:`settlement:${settlementId}:${reference}`,reference,kind:'SETTLEMENT_TRANSACTION',expected:local?Number(local.amount):null,observed,currency:String(item.currency||''),status:matches?'MATCHED':'REVIEW',details:JSON.stringify({settlementId,fees:item.fees??null,page})});
  }
  const hasMore=result.meta?.pageCount ? page<result.meta.pageCount : result.rows.length===25;
  await recordReconciliation({id:`settlement-page:${settlementId}:${page}`,reference:settlementId,kind:'SETTLEMENT_PAGE',expected:result.rows.length,observed:result.rows.length-mismatches,currency:'GHS',status:mismatches?'REVIEW':'MATCHED',details:JSON.stringify({page,hasMore,nextPage:hasMore?page+1:null})});
  return {checked:result.rows.length,mismatches,nextPage:hasMore?page+1:null};
}

export async function runFinanceMaintenance() {
  if(!await isTursoConfiguredRuntime()) return {configured:false};
  await installFinancialCapture();
  const accounting=await drainFinancialOutbox(4);
  const inbox=await drainPaymentInbox(1);
  const operations=await reconcileUnknownOperations(1);
  const pending=rowsToObjects(await turso("SELECT reference FROM payment_attempts WHERE state IN ('CREATED','PENDING') AND updated_at<? ORDER BY updated_at LIMIT 1",[new Date(Date.now()-5*60_000).toISOString()]));
  for(const row of pending) {
    try { await reconcilePaymentReference(String(row.reference)); }
    catch { /* Kept for the next pass. */ }
    await turso('UPDATE payment_attempts SET updated_at=? WHERE reference=?',[new Date().toISOString(),String(row.reference)]);
  }
  return {configured:true,accounting,inbox,operations};
}

export async function replayFinanceItem(kind:'INBOX'|'OUTBOX',id:string,actor:string,reason:string) {
  if(reason.trim().length<8) throw new Error('Give a reason of at least eight characters.');
  await ensureFinanceSchema();
  const now=new Date().toISOString();
  const statement=kind==='INBOX'
    ? {sql:"UPDATE payment_inbox SET status='PENDING',attempts=0,available_at=?,lease_token=NULL,lease_until=NULL WHERE id=? AND status='REVIEW'",args:[now,id]}
    : {sql:"UPDATE financial_outbox SET state='PENDING',error=NULL WHERE sequence=? AND state='REVIEW'",args:[id]};
  const result=await tursoTransaction([
    statement,
    {sql:"INSERT INTO finance_audit(id,actor,action,target,reason,created_at) SELECT ?,?,?,?,?,? WHERE changes()=1",args:[crypto.randomUUID(),actor,`REPLAY_${kind}`,id,reason.trim(),now]},
  ]);
  if(!Number(result[0].affected_row_count)) throw new Error('Only items awaiting review can be replayed.');
}

/** Find the provider's refund by our unique merchant note. An absence is still
 * uncertain; it never authorizes submitting a second refund. */
export async function reconcileUnknownRefund(operationId:string,transactionReference:string,expectedAmount:number) {
  await ensureFinanceSchema();
  const operation=rowsToObjects(await turso('SELECT * FROM provider_operations WHERE id=?',[`PAYSTACK:REFUND:${operationId}`]))[0];
  if(!operation || operation.state!=='UNKNOWN') throw new Error('There is no uncertain refund with this identifier.');
  const charge=await verifyPaystackTransaction(transactionReference);
  if(!charge.financialTransactionId) throw new Error('The original charge is not verified.');
  const list=await readPaystackPage('refund',{transaction:charge.financialTransactionId,perPage:'50',page:'1'});
  const matches=list.rows.filter(row=>String(row.merchant_note||'').includes(`[UMX:${operationId}]`) && Number(row.amount)===expectedAmount);
  if(matches.length!==1) {
    await recordReconciliation({id:`operation:${operation.id}`,reference:transactionReference,kind:'REFUND_UNKNOWN',expected:expectedAmount,observed:matches.length?Number(matches[0].amount):null,currency:charge.currency,status:'REVIEW',details:matches.length?'Multiple matching refunds need investigation.':'No exact provider match yet; do not submit another refund.'});
    return {matched:false};
  }
  const refund=matches[0];
  const refundReference=String(refund.reference||'');
  if(!refundReference) throw new Error('Provider refund has no reference.');
  const status=String(refund.status||'').toLowerCase();
  const data={reference:refundReference,amount:expectedAmount,status};
  const target=String(operationId);
  await turso('UPDATE campus_refunds SET paystack_reference=? WHERE id=? AND COALESCE(paystack_reference,\'\')=\'\'',[refundReference,target]);
  await turso('UPDATE hostel_refunds SET paystack_reference=? WHERE id=? AND COALESCE(paystack_reference,\'\')=\'\'',[refundReference,target]);
  const event=status==='processed'?'refund.processed':status==='failed'?'refund.failed':'refund.pending';
  const applied=await processPaystackEvent({event,data});
  if(!applied.handled) throw new Error('Refund does not match a product record.');
  await turso("UPDATE provider_operations SET state='COMPLETE',result=?,updated_at=? WHERE id=?",[JSON.stringify({refundReference,status}),new Date().toISOString(),String(operation.id)]);
  await recordReconciliation({id:`operation:${operation.id}`,reference:transactionReference,kind:'REFUND',expected:expectedAmount,observed:expectedAmount,currency:charge.currency,status:'MATCHED',details:JSON.stringify({refundReference,status})});
  return {matched:true,refundReference,status};
}
