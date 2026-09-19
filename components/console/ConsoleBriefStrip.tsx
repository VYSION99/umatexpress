"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, Sparkles } from "lucide-react";
import type { ConsoleBrief, ConsoleBriefItem } from "@/lib/console-assistant";

/** Action items lead; the rest keep the order the brief read them in. */
function ordered(items: ConsoleBriefItem[]) {
  return [...items].sort((left, right) => Number(right.tone === "action") - Number(left.tone === "action"));
}

/**
 * The daily brief on the console home: the same data the assistant's panel
 * shows, compact enough to sit above the service directory. It never blocks
 * the page — while it loads, fails or finds nothing, nothing is rendered.
 */
export function ConsoleBriefStrip() {
  const [brief, setBrief] = useState<ConsoleBrief | null>(null);
  const requested = useRef(false);

  useEffect(() => {
    if (requested.current) return;
    requested.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/console/assistant/brief", { credentials: "same-origin", cache: "no-store" });
        if (!response.ok) return;
        const data = await response.json();
        if (!cancelled && data && Array.isArray(data.items)) setBrief(data as ConsoleBrief);
      } catch {
        // The directory below is the page; the brief is a convenience.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (!brief) return null;
  const items = ordered(brief.items).slice(0, 5);
  const hasActions = items.some((item) => item.tone === "action");

  return <section className={`console-brief-strip${hasActions ? " has-actions" : ""}`} aria-label="Daily brief">
    <div className="console-brief-lead">
      <span className="console-brief-kicker"><Sparkles size={15}/> Daily brief</span>
      <p>{brief.summary}</p>
    </div>
    {items.length > 0 && <ul>
      {items.map((item) => <li key={item.key} className={`tone-${item.tone}`}>
        {item.href
          ? <Link href={item.href} title={item.detail ? `${item.label} — ${item.detail}` : item.label}>
              <span className="console-brief-value">{item.value}</span>
              <span className="console-brief-label">{item.label}</span>
              <ArrowRight size={14} aria-hidden/>
            </Link>
          : <span className="console-brief-plain">
              <span className="console-brief-value">{item.value}</span>
              <span className="console-brief-label">{item.label}</span>
            </span>}
      </li>)}
    </ul>}
    {brief.note && <p className="console-brief-note">{brief.note}</p>}
    <button type="button" className="console-brief-ask" onClick={() => window.dispatchEvent(new Event("console-assistant:open"))}>
      Ask the assistant
    </button>
  </section>;
}
