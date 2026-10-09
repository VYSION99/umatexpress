import { rowsToObjects, turso, tursoTransaction } from "@/lib/turso";

/** A provider reversal after a successful transfer restores the unpaid balance.
 * The original release journal remains immutable; financial capture posts the
 * compensating transition in a new journal. */
export async function reverseSettledTransfer(product:'ORGANIZER'|'HOSTEL',batchId:string) {
  const batchTable=product==='ORGANIZER'?'organizer_payout_batches':'hostel_payout_batches';
  const entryTable=product==='ORGANIZER'?'organizer_payouts':'hostel_payouts';
  const success=product==='ORGANIZER'?'SUCCESS':'RELEASED';
  const now=new Date().toISOString();
  const result=await tursoTransaction([
    {sql:`UPDATE ${batchTable} SET status='REVERSED',reason='PROVIDER_TRANSFER_REVERSED',updated_at=? WHERE id=? AND status=?`,args:[now,batchId,success]},
    {sql:`UPDATE ${entryTable} SET status=CASE WHEN status='DEBT' THEN 'REVERSED' ELSE 'ACCRUED' END,
      batch_id='',transfer_reference='',released_at=NULL,updated_at=? WHERE batch_id=? AND status IN ('RELEASED','DEBT') AND
      EXISTS(SELECT 1 FROM ${batchTable} WHERE id=? AND status='REVERSED')`,args:[now,batchId,batchId]},
  ]);
  return Number(result[0].affected_row_count||0)>0;
}

export async function transferReversalByReference(product:'ORGANIZER'|'HOSTEL',reference:string,transferCode:string) {
  const table=product==='ORGANIZER'?'organizer_payout_batches':'hostel_payout_batches';
  const batch=rowsToObjects(await turso(`SELECT id FROM ${table} WHERE (transfer_reference=? AND transfer_reference!='') OR (transfer_code=? AND transfer_code!='') LIMIT 1`,[reference,transferCode]))[0];
  if(!batch) return false;
  return reverseSettledTransfer(product,String(batch.id));
}
