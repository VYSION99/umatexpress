import { rowsToObjects, turso, tursoTransaction } from "@/lib/turso";
import { ensureFinanceSchema } from "@/lib/payments/schema";

type Row = Record<string, unknown>;
type Balances = Record<string, number>;
const SOURCES: Record<string, string[]> = {
  payments: ['id','reference_id','status','amount','currency','booking_id','fare_amount','fee_amount'],
  campus_payments: ['id','reference','status','amount','currency','fare_amount','commission_amount','net_amount','queue_entry_id','paystack_fee_actual'],
  hostel_bookings: ['id','reference','status','total_amount','price','utilities_fee','landlord_id','commission_amount','net_amount','paid_at'],
  hostel_plugin_subscriptions: ['id','reference','status','platform_price','checkout_amount','landlord_id','paid_at'],
  organizer_payouts: ['id','status','organizer_id','gross_amount','commission_amount','net_amount','batch_id','released_at','transferred_at'],
  hostel_payouts: ['id','status','landlord_id','gross_amount','commission_amount','net_amount','batch_id','released_at'],
  organizer_payout_batches: ['id','status','mode','total_amount','transfer_fee','transfer_reference'],
  hostel_payout_batches: ['id','status','mode','total_amount','transfer_fee','transfer_reference'],
  campus_refunds: ['id','status','amount','payment_reference','paystack_reference'],
  hostel_refunds: ['id','status','amount','reference','paystack_reference'],
};

/** Installing a trigger and snapshotting existing rows commit together. Every
 * subsequent mutation produces an outbox event in the same source transaction. */
export async function installFinancialCapture() {
  await ensureFinanceSchema();
  const tables = new Set(rowsToObjects(await turso("SELECT name FROM sqlite_master WHERE type='table'")).map(row=>String(row.name)));
  const installed = new Set(rowsToObjects(await turso('SELECT source FROM finance_capture_sources')).map(row=>String(row.source)));
  const triggers = new Map(rowsToObjects(await turso("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'finance_%_insert'")).map(row=>[String(row.name),String(row.sql)]));
  let count = 0;
  for (const [table, selected] of Object.entries(SOURCES)) {
    if (!tables.has(table)) continue;
    const columns = new Set(rowsToObjects(await turso(`PRAGMA table_info(${table})`)).map(row=>String(row.name)));
    const fields = selected.filter(column=>columns.has(column));
    const previous = triggers.get(`finance_${table}_insert`) || "";
    const refresh = installed.has(table) && fields.some(column=>!previous.includes(`'${column}'`));
    if (installed.has(table) && !refresh) continue;
    const payload = (prefix: string) => `json_object(${fields.map(column=>`'${column}',${prefix}${column}`).join(',')})`;
    await tursoTransaction([
      {sql:`INSERT INTO finance_capture_sources(source,installed_at) VALUES (?,?) ON CONFLICT DO NOTHING`,args:[table,new Date().toISOString()]},
      {sql:`INSERT INTO financial_outbox(source,source_id,payload) SELECT '${table}',id,${payload('')} FROM ${table}
        ${refresh?'':`WHERE NOT EXISTS(SELECT 1 FROM financial_outbox WHERE source='${table}' AND source_id=${table}.id)`}`,args:[]},
      ...(refresh ? ['INSERT','UPDATE'].map(operation=>({sql:`DROP TRIGGER IF EXISTS finance_${table}_${operation.toLowerCase()}`,args:[]})) : []),
      ...['INSERT','UPDATE'].map(operation=>({sql:`CREATE TRIGGER IF NOT EXISTS finance_${table}_${operation.toLowerCase()} AFTER ${operation} ON ${table}
        BEGIN INSERT INTO financial_outbox(source,source_id,payload) VALUES ('${table}',NEW.id,${payload('NEW.')}); END`,args:[]})),
      {sql:`CREATE TRIGGER IF NOT EXISTS finance_${table}_no_delete BEFORE DELETE ON ${table}
        WHEN EXISTS(SELECT 1 FROM financial_outbox WHERE source='${table}' AND source_id=OLD.id
          AND json_extract(payload,'$.status') IN ('SUCCESSFUL','PAID_REVIEW','PAID','ACTIVE','ACCRUED','RELEASED','SUCCESS','RECORDED','APPROVED'))
        BEGIN SELECT RAISE(ABORT,'FINANCIAL_HISTORY_MUST_BE_RETAINED'); END`,args:[]},
    ]);
    count++;
  }
  return { installed: count };
}

