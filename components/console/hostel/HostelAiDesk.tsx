"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ChatCenteredText, NotePencil, Plus, Trash } from "@/components/ui/MaterialIcon";
import "@/components/console/hostel/ai-desk.css";

type Entry = { id: string; roomId: string; roomLabel: string; title: string; content: string; updatedBy: string; updatedAt: string };
type Inquiry = { id: string; question: string; contactName: string; contactEmail: string; assistantAnswer: string; status: string; staffReply: string; createdAt: string };
type Room = { id: string; label: string };
const EMPTY = { id: "", roomId: "", title: "", content: "" };
async function request(path: string, init?: RequestInit) {
  const response = await fetch(path, { credentials: "same-origin", cache: "no-store", ...init });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "The hostel AI desk could not save that change.");
  return data;
}
export function HostelAiDesk({ propertyId, rooms }: { propertyId: string; rooms: Room[] }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [inquiries, setInquiries] = useState<Inquiry[]>([]);
  const [draft, setDraft] = useState({ ...EMPTY });
  const [replies, setReplies] = useState<Record<string,string>>({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    const [info, questions] = await Promise.all([
      request(`/api/console/hostel/ai-info?propertyId=${encodeURIComponent(propertyId)}`),
      request(`/api/console/hostel/inquiries?propertyId=${encodeURIComponent(propertyId)}`),
    ]);
    setEntries(info.entries || []); setInquiries(questions.inquiries || []);
  }, [propertyId]);
  useEffect(() => { queueMicrotask(() => { void load().catch(cause => setError(cause instanceof Error ? cause.message : "AI desk could not load.")); }); }, [load]);
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy("save"); setError(""); setNotice("");
    try {
      const data = await request("/api/console/hostel/ai-info", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ propertyId, ...draft }) });
      setEntries(data.entries || []); setDraft({ ...EMPTY }); setNotice("Information saved. The assistant can use it for this hostel.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Information could not be saved."); }
    finally { setBusy(""); }
  }
  async function archive(id: string) {
    setBusy(id); setError(""); setNotice("");
    try {
      const data = await request("/api/console/hostel/ai-info", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ propertyId, id }) });
      setEntries(data.entries || []); if (draft.id === id) setDraft({ ...EMPTY }); setNotice("Information removed from assistant answers.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Information could not be removed."); }
    finally { setBusy(""); }
  }
  async function reply(id: string) {
    setBusy(id); setError(""); setNotice("");
    try {
      const data = await request("/api/console/hostel/inquiries", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ propertyId, id, reply: replies[id] || "" }) });
      setInquiries(data.inquiries || []); setReplies(current => ({ ...current, [id]: "" })); setNotice("Reply recorded and emailed to the student.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Reply could not be sent."); }
    finally { setBusy(""); }
  }
  const open = inquiries.filter(item => item.status === "OPEN");
  return <div className="hostel-ai-desk">
    {error && <div className="console-alert" role="alert">{error}</div>}
    {notice && <div className="console-alert console-alert-ok" role="status">{notice}</div>}
    <section className="console-panel"><h2><ChatCenteredText size={18}/>Information for the hostel assistant</h2>
      <p className="console-note">You and your active delegate managers can describe the property or a specific room. Students will see these as information supplied by your hostel. Keep prices in the listing editor so they stay tied to the academic year and review.</p>
      {entries.length > 0 && <div className="hostel-ai-entries">{entries.map(item => <article key={item.id}><div><strong>{item.roomLabel ? `${item.roomLabel} · ` : "Whole property · "}{item.title}</strong><p>{item.content}</p><small>Updated by {item.updatedBy} · {new Date(item.updatedAt).toLocaleDateString("en-GB")}</small></div><div><button type="button" onClick={() => setDraft({ id: item.id, roomId: item.roomId, title: item.title, content: item.content })}><NotePencil size={15}/>Edit</button><button type="button" disabled={Boolean(busy)} onClick={() => void archive(item.id)}><Trash size={15}/>Remove</button></div></article>)}</div>}
      <form className="console-form" onSubmit={event => void save(event)}><label>Applies to<select value={draft.roomId} onChange={event => setDraft({ ...draft, roomId: event.target.value })}><option value="">Whole property</option>{rooms.map(room => <option key={room.id} value={room.id}>{room.label}</option>)}</select></label><label>Topic<input required minLength={3} maxLength={80} value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} placeholder="Check-in, water supply, room furniture…"/></label><label className="console-field-wide">What should students know?<textarea required minLength={10} maxLength={1500} rows={4} value={draft.content} onChange={event => setDraft({ ...draft, content: event.target.value })} placeholder="Write a clear, factual answer. Mention which room it applies to if needed."/></label><button disabled={Boolean(busy)}><Plus size={15}/>{busy === "save" ? "Saving…" : draft.id ? "Update information" : "Add information"}</button>{draft.id && <button type="button" className="console-secondary" onClick={() => setDraft({ ...EMPTY })}>Cancel edit</button>}</form>
    </section>
    <section className="console-panel"><h2><ChatCenteredText size={18}/>Questions for hostel staff <span className="console-badge">{open.length} open</span></h2><p className="console-note">When the assistant cannot confidently answer, students can send the exact question here before booking. Your reply goes to the email they supplied.</p>{inquiries.length === 0 ? <p className="console-empty">No questions have been forwarded for this property.</p> : <div className="hostel-ai-inquiries">{inquiries.map(item => <article key={item.id}><header><strong>{item.contactName}</strong><span>{item.contactEmail} · {new Date(item.createdAt).toLocaleDateString("en-GB")}</span><span className={`console-badge console-badge-${item.status.toLowerCase()}`}>{item.status}</span></header><p><b>Question:</b> {item.question}</p>{item.assistantAnswer && <small>Assistant response: {item.assistantAnswer}</small>}{item.staffReply && <p><b>Staff reply:</b> {item.staffReply}</p>}{item.status === "OPEN" && <div className="hostel-ai-reply"><textarea aria-label={`Reply to ${item.contactName}`} maxLength={2000} rows={3} value={replies[item.id] || ""} onChange={event => setReplies({ ...replies, [item.id]: event.target.value })} placeholder="Answer this specific question…"/><button type="button" disabled={Boolean(busy) || (replies[item.id] || "").trim().length < 3} onClick={() => void reply(item.id)}>{busy === item.id ? "Sending…" : "Reply by email"}</button></div>}</article>)}</div>}</section>
  </div>;
}
