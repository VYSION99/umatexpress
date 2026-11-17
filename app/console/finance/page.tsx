"use client";

import { useCallback, useEffect, useState } from "react";
import { ConsoleSessionGate, type ConsoleSessionInfo } from "@/components/admin/ConsoleSessionGate";
import { ConsoleShell } from "@/components/console/ConsoleShell";
import "./finance.css";
import { ConsoleUnavailable } from "@/components/console/ConsoleUnavailable";

type Row=Record<string,string|number|null>;
import type { FinanceAlert } from "@/lib/payments/health";
type Data={balances:Row[];events:Row[];operations:Row[];reconciliation:Row[];audit:Row[];backlog:Row[];checkouts:Row[];inbox:Row[];alerts:FinanceAlert[];pendingRefunds:Row[];checkedAt:string};
export default function FinancePage(){return <ConsoleSessionGate label="payment operations">{session=>session.account.role==='ADMIN'?<FinanceDesk session={session}/>:<ConsoleUnavailable session={session} service="finance" label="PAYMENT OPERATIONS" blurb="Payment operations requires administrator access."/>}</ConsoleSessionGate>;}
function FinanceDesk({session}:{session:ConsoleSessionInfo}) {
  const [data,setData]=useState<Data|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
  const [recoveryOpen,setRecoveryOpen]=useState(false);
  const [reason,setReason]=useState(''),[reference,setReference]=useState(''),[page,setPage]=useState(1);
  const load=useCallback(async()=>{
    try{const response=await fetch('/api/console/finance',{credentials:'same-origin',cache:'no-store'});const result=await response.json();if(!response.ok)throw new Error(result.error);setData(result);setError('');}
    catch(error){setError(error instanceof Error?error.message:'Could not load finance data.');}
  },[]);
  useEffect(()=>{
    const controller=new AbortController();
    void fetch('/api/console/finance',{credentials:'same-origin',cache:'no-store',signal:controller.signal})
      .then(async response=>{const result=await response.json();if(!response.ok)throw new Error(result.error);return result;})
      .then(result=>setData(result))
      .catch(error=>{if(!controller.signal.aborted)setError(error instanceof Error?error.message:'Could not load finance data.');});
    return ()=>controller.abort();
  },[]);
  async function act(action:string,id?:string){
    setBusy(true);setError('');setNotice('');
    try{const response=await fetch('/api/console/finance',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({action,id,reason,reference,page})});const result=await response.json();if(!response.ok)throw new Error(result.error);setNotice(result.result?.nextPage?`Page checked. Continue with page ${result.result.nextPage}.`:'Action completed. Review the updated results below.');if(result.result?.nextPage)setPage(result.result.nextPage);await load();}
    catch(error){setError(error instanceof Error?error.message:'Action failed.');}finally{setBusy(false);}
  }
  const validReason = reason.trim().length >= 8;
  const queues: [string, Row[]][] = data ? [
    ['Pending and failed refunds', data.pendingRefunds || []],
    ['Uncertain provider operations', data.operations],
    ['Checkout recovery', data.checkouts],
  ] : [];
  return <ConsoleShell session={session} service="finance" label="PAYMENT OPERATIONS" title="Payments & accounting" blurb="Monitor payment health, review balances and resolve exceptions.">
    <div className="finance-desk" aria-busy={busy}>
      <div className="finance-toolbar"><a href="#finance-recovery" onClick={()=>setRecoveryOpen(true)}>Recovery tools ↓</a><button disabled={busy} onClick={()=>void load()}>Refresh data</button></div>
      {error&&<p className="finance-message is-error" role="alert">{error}</p>}
      {notice&&<p className="finance-message" role="status">{notice}</p>}
      {!data?<p role="status">Loading payment operations…</p>:<>
        <section className="finance-panel"><h2>Payment health</h2><p className="finance-muted">Checked {dateLabel(data.checkedAt)}. Refresh for the latest results.</p>
          <div className="finance-metrics">
            <div><strong>{(data.alerts || []).reduce((sum, alert)=>sum+alert.count,0)}</strong><span>Flagged health items</span></div>
            <div><strong>{data.inbox.length + data.events.length}</strong><span>Webhook & accounting exceptions</span></div>
            <div><strong>{data.operations.length}</strong><span>Uncertain operations</span></div>
          </div>
          {!data.alerts?.length?<p className="finance-message">No overdue payments or finance exceptions detected.</p>:data.alerts.map(alert=><article className="finance-message is-warning" key={alert.id}><strong>{alert.count} · {alert.title}</strong><p>{alert.detail}</p><a href="#finance-recovery" onClick={()=>setRecoveryOpen(true)}>Open recovery tools →</a></article>)}
        </section>
        <section className="finance-panel"><h2>Accounting balances</h2><p className="finance-muted">Positive balances are debits; negative balances are credits. Pending events are excluded. Amounts are shown in major currency units.</p>
          <FinanceTable rows={data.balances} columns={['account','balance']} empty="No journal entries yet." />
        </section>
        <section className="finance-panel"><h2>Exception queues</h2><p className="finance-muted">Expand a queue to inspect its records. Retrying an item requires a reason in Recovery tools.</p>
          <details className="finance-queue" open={data.inbox.length>0}><summary>Webhook exceptions <span>{data.inbox.length}</span></summary>
            {!data.inbox.length?<p className="finance-muted">No pending webhook events.</p>:data.inbox.map(row=><article className="finance-entry" key={String(row.id)}><strong>{row.reference}</strong><p>{row.event_type} · {row.status} · Attempts: {row.attempts}</p>{row.last_error&&<p>{row.last_error}</p>}{row.status==='REVIEW'&&<button disabled={busy||!validReason} onClick={()=>void act('REPLAY_INBOX',String(row.id))}>Retry reviewed event</button>}</article>)}
          </details>
          <details className="finance-queue" open={data.events.length>0}><summary>Accounting backlog <span>{data.events.length} pending</span></summary>
            {data.backlog.map(row=><p className="finance-muted" key={String(row.state)}>{row.state}: {row.count} · Oldest: {dateLabel(row.oldest)}</p>)}
            {!data.events.length&&<p className="finance-muted">No pending accounting entries.</p>}
            {data.events.map(row=><article className="finance-entry" key={String(row.sequence)}><strong>{row.source} · {row.source_id}</strong><p>{row.state} · {row.error}</p>{row.state==='REVIEW'&&<button disabled={busy||!validReason} onClick={()=>void act('REPLAY_OUTBOX',String(row.sequence))}>Retry reviewed entry</button>}</article>)}
          </details>
          {queues.map(([title, rows])=><details className="finance-queue" key={title} open={rows.length>0}><summary>{title}<span>{rows.length}</span></summary><FinanceTable rows={rows}/></details>)}
        </section>
        <section className="finance-panel"><h2>Reconciliation results</h2><p className="finance-muted">Payment amounts use major currency units; settlement page results show record counts. Expand a record for IDs and provider details.</p><FinanceTable rows={data.reconciliation} columns={['reference','status','expected','observed']} detail/></section>
      </>}
      <section className="finance-panel" id="finance-recovery"><details open={recoveryOpen} onToggle={event=>setRecoveryOpen(event.currentTarget.open)}><summary className="finance-recovery-title">Recovery tools <span>Verify & recover</span></summary>
        <p className="finance-muted">Unknown transfers and refunds remain reserved until their provider outcome is verified. These tools do not send a second payment.</p>
        <div className="finance-fields">
          <label className="finance-reason">Reason for this action<textarea value={reason} onChange={event=>setReason(event.target.value)} maxLength={500} rows={3} aria-describedby="finance-reason-help"/><small id="finance-reason-help">Required for every recovery action. Enter 8–500 characters.</small></label>
          <label>Payment reference or settlement ID<input value={reference} onChange={event=>setReference(event.target.value)} autoComplete="off"/></label>
          <label>Settlement page<input type="number" min={1} step={1} value={page} onChange={event=>setPage(Number(event.target.value))}/></label>
        </div>
        <div className="finance-actions"><button disabled={busy||!validReason||!reference.trim()} onClick={()=>void act('RECONCILE')}>Verify payment</button><button disabled={busy||!validReason||!/^\d+$/.test(reference)||!Number.isInteger(page)||page<1} onClick={()=>void act('SETTLEMENT')}>Check settlement page</button><button disabled={busy||!validReason} onClick={()=>void act('MAINTENANCE')}>Process pending work</button></div>
        {busy&&<p role="status">Processing recovery action…</p>}
      </details></section>
      {data&&<section className="finance-panel"><details><summary className="finance-recovery-title">Recovery audit <span>{data.audit.length} records</span></summary><FinanceTable rows={data.audit}/></details></section>}
    </div>
  </ConsoleShell>;
}