function money(value: unknown) {
  const amount = Number(value || 0);
  if (!Number.isSafeInteger(amount) || amount<0) throw new Error('INVALID_MINOR_UNITS');
  return amount;
}

/** Desired accounting position of one source. Delta journals preserve every
 * intermediate transition; historical balances are never overwritten. */
export function sourceBalances(source: string, row: Row, previous: Balances = {}): Balances {
  const result: Balances = {};
  const add = (account: string, amount: number) => { if (amount) result[account]=(result[account]||0)+amount; };
  const state = String(row.status);
  const currency = String(row.currency || 'GHS');
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('INVALID_CURRENCY');
  const customer = `customer_funds:${currency}`;
  const provider = `provider_clearing:${currency}`;
  if (['payments','campus_payments','hostel_bookings','hostel_plugin_subscriptions'].includes(source)) {
    const received = ['SUCCESSFUL','PAID_REVIEW','PAID','PAYMENT_REVIEW','ACTIVE'].includes(state) || Boolean(row.paid_at);
    if (!received) return previous; // Cancellation/failure does not undo a receipt.
    const amount = money(row.amount ?? row.total_amount ?? row.checkout_amount ?? row.platform_price);
    add(provider,amount); add(customer,-amount);
    const recovered = source==='payments' ? money(row.fee_amount)
      : source==='campus_payments' ? Math.max(0, amount-money(row.fare_amount))
      : source==='hostel_bookings' && row.price!==undefined && row.utilities_fee!==undefined ? Math.max(0, amount-money(row.price)-money(row.utilities_fee)) : 0;
    if (recovered && ['SUCCESSFUL','PAID'].includes(state)) {
      add(customer,recovered); add(`processing_fee_recovery:${currency}`,-recovered);
    }
    const fee = money(row.paystack_fee_actual);
    add(`provider_fees:${currency}`,fee); add(provider,-fee);
    if (source==='hostel_plugin_subscriptions' && state==='ACTIVE') { const base=money(row.platform_price); add(customer,amount); add(`service_revenue:${currency}`,-base); add(`processing_fee_recovery:${currency}`,-(amount-base)); }
    if (source==='campus_payments' && state==='SUCCESSFUL') {
      const net=money(row.net_amount), commission=money(row.commission_amount), fare=money(row.fare_amount);
      if (net+commission!==fare) throw new Error('COMMISSION_SNAPSHOT_MISMATCH');
      add(customer,fare); add(`commission_revenue:${currency}`,-commission);
      add(`seller_pending:campus:${String(row.queue_entry_id)}:${currency}`,-net);
    }
    return result;
  }
  if (source==='organizer_payouts' || source==='hostel_payouts') {
    const gross=money(row.gross_amount), net=money(row.net_amount), commission=money(row.commission_amount);
    if (gross!==net+commission) throw new Error('COMMISSION_SNAPSHOT_MISMATCH');
    const seller=`${source==='hostel_payouts'?'hostel':'vacation'}:${String(row.landlord_id || row.organizer_id)}:${currency}`;
    if (state==='DEBT' || (state==='REVERSED' && row.released_at)) {
      add(`seller_receivable:${seller}`,net); add(`payout_clearing:${currency}`,-net);
      return result;
    }
    if (state==='REVERSED') return result;
    add(customer,gross); add(`commission_revenue:${currency}`,-commission);
    if (state==='RELEASED') add(`payout_clearing:${currency}`,-net);
    else add(`${state==='PROCESSING'?'seller_reserved':'seller_pending'}:${seller}`,-net);
    return result;
  }
  if (source.endsWith('_payout_batches')) {
    if (['SUCCESS','RELEASED','RECORDED'].includes(state)) {
      const amount=money(row.total_amount);
      add(`payout_clearing:${currency}`,amount);
      add(row.mode==='MANUAL'?`manual_disbursements:${currency}`:provider,-amount);
    }
    return result;
  }
  if (source.endsWith('_refunds')) {
    if (state==='APPROVED' || state==='PAID') {
      const amount=money(row.amount);
      add(customer,amount);
      add(state==='PAID'?provider:`refunds_reserved:${currency}`,-amount);
    }
    return result;
  }
  throw new Error('UNSUPPORTED_FINANCIAL_SOURCE');
}

