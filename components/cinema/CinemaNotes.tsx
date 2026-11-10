"use client";
import { useEffect, useRef, useState } from "react";
import { Check, Copy, DownloadSimple, Notebook, Trash } from "@/components/ui/MaterialIcon";
import { CINEMA_NOTES_BEFORE_APPEND, CINEMA_NOTES_CHANGED, CINEMA_NOTES_MAX, appendCinemaPersonalNotes, cinemaLegacyNotesKey, cinemaNotesKey, readCinemaPersonalNotes, writeCinemaPersonalNotes } from "@/lib/cinema-engine/personal-notes";
import { downloadTextPdf } from "./pdf";

/** Account and room select the local page; legacy device notes require an explicit import. */
export function CinemaNotes({ roomId, accountId, onShare }: { roomId: string; accountId?: string; onShare?: (text: string) => void }) {
  const [text, setText] = useState(""); const [selected, setSelected] = useState("");
  const [loaded, setLoaded] = useState(false); const [saved, setSaved] = useState(true);
  const [notice, setNotice] = useState(""); const [hasLegacy, setHasLegacy] = useState(false); const [legacy, setLegacy] = useState<string | null>(null);
  const unsaved = useRef(false);
  const key = cinemaNotesKey(roomId, accountId);
  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      try { setText(readCinemaPersonalNotes(window.localStorage, roomId, accountId)); setHasLegacy(Boolean(window.localStorage.getItem(cinemaLegacyNotesKey(roomId)))); }
      catch { setSaved(false); }
      setLoaded(true);
    });
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ key: string; text: string }>).detail;
      if (detail?.key === key) { unsaved.current = false; setText(detail.text); setSelected(""); setSaved(true); }
    };
    const stored = (event: StorageEvent) => { if (event.key === key && !unsaved.current) { setText((event.newValue || "").slice(0, CINEMA_NOTES_MAX)); setSelected(""); setSaved(true); } };
    const beforeAppend = (event: Event) => { const detail = (event as CustomEvent<{ key: string; blocked: boolean }>).detail; if (detail?.key === key && unsaved.current) detail.blocked = true; };
    window.addEventListener(CINEMA_NOTES_CHANGED, changed); window.addEventListener("storage", stored); window.addEventListener(CINEMA_NOTES_BEFORE_APPEND, beforeAppend);
    return () => { active = false; window.removeEventListener(CINEMA_NOTES_CHANGED, changed); window.removeEventListener("storage", stored); window.removeEventListener(CINEMA_NOTES_BEFORE_APPEND, beforeAppend); };
  }, [key, roomId, accountId]);
  const change = (value: string) => {
    setText(value); setSelected(""); setNotice(""); unsaved.current = true;
    try { writeCinemaPersonalNotes(window.localStorage, roomId, accountId, value); unsaved.current = false; setSaved(true); }
    catch { setSaved(false); }
  };
  const copy = async () => { try { await navigator.clipboard.writeText(text); setNotice("Copied to the clipboard."); } catch { setNotice("Select the text and copy it by hand."); } };
  return <section className="cinema-card cinema-notes">
    <div className="cinema-presence-head"><h2><Notebook size={16} aria-hidden /> My notes</h2><span className="cinema-notes-saved">{!loaded ? "Opening…" : saved ? <><Check size={12} aria-hidden /> Saved on this device</> : "Not saved on this device"}</span></div>
    <textarea value={text} maxLength={CINEMA_NOTES_MAX} rows={7} disabled={!loaded} placeholder="Write definitions, timestamps and questions…" aria-label="Your private notes for this room" onChange={event => change(event.target.value)} onSelect={event => setSelected(event.currentTarget.value.slice(event.currentTarget.selectionStart, event.currentTarget.selectionEnd))} />
    <div className="cinema-notes-actions">
      <button type="button" className="secondary" disabled={!text} onClick={() => void copy()}><Copy size={13} aria-hidden /> Copy</button>
      <button type="button" className="secondary" disabled={!text} onClick={() => { downloadTextPdf(`umatexpress-notes-${roomId.slice(0, 8)}.pdf`, "UMATeXPRESS Session Notes", text.split("\n")); setNotice("Downloaded as a PDF."); }}><DownloadSimple size={13} aria-hidden /> PDF</button>
      <button type="button" className="secondary" disabled={!text} onClick={() => change("")}><Trash size={13} aria-hidden /> Clear</button>
      {onShare && <button type="button" className="secondary" disabled={!selected.trim()} onClick={() => onShare(selected)}>Review selected note for sharing</button>}
      <span className="cinema-notes-count">{text.length}/{CINEMA_NOTES_MAX}</span>
    </div>
    <p className="cinema-note cinema-sub">Stored only on this device, separately for {accountId ? "your account" : "device visitors"} and this room. {onShare ? "Select an excerpt to review it in room chat." : "Join the room to review selected excerpts for sharing."}</p>
    {hasLegacy && <div className="cinema-legacy-notes"><button type="button" onClick={() => { try { setLegacy(window.localStorage.getItem(cinemaLegacyNotesKey(roomId))?.slice(0, CINEMA_NOTES_MAX) || ""); } catch { setNotice("Earlier device notes could not be opened."); } }}>Review earlier device notes</button>
      {legacy !== null && <><p className="cinema-note">These earlier notes were stored for this device before account-specific pages existed.</p><textarea readOnly rows={4} value={legacy} aria-label="Earlier device notes" /><button type="button" onClick={() => { try { appendCinemaPersonalNotes(window.localStorage, roomId, accountId || "device", legacy); setLegacy(null); setNotice("Earlier notes copied into this page."); } catch (error) { setNotice(error instanceof Error ? error.message : "Those notes could not be copied."); } }}>Copy earlier notes into my page</button><button type="button" onClick={() => setLegacy(null)}>Close earlier notes</button></>}
    </div>}
    {notice && <p className="cinema-report-notice" role="status">{notice}</p>}
  </section>;
}
