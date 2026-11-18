"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { TOURS } from "@/lib/tour-engine/manifests";
import type { TourContextValue, TourDefinition, TourProgress, TourStep } from "@/lib/tour-engine/types";
import { TourOverlay } from "./TourOverlay";

const STORAGE_KEY = "umatexpress:tour-progress:v1";

const TourContext = createContext<TourContextValue | null>(null);

function loadProgress(): TourProgress {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as TourProgress) : {};
  } catch {
    return {};
  }
}

function saveProgress(progress: TourProgress) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
  } catch {
    // Storage quota or restriction fallback
  }
}

export function TourProvider({ children }: { children: ReactNode }) {
  const [activeTour, setActiveTour] = useState<TourDefinition | null>(null);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [progress, setProgress] = useState<TourProgress>({});
  const [ready, setReady] = useState(false);

  // Initialize progress from storage
  useEffect(() => {
    setProgress(loadProgress());
    setReady(true);
  }, []);

  const currentStep: TourStep | null = useMemo(() => {
    if (!activeTour) return null;
    return activeTour.steps[currentStepIndex] || null;
  }, [activeTour, currentStepIndex]);

  const isTourCompleted = useCallback(
    (tourId: string) => Boolean(progress[tourId]?.completedAt),
    [progress],
  );

  const hasSeenTour = useCallback(
    (tourId: string) => Boolean(progress[tourId]?.completedAt || progress[tourId]?.skippedAt),
    [progress],
  );

  const startTour = useCallback((tourId: string) => {
    const tour = TOURS[tourId];
    if (!tour || !tour.steps.length) return;
    setActiveTour(tour);
    setCurrentStepIndex(0);
  }, []);

  const finishTour = useCallback(() => {
    if (!activeTour) return;
    const tourId = activeTour.id;
    const nextProgress: TourProgress = {
      ...progress,
      [tourId]: { ...progress[tourId], completedAt: new Date().toISOString() },
    };
    setProgress(nextProgress);
    saveProgress(nextProgress);
    setActiveTour(null);
    setCurrentStepIndex(0);
  }, [activeTour, progress]);

  const dismissTour = useCallback(() => {
    if (!activeTour) return;
    const tourId = activeTour.id;
    const nextProgress: TourProgress = {
      ...progress,
      [tourId]: { ...progress[tourId], skippedAt: new Date().toISOString() },
    };
    setProgress(nextProgress);
    saveProgress(nextProgress);
    setActiveTour(null);
    setCurrentStepIndex(0);
  }, [activeTour, progress]);

  const nextStep = useCallback(() => {
    if (!activeTour) return;
    if (currentStepIndex < activeTour.steps.length - 1) {
      setCurrentStepIndex((prev) => prev + 1);
    } else {
      finishTour();
    }
  }, [activeTour, currentStepIndex, finishTour]);

  const prevStep = useCallback(() => {
    if (!activeTour) return;
    if (currentStepIndex > 0) {
      setCurrentStepIndex((prev) => prev - 1);
    }
  }, [activeTour, currentStepIndex]);

  const resetTours = useCallback(() => {
    setProgress({});
    if (typeof window !== "undefined") {
      try {
        window.localStorage.removeItem(STORAGE_KEY);
      } catch {}
    }
    setActiveTour(null);
    setCurrentStepIndex(0);
  }, []);

  // Context value object
  const value: TourContextValue = useMemo(
    () => ({
      activeTour,
      currentStep,
      currentStepIndex,
      totalSteps: activeTour?.steps.length || 0,
      isRunning: Boolean(activeTour && currentStep),
      startTour,
      nextStep,
      prevStep,
      dismissTour,
      finishTour,
      isTourCompleted,
      hasSeenTour,
      resetTours,
    }),
    [
      activeTour,
      currentStep,
      currentStepIndex,
      startTour,
      nextStep,
      prevStep,
      dismissTour,
      finishTour,
      isTourCompleted,
      hasSeenTour,
      resetTours,
    ],
  );

  return (
    <TourContext.Provider value={value}>
      {children}
      {ready && activeTour && currentStep && (
        <TourOverlay
          tour={activeTour}
          step={currentStep}
          stepIndex={currentStepIndex}
          totalSteps={activeTour.steps.length}
          onNext={nextStep}
          onPrev={prevStep}
          onDismiss={dismissTour}
        />
      )}
    </TourContext.Provider>
  );
}

export function useTour() {
  const context = useContext(TourContext);
  if (!context) {
    throw new Error("useTour must be used within a TourProvider");
  }
  return context;
}
