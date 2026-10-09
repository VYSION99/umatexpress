"use client";

import { useRef, type PointerEvent } from "react";

/** A mobile-only grabber. Dragging down or tapping it dismisses the sheet. */
export function SheetHandle({ onDismiss, disabled = false }: { onDismiss: () => void; disabled?: boolean }) {
  const start = useRef<{ pointerId: number; y: number } | null>(null);

  function sheet(event: PointerEvent<HTMLButtonElement>) {
    return event.currentTarget.parentElement;
  }

  function reset(event: PointerEvent<HTMLButtonElement>) {
    sheet(event)?.style.removeProperty("--sheet-pull");
    start.current = null;
  }

  return <button
    type="button"
    className="app-sheet-handle"
    aria-label="Close sheet"
    disabled={disabled}
    onClick={(event) => { if (event.detail === 0) onDismiss(); }}
    onPointerDown={(event) => {
      start.current = { pointerId: event.pointerId, y: event.clientY };
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={(event) => {
      if (start.current?.pointerId !== event.pointerId) return;
      const distance = Math.max(0, event.clientY - start.current.y);
      sheet(event)?.style.setProperty("--sheet-pull", `${Math.min(distance, 180)}px`);
    }}
    onPointerUp={(event) => {
      const distance = start.current?.pointerId === event.pointerId ? event.clientY - start.current.y : 0;
      reset(event);
      if (distance > 72 || Math.abs(distance) < 8) onDismiss();
    }}
    onPointerCancel={reset}
  ><span aria-hidden="true" /></button>;
}