function dateLabel(value: Row[string] | undefined) {
  if (!value) return '—';
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString(undefined, {dateStyle:'medium', timeStyle:'short'});
}
function cellValue(row: Row, key: string) {
  const value = row[key];
  if (value === null || value === undefined) return '—';
  if (key.endsWith('_at')) return dateLabel(value);
  if (key === 'balance') return `${String(row.account).split(':').at(-1)} ${(Number(value)/100).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}`;
  if (key === 'expected' || key === 'observed') return row.kind === 'SETTLEMENT_PAGE' ? `${value} records` : `${row.currency || ''} ${(Number(value)/100).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}`;
  return String(value);
}
function FinanceTable({rows, columns, detail=false, empty='No entries.'}: {rows:Row[];columns?:string[];detail?:boolean;empty?:string}) {
  if (!rows.length) return <p className="finance-muted">{empty}</p>;
  const keys = columns || [...new Set(rows.flatMap(row=>Object.keys(row)))].sort((a,b)=>Number(['status','state'].includes(b))-Number(['status','state'].includes(a)));
  return <div className="finance-table-scroll" role="region" aria-label="Finance records" tabIndex={0}><table><thead><tr>{keys.map(key=><th scope="col" key={key}>{key === 'amount' ? 'Amount (minor units)' : key.replaceAll('_',' ')}</th>)}{detail&&<th scope="col">Details</th>}</tr></thead><tbody>{rows.map((row,index)=><tr key={String(row.id||row.account||index)}>{keys.map(key=><td key={key} className={['balance','expected','observed'].includes(key)?'finance-number':undefined}>{['status','state'].includes(key)?<span className={`finance-status ${['FAILED','REVIEW','MISMATCH','UNKNOWN'].includes(String(row[key]))?'needs-review':''}`}>{cellValue(row,key)}</span>:cellValue(row,key)}</td>)}{detail&&<td><details><summary>View record</summary><dl>{Object.entries(row).filter(([key])=>!keys.includes(key)).map(([key])=><div key={key}><dt>{key.replaceAll('_',' ')}</dt><dd>{cellValue(row,key)}</dd></div>)}</dl></details></td>}</tr>)}</tbody></table></div>;
}
