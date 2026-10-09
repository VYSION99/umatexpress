"use client";

import { useEffect, useState } from "react";
import "./reload-skeleton.css";

export const RELOAD_SKELETON_MINIMUM_MS = 650;

/** A first-paint placeholder shown only for a browser reload of the homepage. */
export function ReloadSkeleton() {
  const [visible, setVisible] = useState(true);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    const reloaded = navigation?.type === "reload";
    if (!reloaded) {
      const skipTimer = window.setTimeout(() => setVisible(false), 0);
      return () => window.clearTimeout(skipTimer);
    }

    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const leaveTimer = window.setTimeout(() => setLeaving(true), reduced ? 120 : RELOAD_SKELETON_MINIMUM_MS);
    const removeTimer = window.setTimeout(() => {
      setVisible(false);
      document.documentElement.classList.remove("page-is-reloading");
    }, (reduced ? 120 : RELOAD_SKELETON_MINIMUM_MS) + 240);
    return () => {
      window.clearTimeout(leaveTimer);
      window.clearTimeout(removeTimer);
      document.documentElement.classList.remove("page-is-reloading");
    };
  }, []);

  if (!visible) return null;

  return <div className={`reload-skeleton${leaving ? " is-leaving" : ""}`} aria-hidden="true">
    <header className="reload-skeleton-bar">
      <span className="reload-skeleton-mark" />
      <span className="reload-skeleton-brand-lines"><i /><i /></span>
      <span className="reload-skeleton-nav"><i /><i /><i /></span>
      <span className="reload-skeleton-actions"><i /><i /></span>
    </header>
    <main className="reload-skeleton-main">
      <section className="reload-skeleton-hero">
        <div className="reload-skeleton-copy">
          <i className="reload-skeleton-pill" />
          <div className="reload-skeleton-title"><i /><i /></div>
          <div className="reload-skeleton-text"><i /><i /><i /></div>
          <div className="reload-skeleton-buttons"><i /><i /></div>
          <i className="reload-skeleton-caption" />
        </div>
        <div className="reload-skeleton-companion">
          <i className="reload-skeleton-kicker" />
          <div className="reload-skeleton-panel-title"><i /><i /></div>
          <i className="reload-skeleton-panel-copy" />
          <div className="reload-skeleton-panel-rows"><i /><i /><i /></div>
        </div>
      </section>
      <section className="reload-skeleton-services">
        <div className="reload-skeleton-section-head"><span><i /><i /></span><i /></div>
        <div className="reload-skeleton-cards"><article /><article /><article /><article /></div>
      </section>
    </main>
  </div>;
}
