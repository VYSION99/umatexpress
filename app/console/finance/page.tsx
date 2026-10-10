"use client";

import { useCallback, useEffect, useState } from "react";
import { ConsoleSessionGate, type ConsoleSessionInfo } from "@/components/admin/ConsoleSessionGate";
import { ConsoleShell } from "@/components/console/ConsoleShell";
import { ConsoleUnavailable } from "@/components/console/ConsoleUnavailable";

type Row=Record<string,string|number|null>;
import type { FinanceAlert } from "@/lib/payments/health";
type Data={balances:Row[];events:Row[];operations:Row[];reconciliation:Row[];audit:Row[];backlog:Row[];checkouts:Row[];inbox:Row[];alerts:FinanceAlert[];pendingRefunds:Row[];checkedAt:string};
export default function FinancePage(){return <ConsoleSessionGate label="payment operations">{session=>session.account.role==='ADMIN'?<FinanceDesk session={session}/>:<ConsoleUnavailable session={session} service="finance" label="PAYMENT OPERATIONS" blurb="Payment operations requires administrator access."/>}</ConsoleSessionGate>;}
function FinanceDesk({session}:{session:ConsoleSessionInfo}) {
  const [data,setData]=useState<Data|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
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
  return <ConsoleShell session={session} service="finance" label="PAYMENT OPERATIONS" title="Payments & accounting" blurb="Review balances, uncertain payments and settlement differences. Every recovery action requires a reason.">
    {error&&<p className="console-alert" role="alert">{error}</p>}{notice&&<p className="console-alert console-alert-ok" role="status">{notice}</p>}
    <section className="console-panel"><h2>Recovery tools</h2>
      <label>Reason for this action<textarea value={reason} onChange={event=>setReason(event.target.value)} maxLength={500}/></label>
      <label>Payment reference or settlement ID<input value={reference} onChange={event=>setReference(event.target.value)}/></label>
      <label>Settlement page<input type="number" min={1} value={page} onChange={event=>setPage(Number(event.target.value))}/></label>
      <button disabled={busy||reason.trim().length<8||!reference} onClick={()=>void act('RECONCILE')}>Verify payment</button>{' '}
      <button disabled={busy||reason.trim().length<8||!/^\d+$/.test(reference)} onClick={()=>void act('SETTLEMENT')}>Check settlement page</button>{' '}
      <button disabled={busy||reason.trim().length<8} onClick={()=>void act('MAINTENANCE')}>Process pending work</button>{' '}
      <button disabled={busy} onClick={()=>void load()}>Refresh</button>
      <p>Unknown transfers and refunds remain reserved until their provider outcome is verified. These tools do not send a second payment.</p>
    </section>
    {!data?<p role="status">Loading payment operations…</p>:<>
      <section className="console-panel"><h2>Payment health</h2><p>Checked {new Date(data.checkedAt).toLocaleString()}. Refresh to see the latest results.</p>{!data.alerts?.length?<p className="console-alert console-alert-ok">No overdue payments or finance exceptions detected at this check.</p>:data.alerts.map(alert=><article className="console-alert" role="alert" key={alert.id}><strong>{alert.count} · {alert.title}</strong><p>{alert.detail}</p></article>)}</section>
      <section className="console-panel"><h2>Accounting balances</h2><p>Amounts are in the currency shown in each account. Positive values are debits; negative values are credits. Pending events below have not yet reached these balances.</p><table><thead><tr><th>Account</th><th>Balance</th></tr></thead><tbody>{data.balances.map(row=><tr key={String(row.account)}><td>{row.account}</td><td>{(Number(row.balance)/100).toFixed(2)}</td></tr>)}</tbody></table>{!data.balances.length&&<p>No journal entries yet.</p>}</section>
      <section className="console-panel"><h2>Webhook exceptions</h2>{!data.inbox.length?<p>No pending webhook events.</p>:data.inbox.map(row=><article key={String(row.id)}><strong>{row.reference}</strong> · {row.event_type} · {row.status}<p>{row.last_error} · Attempts: {row.attempts}</p>{row.status==='REVIEW'&&<button disabled={busy||reason.trim().length<8} onClick={()=>void act('REPLAY_INBOX',String(row.id))}>Retry reviewed event</button>}</article>)}</section>
      <section className="console-panel"><h2>Accounting backlog</h2>{data.backlog.map(row=><p key={String(row.state)}>{row.state}: {row.count} · Oldest: {row.oldest}</p>)}{data.events.map(row=><article key={String(row.sequence)}>{row.source} · {row.source_id} · {row.state} · {row.error}{row.state==='REVIEW'&&<button disabled={busy||reason.trim().length<8} onClick={()=>void act('REPLAY_OUTBOX',String(row.sequence))}>Retry reviewed entry</button>}</article>)}</section>
      {([['Pending and failed refunds',data.pendingRefunds || []],['Uncertain provider operations',data.operations],['Checkout recovery',data.checkouts],['Reconciliation results',data.reconciliation],['Recovery audit',data.audit]] as [string,Row[]][]).map(([title,rows])=><section className="console-panel" key={title}><h2>{title}</h2>{!rows.length?<p>No entries.</p>:<div style={{overflowX:'auto'}}><table><thead><tr>{Object.keys(rows[0]).map(key=><th key={key}>{key.replaceAll('_',' ')}</th>)}</tr></thead><tbody>{rows.map((row,index)=><tr key={String(row.id||index)}>{Object.keys(rows[0]).map(key=><td key={key}>{String(row[key]??'—')}</td>)}</tr>)}</tbody></table></div>}</section>)}
    </>}
  </ConsoleShell>;
}
