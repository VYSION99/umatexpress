"use client";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "@phosphor-icons/react";
import "./residency.css";

export function ResidencyDialog({ open, title, children, onClose, busy = false, drawer = false }: {
  open: boolean; title: string; children: ReactNode; onClose: () => void; busy?: boolean; drawer?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const node = dialog.current;
    if (!open || !node) return;
    const previousOverflow = document.body.style.overflow;
    node.showModal();
    document.body.style.overflow = "hidden";
    return () => { node.close(); document.body.style.overflow = previousOverflow; };
  }, [open]);
  return <dialog ref={dialog} className={`residency-dialog${drawer ? " residency-drawer" : ""}`} aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <header><h2 id={titleId}>{title}</h2><button type="button" aria-label="Close dialog" disabled={busy} onClick={onClose}><X size={22} aria-hidden /></button></header>
    <div className="residency-dialog-body">{open && children}</div>
  </dialog>;
}
