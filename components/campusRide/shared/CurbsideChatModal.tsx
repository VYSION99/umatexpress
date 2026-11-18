"use client";

import { useEffect, useRef, useState } from "react";
import { Check, CircleNotch, PaperPlaneTilt, X } from "@/components/ui/MaterialIcon";

export type ThreadMessage = {
  id: string;
  service: string;
  reference: string;
  senderRole: "STUDENT" | "DRIVER" | "STAFF";
  senderId: string;
  senderName: string;
  content: string;
  readAt: string;
  createdAt: string;
};

export type CurbsideChatProps = {
  open: boolean;
  onClose: () => void;
  service: "campus" | "print-copy";
  reference: string;
  title: string;
  subtitle?: string;
};

export function CurbsideChatModal({
  open,
  onClose,
  service,
  reference,
  title,
  subtitle,
}: CurbsideChatProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [chips, setChips] = useState<string[]>([]);
  const [canSend, setCanSend] = useState(true);
  const [myRole, setMyRole] = useState<string>("");
  const [counterpartName, setCounterpartName] = useState<string>("");
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  // Sync open state with HTML5 dialog
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  // Load and poll messages while dialog is open
  useEffect(() => {
    if (!open || !reference) return;
    let active = true;

    async function fetchMessages(showSpinner = false) {
      if (showSpinner) setLoading(true);
      try {
        const response = await fetch(
          `/api/messages?service=${encodeURIComponent(service)}&reference=${encodeURIComponent(reference)}`,
          { cache: "no-store", credentials: "same-origin" },
        );
        if (!active) return;
        if (!response.ok) {
          const data = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error || "Unable to load messages.");
        }
        const data = (await response.json()) as {
          messages?: ThreadMessage[];
          chips?: string[];
          participant?: { role: string; name: string; counterpartName: string; canSend: boolean };
        };
        if (!active) return;
        setMessages(data.messages || []);
        setChips(data.chips || []);
        if (data.participant) {
          setCanSend(Boolean(data.participant.canSend));
          setMyRole(data.participant.role || "");
          setCounterpartName(data.participant.counterpartName || "");
        }
        setError("");
      } catch (err) {
        if (active && showSpinner) {
          setError(err instanceof Error ? err.message : "Unable to load messages.");
        }
      } finally {
        if (active && showSpinner) setLoading(false);
      }
    }

    void fetchMessages(true);
    const interval = window.setInterval(() => {
      if (!document.hidden) void fetchMessages(false);
    }, 4000);

    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [open, service, reference]);

  // Scroll to bottom when messages change
  useEffect(() => {
    if (open) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, open]);

  async function handleSend(textToSend?: string) {
    const content = (textToSend || input).trim();
    if (!content || sending || !canSend) return;

    setSending(true);
    setError("");
    try {
      const response = await fetch("/api/messages", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          service,
          reference,
          content,
        }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        message?: ThreadMessage;
      };
      if (!response.ok || !data.ok) {
        throw new Error(data.error || "Could not send message.");
      }
      if (data.message) {
        setMessages((prev) => [...prev, data.message!]);
      }
      setInput("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send message.");
    } finally {
      setSending(false);
    }
  }

  function formatTime(iso: string) {
    if (!iso) return "";
    const date = new Date(iso);
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  return (
    <dialog
      ref={dialogRef}
      className="curbside-chat-dialog"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="curbside-chat-container">
        <header className="curbside-chat-header">
          <div>
            <h3>{title}</h3>
            {subtitle ? <p>{subtitle}</p> : counterpartName ? <p>Coordinating with {counterpartName}</p> : null}
          </div>
          <button
            type="button"
            className="curbside-close-button"
            onClick={onClose}
            aria-label="Close chat"
          >
            <X size={18} aria-hidden />
          </button>
        </header>

        {error && <div className="curbside-chat-alert" role="alert">{error}</div>}

        <div className="curbside-chat-body">
          {loading ? (
            <div className="curbside-chat-loading">
              <CircleNotch size={24} className="spin" aria-hidden />
              <span>Loading messages…</span>
            </div>
          ) : messages.length === 0 ? (
            <div className="curbside-chat-empty">
              <p>No messages yet.</p>
              <small>
                {canSend
                  ? "Send a quick update below to coordinate pickup."
                  : "This conversation is currently closed."}
              </small>
            </div>
          ) : (
            <div className="curbside-message-list">
              {messages.map((msg) => {
                const isMine = msg.senderRole === myRole;
                return (
                  <div
                    key={msg.id}
                    className={`curbside-message-bubble ${isMine ? "is-mine" : "is-counterpart"}`}
                  >
                    <div className="curbside-message-author">
                      <strong>{isMine ? "You" : msg.senderName}</strong>
                      <small>{formatTime(msg.createdAt)}</small>
                    </div>
                    <p>{msg.content}</p>
                    {isMine && (
                      <span className="curbside-read-marker" title={msg.readAt ? "Read" : "Sent"}>
                        <Check size={13} aria-hidden />
                        {msg.readAt ? <Check size={13} aria-hidden style={{ marginLeft: -6 }} /> : null}
                      </span>
                    )}
                  </div>
                );
              })}
              <div ref={bottomRef} />
            </div>
          )}
        </div>

        {canSend ? (
          <footer className="curbside-chat-footer">
            {chips.length > 0 && (
              <div className="curbside-chips-row">
                {chips.map((chip) => (
                  <button
                    key={chip}
                    type="button"
                    className="curbside-chip-btn"
                    disabled={sending}
                    onClick={() => void handleSend(chip)}
                  >
                    {chip}
                  </button>
                ))}
              </div>
            )}
            <form
              className="curbside-input-form"
              onSubmit={(e) => {
                e.preventDefault();
                void handleSend();
              }}
            >
              <input
                type="text"
                placeholder="Type a message (e.g. at the gate)…"
                maxLength={500}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                disabled={sending}
              />
              <button
                type="submit"
                disabled={sending || !input.trim()}
                aria-label="Send message"
              >
                {sending ? (
                  <CircleNotch size={16} className="spin" aria-hidden />
                ) : (
                  <PaperPlaneTilt size={16} aria-hidden />
                )}
              </button>
            </form>
          </footer>
        ) : (
          <footer className="curbside-chat-footer is-closed">
            <small>Conversation closed · Transaction concluded or expired</small>
          </footer>
        )}
      </div>

      <style jsx>{`
        .curbside-chat-dialog {
          border: none;
          border-radius: 16px;
          padding: 0;
          max-width: 440px;
          width: 92vw;
          box-shadow: 0 20px 40px rgba(0, 0, 0, 0.25);
          background: var(--surface-bg, #ffffff);
          color: var(--text-primary, #1e293b);
        }
        .curbside-chat-dialog::backdrop {
          background: rgba(15, 23, 42, 0.55);
          backdrop-filter: blur(2px);
        }
        .curbside-chat-container {
          display: flex;
          flex-direction: column;
          height: 520px;
          max-height: 85vh;
        }
        .curbside-chat-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 14px 18px;
          border-bottom: 1px solid var(--border-subtle, #e2e8f0);
          background: var(--surface-subtle, #f8fafc);
        }
        .curbside-chat-header h3 {
          margin: 0;
          font-size: 1.05rem;
          font-weight: 700;
        }
        .curbside-chat-header p {
          margin: 2px 0 0;
          font-size: 0.8rem;
          color: #64748b;
        }
        .curbside-close-button {
          background: transparent;
          border: none;
          padding: 6px;
          cursor: pointer;
          color: #64748b;
          border-radius: 8px;
        }
        .curbside-close-button:hover {
          background: #e2e8f0;
          color: #0f172a;
        }
        .curbside-chat-alert {
          background: #fef2f2;
          color: #b91c1c;
          padding: 8px 16px;
          font-size: 0.82rem;
          border-bottom: 1px solid #fecaca;
        }
        .curbside-chat-body {
          flex: 1;
          overflow-y: auto;
          padding: 16px;
          background: #f1f5f9;
        }
        .curbside-chat-loading,
        .curbside-chat-empty {
          height: 100%;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          color: #64748b;
          gap: 6px;
        }
        .curbside-message-list {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .curbside-message-bubble {
          max-width: 82%;
          padding: 9px 13px;
          border-radius: 14px;
          font-size: 0.88rem;
          line-height: 1.35;
        }
        .curbside-message-bubble.is-mine {
          align-self: flex-end;
          background: #0284c7;
          color: #ffffff;
          border-bottom-right-radius: 3px;
        }
        .curbside-message-bubble.is-counterpart {
          align-self: flex-start;
          background: #ffffff;
          color: #1e293b;
          border-bottom-left-radius: 3px;
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
        }
        .curbside-message-author {
          display: flex;
          justify-content: space-between;
          align-items: baseline;
          gap: 12px;
          margin-bottom: 3px;
          font-size: 0.72rem;
          opacity: 0.88;
        }
        .curbside-message-bubble p {
          margin: 0;
          word-break: break-word;
        }
        .curbside-read-marker {
          display: flex;
          justify-content: flex-end;
          align-items: center;
          margin-top: 2px;
          font-size: 0.7rem;
          opacity: 0.85;
        }
        .curbside-chat-footer {
          padding: 10px 14px 14px;
          border-top: 1px solid var(--border-subtle, #e2e8f0);
          background: #ffffff;
        }
        .curbside-chat-footer.is-closed {
          text-align: center;
          color: #64748b;
          padding: 14px;
          background: #f8fafc;
        }
        .curbside-chips-row {
          display: flex;
          gap: 6px;
          overflow-x: auto;
          padding-bottom: 8px;
          margin-bottom: 6px;
          scrollbar-width: thin;
        }
        .curbside-chip-btn {
          white-space: nowrap;
          font-size: 0.74rem;
          padding: 5px 10px;
          border-radius: 12px;
          border: 1px solid #cbd5e1;
          background: #f8fafc;
          color: #334155;
          cursor: pointer;
          transition: all 0.15s;
        }
        .curbside-chip-btn:hover:not(:disabled) {
          background: #e2e8f0;
          color: #0f172a;
        }
        .curbside-input-form {
          display: flex;
          gap: 8px;
        }
        .curbside-input-form input {
          flex: 1;
          padding: 9px 13px;
          border-radius: 10px;
          border: 1px solid #cbd5e1;
          font-size: 0.88rem;
          outline: none;
        }
        .curbside-input-form input:focus {
          border-color: #0284c7;
        }
        .curbside-input-form button {
          padding: 0 14px;
          border-radius: 10px;
          border: none;
          background: #0284c7;
          color: #ffffff;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .curbside-input-form button:disabled {
          opacity: 0.45;
          cursor: not-allowed;
        }
        .spin {
          animation: spin 1s linear infinite;
        }
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </dialog>
  );
}