export async function projectFinancialEvent(row: Row) {
  const sequence = Number(row.sequence);
  const source=String(row.source), sourceId=String(row.source_id);
  const current=rowsToObjects(await turso('SELECT sequence,balances FROM financial_snapshots WHERE source=? AND source_id=?',[source,sourceId]))[0];
  if (current && Number(current.sequence)>=sequence) {
    await turso("UPDATE financial_outbox SET state='PROCESSED' WHERE sequence=?",[sequence]); return;
  }
  const previous: Balances = current ? JSON.parse(String(current.balances)) : {};
  const payload=JSON.parse(String(row.payload)) as Row;
  const desired=sourceBalances(source,payload,previous);
  const accounts=new Set([...Object.keys(previous),...Object.keys(desired)]);
  const delta=[...accounts].map(account=>({account,amount:(desired[account]||0)-(previous[account]||0)})).filter(line=>line.amount!==0);
  if (delta.some(line=>!Number.isSafeInteger(line.amount)) || delta.reduce((sum,line)=>sum+line.amount,0)!==0) throw new Error('UNBALANCED_JOURNAL');
  const now=new Date().toISOString();
  const id=`event:${sequence}`;
  await tursoTransaction([
    {sql:`INSERT INTO ledger_journals(id,source,source_id,currency,previous_sequence,created_at) VALUES (?,?,?,?,?,?)`,args:[id,source,sourceId,String(payload.currency||'GHS'),Number(current?.sequence||0),now]},
    ...delta.map(line=>({sql:'INSERT INTO ledger_lines(journal_id,account,amount) VALUES (?,?,?)',args:[id,line.account,line.amount]})),
    {sql:'UPDATE ledger_journals SET posted=1 WHERE id=?',args:[id]},
    {sql:`INSERT INTO financial_snapshots(source,source_id,sequence,balances) VALUES (?,?,?,?) ON CONFLICT(source,source_id)
      DO UPDATE SET sequence=excluded.sequence,balances=excluded.balances`,args:[source,sourceId,sequence,JSON.stringify(desired)]},
    {sql:"UPDATE financial_outbox SET state='PROCESSED',error=NULL,processed_at=? WHERE sequence=?",args:[now,sequence]},
  ]);
}

export async function drainFinancialOutbox(limit=20) {
  await ensureFinanceSchema();
  // A failed earlier snapshot blocks later snapshots for that same source.
  const rows=rowsToObjects(await turso(`SELECT * FROM financial_outbox e WHERE state='PENDING'
    AND NOT EXISTS(SELECT 1 FROM financial_outbox p WHERE p.source=e.source AND p.source_id=e.source_id AND p.sequence<e.sequence AND p.state!='PROCESSED')
    ORDER BY sequence LIMIT ?`,[Math.max(1,Math.min(100,limit))]));
  let processed=0,failed=0;
  for(const row of rows) {
    try { await projectFinancialEvent(row); processed++; }
    catch(error) {
      // Competing workers may have posted this sequence already.
      const journal=rowsToObjects(await turso('SELECT posted FROM ledger_journals WHERE id=?',[`event:${row.sequence}`]))[0];
      if(journal?.posted) { processed++; continue; }
      failed++;
      await turso("UPDATE financial_outbox SET state='REVIEW',error=? WHERE sequence=? AND state!='PROCESSED'",[error instanceof Error && /^(INVALID_|COMMISSION_|UNBALANCED_|UNSUPPORTED_)/.test(error.message)?error.message:'PROJECTION_FAILED',Number(row.sequence)]);
    }
  }
  return {processed,failed};
}
