"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { SheetHandle } from "./SheetHandle";

let activeSheet: HTMLDialogElement | null = null;

/** Shared native modal surface for route navigation sheets. */
export function AppBottomSheet({ open, title, onClose, children, className = "", busy = false }: {
  open: boolean; title: string; onClose: () => void; children: ReactNode; className?: string; busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);

  useEffect(() => {
    const node = ref.current;
    if (!open || !node) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (activeSheet && activeSheet !== node) {
      activeSheet.close();
      activeSheet.dispatchEvent(new Event("app-sheet-superseded"));
    }
    activeSheet = node;
    node.showModal();
    const superseded = () => closeRef.current();
    node.addEventListener("app-sheet-superseded", superseded);

    function updateViewport() {
      const viewport = window.visualViewport;
      const offset = viewport ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop) : 0;
      node?.style.setProperty("--app-keyboard-offset", `${offset > 100 ? Math.round(offset) : 0}px`);
      node?.toggleAttribute("data-keyboard-open", offset > 100);
    }
    updateViewport();
    window.visualViewport?.addEventListener("resize", updateViewport);
    window.visualViewport?.addEventListener("scroll", updateViewport);
    return () => {
      window.visualViewport?.removeEventListener("resize", updateViewport);
      window.visualViewport?.removeEventListener("scroll", updateViewport);
      node.removeEventListener("app-sheet-superseded", superseded);
      if (node.open) node.close();
      if (activeSheet === node) activeSheet = null;
      previousFocus?.focus();
    };
  }, [open]);

  return <dialog ref={ref} className={`app-bottom-sheet ${className}`} aria-label={title}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}
    onClick={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <SheetHandle onDismiss={onClose} disabled={busy} />
    <div className="app-bottom-sheet-content">{children}</div>
  </dialog>;
}
