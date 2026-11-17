"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Copy, Flag } from "@/components/ui/MaterialIcon";

const QUOTE_DRAFT_KEY = "umatexpress.print-copy.quote-draft";
const QUOTE_DRAFT_MS = 15 * 60_000;

function PrintCopyModal({ open, onClose, titleId, children }: { open: boolean; onClose: () => void; titleId: string; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) node.showModal();
    if (!open && node.open) node.close();
  }, [open]);
  return <dialog ref={dialog} className="print-copy-dialog" aria-labelledby={titleId} onClose={onClose} onCancel={onClose} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>{children}</dialog>;
}

export function PrintCopyQuoteButton({ providerId, providerName }: { providerId: string; providerName: string }) {
  const [open, setOpen] = useState(false); const [requirements, setRequirements] = useState("");
  const [message, setMessage] = useState(""); const [needsSignIn, setNeedsSignIn] = useState(false); const [busy, setBusy] = useState(false);
  const returnToQuote = `/print-copy?quoteProviderId=${encodeURIComponent(providerId)}`;

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      const url = new URL(window.location.href);
      if (url.searchParams.get("quoteProviderId") !== providerId) return;
      url.searchParams.delete("quoteProviderId");
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
      try {
        const saved = sessionStorage.getItem(QUOTE_DRAFT_KEY);
        sessionStorage.removeItem(QUOTE_DRAFT_KEY);
        if (saved) {
          const draft = JSON.parse(saved) as { providerId?: unknown; requirements?: unknown; savedAt?: unknown };
          if (draft.providerId === providerId && typeof draft.requirements === "string" && draft.requirements.length <= 1000
            && typeof draft.savedAt === "number" && Date.now() - draft.savedAt >= 0 && Date.now() - draft.savedAt <= QUOTE_DRAFT_MS) setRequirements(draft.requirements);
        }
      } catch { /* The quote form still opens if device storage is unavailable. */ }
      setOpen(true);
    });
    return () => { active = false; };
  }, [providerId]);

  const keepDraftForSignIn = () => {
    try { sessionStorage.setItem(QUOTE_DRAFT_KEY, JSON.stringify({ providerId, requirements, savedAt: Date.now() })); }
    catch { /* Return to this shop still works without a saved draft. */ }
  };

  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setMessage(""); setNeedsSignIn(false);
    try {
      const response = await fetch("/api/print-copy/quotes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ providerId, requirements }) });
      const data = await response.json() as { error?: string; reference?: string };
      if (response.status === 401) { setNeedsSignIn(true); throw new Error("Sign in with your UMaT student account to send a quote request."); }
      if (!response.ok) throw new Error(data.error || "The request could not be sent.");
      setMessage(`Request ${data.reference} sent. Track its status below; staff will use your student account email for follow-up.`); setRequirements("");
      window.dispatchEvent(new Event("print-copy-quote-created"));
    } catch (error) { setMessage(error instanceof Error ? error.message : "The request could not be sent."); }
    finally { setBusy(false); }
  }
  return <>
    <button type="button" className="print-copy-action" onClick={() => { setOpen(true); setMessage(""); setNeedsSignIn(false); }}><Copy size={17} aria-hidden /> Request a quote</button>
    <PrintCopyModal open={open} onClose={() => setOpen(false)} titleId={`quote-title-${providerId}`}>
        <header><div><span>QUOTE REQUEST</span><h2 id={`quote-title-${providerId}`}>{providerName}</h2></div><button type="button" aria-label="Close quote request" onClick={() => setOpen(false)}>×</button></header>
        <p>Describe the print job and any quantity or finishing needs. Don’t upload or include private documents; the shop can explain a safe way to share files after discussing the quote.</p>
        <form onSubmit={submit}><label>What do you need printed?<textarea required minLength={20} maxLength={1000} rows={5} value={requirements} onChange={(event) => setRequirements(event.target.value)} placeholder="For example: 40 A4 pages, black and white, double-sided, spiral binding." /></label>
          {message && <p className="print-copy-feedback" role="status">{message}</p>}
          {needsSignIn && <Link href={`/account?next=${encodeURIComponent(returnToQuote)}`} onClick={keepDraftForSignIn} className="print-copy-signin">Sign in, then return to this quote</Link>}
          {message.startsWith("Request PC-") && <button type="button" className="print-copy-secondary" onClick={() => setOpen(false)}>Done</button>}
          {!message.startsWith("Request PC-") && <button className="print-copy-action" disabled={busy || requirements.trim().length < 20}>{busy ? "Sending…" : "Send quote request"}</button>}
        </form>
    </PrintCopyModal>
  </>;
}

