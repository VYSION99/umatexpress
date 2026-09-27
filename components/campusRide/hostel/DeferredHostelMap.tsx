"use client";

import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { HostelMapProperty } from "./HostelMap";

const Map = lazy(() => import("./HostelMap").then(module => ({ default: module.HostelMap })));

export function DeferredHostelMap(props: { properties: HostelMapProperty[]; periodId?: string; title?: string }) {
  const container = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!container.current) return;
    if (!("IntersectionObserver" in window)) {
      const timer = globalThis.setTimeout(() => setVisible(true), 0);
      return () => globalThis.clearTimeout(timer);
    }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: "160px" });
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  return <div ref={container} className="hostel-deferred-map">
    {visible ? <Suspense fallback={<p role="status">Loading map…</p>}><Map {...props} /></Suspense> : <p>Map loads when you reach it.</p>}
  </div>;
}
