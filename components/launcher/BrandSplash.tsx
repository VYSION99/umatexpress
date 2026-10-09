"use client";

import { type CSSProperties, useCallback, useEffect, useState } from "react";
import "./brand-splash.css";

export const SPLASH_DURATION_MS = 6000;
export const SPLASH_WORDMARK = "UMATeXPRESS";
export const SPLASH_STAGES = [
  "darkness",
  "particle-emergence",
  "particle-convergence",
  "left-circuit",
  "right-circuit",
  "orbital-draw",
  "main-leaf",
  "lower-leaf-details",
  "emblem-energy-pulse",
  "wordmark-assembly",
  "underline-light-sweep",
  "final-reveal",
] as const;

const STORAGE_KEY = "umatexpress:intro-played:v1";
const WORDMARK_SLICES = [
  [13.8, 8.3], [22.1, 7.1], [29.2, 6.5], [35.7, 5.8], [41.5, 9.2], [50.7, 7.1],
  [57.8, 7.1], [64.9, 6.2], [71.1, 6.5], [77.6, 6.4], [84, 6.3],
] as const;
const PARTICLES = Array.from({ length: 30 }, (_, index) => ({
  angle: (index * 137.5) % 360,
  distance: 22 + ((index * 29) % 48),
  delay: (index % 10) * 28,
  size: 1 + (index % 4) * 0.65,
}));

type SplashStyle = CSSProperties & Record<`--${string}`, string | number>;

function OriginalFragment({ className }: { className: string }) {
  return <img className={`brand-splash-fragment ${className}`} src="/logo-watermark.png" alt="" draggable={false} />;
}

/** The untouched source image becomes the final frame after exact masked copies move into place. */
export function BrandSplash() {
  const [visible, setVisible] = useState(true);
  const [leaving, setLeaving] = useState(false);
  const [assetFailed, setAssetFailed] = useState(false);

  const dismiss = useCallback(() => {
    setLeaving(true);
    window.setTimeout(() => setVisible(false), 300);
  }, []);

  useEffect(() => {
    let played = false;
    try { played = sessionStorage.getItem(STORAGE_KEY) === "1"; } catch { /* storage is optional */ }
    const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    const reloaded = navigation?.type === "reload";
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (played || reloaded || reduced) {
      const skipTimer = window.setTimeout(() => setVisible(false), 0);
      return () => window.clearTimeout(skipTimer);
    }

    try { sessionStorage.setItem(STORAGE_KEY, "1"); } catch { /* the animation still works */ }
    document.documentElement.classList.add("brand-splash-active");
    const leaveTimer = window.setTimeout(() => setLeaving(true), 5700);
    const removeTimer = window.setTimeout(() => setVisible(false), SPLASH_DURATION_MS + 40);
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") dismiss(); };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(leaveTimer);
      window.clearTimeout(removeTimer);
      window.removeEventListener("keydown", onKeyDown);
      document.documentElement.classList.remove("brand-splash-active");
    };
  }, [dismiss]);

  useEffect(() => {
    if (!visible) {
      document.documentElement.classList.remove("brand-splash-active");
      document.documentElement.classList.add("splash-already-seen");
    }
  }, [visible]);

  if (!visible) return null;

  return <div className={`brand-splash${leaving ? " is-leaving" : ""}${assetFailed ? " has-asset-fallback" : ""}`} data-duration={SPLASH_DURATION_MS} data-stages={SPLASH_STAGES.length}>
    <div className="brand-splash-atmosphere" aria-hidden="true" />
    <div className="brand-splash-particles" aria-hidden="true">
      {PARTICLES.map((particle, index) => <i key={index} style={{
        "--particle-angle": `${particle.angle}deg`,
        "--particle-distance": `${particle.distance}vmin`,
        "--particle-delay": `${particle.delay}ms`,
        "--particle-size": `${particle.size}px`,
      } as SplashStyle} />)}
    </div>

    <div className="brand-splash-stage" aria-hidden="true" data-wordmark={SPLASH_WORDMARK}>
      <svg className="brand-splash-orbit" viewBox="0 0 480 381" focusable="false">
        <defs><filter id="splash-orbit-glow" x="-30%" y="-50%" width="160%" height="200%"><feGaussianBlur stdDeviation="3.5" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter></defs>
        <ellipse cx="240" cy="183" rx="190" ry="55" transform="rotate(-12 240 183)" pathLength="1" />
      </svg>
      <OriginalFragment className="is-left-circuit" />
      <OriginalFragment className="is-right-circuit" />
      <OriginalFragment className="is-main-leaf" />
      <OriginalFragment className="is-lower-leaf" />
      <div className="brand-splash-wordmark">
        {WORDMARK_SLICES.map(([left, width], index) => <span className="brand-splash-letter" key={`${left}-${width}`} style={{ "--letter-left": `${left}%`, "--letter-width": `${width}%`, "--letter-offset": `${(5 - index) * 7}px`, "--letter-delay": `${4050 + index * 58}ms` } as SplashStyle}><img src="/logo-web.png" alt="" draggable={false} /></span>)}
      </div>
      <span className="brand-splash-pulse" />
      <span className="brand-splash-sweep" />
      <img className="brand-splash-final" src="/logo-web.png" alt="" draggable={false} onError={() => setAssetFailed(true)} />
      <svg className="brand-splash-fallback" viewBox="0 0 480 381" focusable="false"><path d="M152 222C108 139 157 55 311 36C292 132 242 200 152 222Z" /><path d="M162 222C196 171 235 111 294 54" /><text x="240" y="294" textAnchor="middle">{SPLASH_WORDMARK}</text></svg>
    </div>
    <button className="brand-splash-skip" type="button" onClick={dismiss}>Skip intro</button>
  </div>;
}