type StudentQuote = { reference: string; provider_name: string; status: string; created_at: string; updated_at: string };
export function PrintCopyMyQuotes() {
  const [quotes, setQuotes] = useState<StudentQuote[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "signed-out" | "error">("loading");
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const response = await fetch("/api/print-copy/quotes", { cache: "no-store" });
        if (!active) return;
        if (response.status === 401) { setState("signed-out"); return; }
        if (!response.ok) throw new Error("Quote status is temporarily unavailable.");
        const data = await response.json() as { quotes?: StudentQuote[] };
        if (active) { setQuotes(data.quotes || []); setState("ready"); }
      } catch { if (active) setState("error"); }
    };
    void load();
    window.addEventListener("print-copy-quote-created", load);
    return () => { active = false; window.removeEventListener("print-copy-quote-created", load); };
  }, []);
  return <section className="print-copy-my-quotes" aria-labelledby="print-copy-my-quotes-title">
    <h2 id="print-copy-my-quotes-title">My quote requests</h2>
    {state === "loading" && <p>Checking your requests…</p>}
    {state === "signed-out" && <p><Link href="/account?next=%2Fprint-copy">Sign in</Link> with your student account to see your quote requests.</p>}
    {state === "error" && <p>Quote status is temporarily unavailable. Please try again later.</p>}
    {state === "ready" && (quotes.length ? <ul>{quotes.map((quote) => <li key={quote.reference}><div><strong>{quote.reference}</strong><span>{quote.provider_name}</span></div><div><span className={`print-copy-request-status is-${quote.status.toLowerCase()}`}>{quote.status === "IN_PROGRESS" ? "In progress" : quote.status === "CLOSED" ? "Closed" : "New"}</span><small>Updated {new Date(quote.updated_at).toLocaleDateString("en-GH", { dateStyle: "medium" })}</small></div></li>)}</ul> : <p>You have no active quote requests.</p>)}
    <p className="print-copy-my-quotes-note">Requests and contact details are deleted after 90 days. Staff follow up by email; your status appears here while the request is active.</p>
  </section>;
}

export function PrintCopyReportButton({ providerId, providerName }: { providerId: string; providerName: string }) {
  const [open, setOpen] = useState(false); const [category, setCategory] = useState("SERVICES");
  const [message, setMessage] = useState(""); const [feedback, setFeedback] = useState(""); const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setFeedback("");
    try {
      const response = await fetch("/api/print-copy/reports", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ providerId, category, message }) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "The correction could not be sent.");
      setFeedback("Thanks. Staff will check the shop details."); setMessage("");
    } catch (error) { setFeedback(error instanceof Error ? error.message : "The correction could not be sent."); }
    finally { setBusy(false); }
  }
  return <>
    <button type="button" className="print-copy-report-trigger" onClick={() => { setOpen(true); setFeedback(""); }}><Flag size={15} aria-hidden /> Report incorrect details</button>
    <PrintCopyModal open={open} onClose={() => setOpen(false)} titleId={`report-title-${providerId}`}>
        <header><div><span>LISTING CORRECTION</span><h2 id={`report-title-${providerId}`}>{providerName}</h2></div><button type="button" aria-label="Close correction form" onClick={() => setOpen(false)}>×</button></header>
        <form onSubmit={submit}><label>What needs checking?<select value={category} onChange={(event) => setCategory(event.target.value)}><option value="SERVICES">Services offered</option><option value="PRICE">Pricing</option><option value="HOURS">Opening hours</option><option value="LOCATION">Location</option><option value="CONTACT">Contact details</option><option value="OTHER">Other</option></select></label><label>What did you notice?<textarea required minLength={10} maxLength={600} rows={4} value={message} onChange={(event) => setMessage(event.target.value)} /></label>
          {feedback && <p className="print-copy-feedback" role="status">{feedback}</p>}
          {feedback.startsWith("Thanks.") ? <button type="button" className="print-copy-secondary" onClick={() => setOpen(false)}>Done</button> : <button className="print-copy-action" disabled={busy || message.trim().length < 10}>{busy ? "Sending…" : "Send correction"}</button>}
        </form>
    </PrintCopyModal>
  </>;
}
