"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import type { TourDefinition, TourStep } from "@/lib/tour-engine/types";
import "./tour.css";

type TourOverlayProps = {
  tour: TourDefinition;
  step: TourStep;
  stepIndex: number;
  totalSteps: number;
  onNext: () => void;
  onPrev: () => void;
  onDismiss: () => void;
};

type TargetRect = {
  top: number;
  left: number;
  width: number;
  height: number;
  bottom: number;
  right: number;
};

export function TourOverlay({
  tour,
  step,
  stepIndex,
  totalSteps,
  onNext,
  onPrev,
  onDismiss,
}: TourOverlayProps) {
  const [targetRect, setTargetRect] = useState<TargetRect | null>(null);
  const [popoverStyle, setPopoverStyle] = useState<React.CSSProperties>({});
  const popoverRef = useRef<HTMLDivElement>(null);

  // Measure and position around target element
  const updateTargetPosition = useCallback(() => {
    if (!step?.targetSelector) {
      setTargetRect(null);
      return;
    }

    const el = document.querySelector(step.targetSelector) as HTMLElement | null;
    if (!el) {
      setTargetRect(null);
      return;
    }

    const rect = el.getBoundingClientRect();
    setTargetRect({
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height,
      bottom: rect.bottom,
      right: rect.right,
    });

    // Add highlight class to target element
    el.classList.add("tour-target-highlight");

    // Scroll into view if needed
    const inView =
      rect.top >= 50 &&
      rect.left >= 0 &&
      rect.bottom <= (window.innerHeight - 50) &&
      rect.right <= window.innerWidth;

    if (!inView) {
      el.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
    }
  }, [step?.targetSelector]);

  // Effect to manage target highlight and scroll
  useEffect(() => {
    updateTargetPosition();

    // Listen for resize and scroll to keep spotlight synced
    const handleRecalc = () => updateTargetPosition();
    window.addEventListener("resize", handleRecalc, { passive: true });
    window.addEventListener("scroll", handleRecalc, { passive: true });

    return () => {
      window.removeEventListener("resize", handleRecalc);
      window.removeEventListener("scroll", handleRecalc);
      if (step?.targetSelector) {
        const el = document.querySelector(step.targetSelector);
        el?.classList.remove("tour-target-highlight");
      }
    };
  }, [updateTargetPosition, step?.targetSelector]);

  // Position popover on desktop
  useEffect(() => {
    if (typeof window === "undefined") return;
    const isMobile = window.innerWidth <= 768;
    if (isMobile) {
      // Handled by CSS bottom docking
      setPopoverStyle({});
      return;
    }

    if (!targetRect) {
      // Center placement when target not found or centered
      setPopoverStyle({
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
      });
      return;
    }

    const popoverWidth = 380;
    const popoverHeight = popoverRef.current?.offsetHeight || 180;
    const padding = step.spotlightPadding || 8;
    const margin = 14;

    const placement = step.placement || "bottom";
    let top = 0;
    let left = 0;

    switch (placement) {
      case "top":
        top = targetRect.top - padding - popoverHeight - margin;
        left = targetRect.left + targetRect.width / 2 - popoverWidth / 2;
        break;
      case "bottom":
        top = targetRect.bottom + padding + margin;
        left = targetRect.left + targetRect.width / 2 - popoverWidth / 2;
        break;
      case "left":
        top = targetRect.top + targetRect.height / 2 - popoverHeight / 2;
        left = targetRect.left - padding - popoverWidth - margin;
        break;
      case "right":
        top = targetRect.top + targetRect.height / 2 - popoverHeight / 2;
        left = targetRect.right + padding + margin;
        break;
      case "center":
      default:
        top = window.innerHeight / 2 - popoverHeight / 2;
        left = window.innerWidth / 2 - popoverWidth / 2;
        break;
    }

    // Keep within viewport bounds
    const safeMargin = 16;
    if (left < safeMargin) left = safeMargin;
    if (left + popoverWidth > window.innerWidth - safeMargin) {
      left = window.innerWidth - popoverWidth - safeMargin;
    }
    if (top < safeMargin) top = safeMargin;
    if (top + popoverHeight > window.innerHeight - safeMargin) {
      top = window.innerHeight - popoverHeight - safeMargin;
    }

    setPopoverStyle({
      top: `${Math.round(top)}px`,
      left: `${Math.round(left)}px`,
    });
  }, [targetRect, step?.placement, step?.spotlightPadding]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onDismiss();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        onNext();
      } else if (e.key === "ArrowLeft" && stepIndex > 0) {
        e.preventDefault();
        onPrev();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onDismiss, onNext, onPrev, stepIndex]);

  const pad = step.spotlightPadding || 8;

  return (
    <div className="tour-backdrop-layer" aria-modal="true" role="dialog" aria-labelledby="tour-card-title">
      {/* SVG Spotlight Mask */}
      <svg className="tour-spotlight-svg" aria-hidden="true">
        <defs>
          <mask id="tour-spotlight-mask">
            {/* White covers entire viewport */}
            <rect width="100%" height="100%" fill="white" />
            {/* Black rectangle punches hole around target */}
            {targetRect && (
              <rect
                x={Math.max(0, targetRect.left - pad)}
                y={Math.max(0, targetRect.top - pad)}
                width={targetRect.width + pad * 2}
                height={targetRect.height + pad * 2}
                rx={10}
                ry={10}
                fill="black"
              />
            )}
          </mask>
        </defs>
        <rect
          width="100%"
          height="100%"
          fill="rgba(15, 23, 42, 0.65)"
          mask="url(#tour-spotlight-mask)"
        />
      </svg>

      {/* Popover Card */}
      <div
        ref={popoverRef}
        className="tour-card-popover"
        style={popoverStyle}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="tour-card-header">
          <span className="tour-badge">
            {tour.title} • {stepIndex + 1}/{totalSteps}
          </span>
          <button
            type="button"
            className="tour-dismiss-btn"
            onClick={onDismiss}
            aria-label="Dismiss tour"
            title="Dismiss tour (Esc)"
          >
            ✕
          </button>
        </div>

        <h3 id="tour-card-title" className="tour-card-title">
          {step.title}
        </h3>

        <p className="tour-card-body">{step.content}</p>

        <div className="tour-card-footer">
          <div className="tour-dots-row" aria-hidden="true">
            {Array.from({ length: totalSteps }).map((_, i) => (
              <div
                key={i}
                className={`tour-dot ${i === stepIndex ? "is-active" : ""}`}
              />
            ))}
          </div>

          <div className="tour-actions-row">
            {stepIndex > 0 && (
              <button
                type="button"
                className="tour-btn-prev"
                onClick={onPrev}
                aria-label="Previous step"
              >
                Back
              </button>
            )}
            <button
              type="button"
              className="tour-btn-next"
              onClick={onNext}
              aria-label={stepIndex === totalSteps - 1 ? "Finish tour" : "Next step"}
            >
              {stepIndex === totalSteps - 1 ? (step.actionLabel || "Finish") : "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
