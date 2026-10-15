"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "@/components/ui/MaterialIcon";
import { SheetHandle } from "@/components/ui/SheetHandle";

/** Native modal focus containment, Escape, inert background, and focus restoration. */
export function CinemaDialog({ open, title, onClose, children, busy = false }: {
  open: boolean; title: string; onClose: () => void; children: ReactNode; busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const node = ref.current;
    if (!open || !node) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    node.showModal();
    document.body.style.overflow = "hidden";
    return () => { node.close(); document.body.style.overflow = overflow; previous?.focus(); };
  }, [open]);
  return <dialog ref={ref} className="cinema-dialog" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}
    onClick={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <SheetHandle onDismiss={onClose} disabled={busy} />
    <header><h2 id={titleId}>{title}</h2><button type="button" aria-label="Close" disabled={busy} onClick={onClose}><X size={20} aria-hidden /></button></header>
    <div className="cinema-dialog-body">{open && children}</div>
  </dialog>;
}
