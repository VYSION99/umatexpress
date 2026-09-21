"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy, Download, NotebookPen, Trash2 } from "lucide-react";

/** Long enough for a lecture's worth of notes, short enough for one storage row. */
const NOTES_MAX_CHARS = 20_000;
/** The room id namespaces the notes, so two rooms never share a page. */
const notesKey = (roomId: string) => `umatexpress.cinema.notes.v1:${roomId}`;

/**
 * The student's own notes for one room.
 *
 * A note is a private page, not a room object: it never leaves the device, no
 * socket carries it and no one else can read it. That is the point — the chat
 * is what the room shares, and this is what the student keeps. It is stored per
 * device rather than per account, so a signed-out visitor can still take notes
 * while watching, and it says so instead of pretending the room can see them.
 */
export function CinemaNotes({ roomId }: { roomId: string }) {
  const [text, setText] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState(true);
  const [notice, setNotice] = useState("");
  const key = notesKey(roomId);
  // The unmount flush needs the last value without re-subscribing the effect;
  // a ref updated after every render is the cheap way to carry it across.
  const latest = useRef({ key, text });
  useEffect(() => { latest.current = { key, text }; });

  // Storage is read after mount rather than during render: the server has no
  // localStorage, and reading it in an initialiser would hydrate a different
  // page than the one that was sent.
  useEffect(() => {
    queueMicrotask(() => {
      try {
        setText(window.localStorage.getItem(key)?.slice(0, NOTES_MAX_CHARS) || "");
      } catch {
        setSaved(false);
      }
      setLoaded(true);
    });
  }, [key]);

  useEffect(() => {
    if (!loaded) return;
    const timer = window.setTimeout(() => {
      try {
        window.localStorage.setItem(key, text);
        setSaved(true);
      } catch {
        setSaved(false);
      }
    }, 400);
    return () => window.clearTimeout(timer);
  }, [key, text, loaded]);

  // A tab closed inside the debounce window still keeps what was typed.
  useEffect(() => () => {
    try { window.localStorage.setItem(latest.current.key, latest.current.text); } catch { /* a blocked store loses nothing else */ }
  }, []);

  const change = (value: string) => {
    setText(value);
    setSaved(false);
    setNotice("");
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice("Copied to the clipboard.");
    } catch {
      setNotice("The browser would not copy. Select the text and copy it by hand.");
    }
  };

  const download = () => {
    const blob = new Blob([text || ""], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `umatexpress-notes-${roomId.slice(0, 8)}.txt`;
    link.click();
    URL.revokeObjectURL(url);
    setNotice("Downloaded as a text file.");
  };

  return <section className="cinema-card cinema-notes">
    <div className="cinema-presence-head">
      <h2><NotebookPen size={16} aria-hidden /> My notes</h2>
      <span className="cinema-notes-saved">{loaded ? (saved ? <><Check size={12} aria-hidden /> Saved on this device</> : "Saving…") : "Opening…"}</span>
    </div>
    <textarea
      value={text}
      maxLength={NOTES_MAX_CHARS}
      rows={7}
      placeholder="Write what matters: definitions, a timestamp, the question to ask next…"
      aria-label="Your private notes for this room"
      onChange={(event) => change(event.target.value)}
    />
    <div className="cinema-notes-actions">
      <button type="button" className="secondary" disabled={!text} onClick={() => void copy()}><Copy size={13} aria-hidden /> Copy</button>
      <button type="button" className="secondary" disabled={!text} onClick={download}><Download size={13} aria-hidden /> Download</button>
      <button type="button" className="secondary" disabled={!text} onClick={() => { change(""); try { window.localStorage.removeItem(key); } catch { /* nothing to clear */ } }}><Trash2 size={13} aria-hidden /> Clear</button>
      <span className="cinema-notes-count">{text.length}/{NOTES_MAX_CHARS}</span>
    </div>
    <p className="cinema-note cinema-sub">Private to this device and this room. Nothing here is sent to the room or its host.</p>
    {notice && <p className="cinema-report-notice" role="status">{notice}</p>}
  </section>;
}
