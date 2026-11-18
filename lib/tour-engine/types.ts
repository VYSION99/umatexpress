export type TourPlacement = "top" | "bottom" | "left" | "right" | "center";

export type TourStep = {
  id: string;
  targetSelector: string;
  title: string;
  content: string;
  placement?: TourPlacement;
  mobilePlacement?: "top" | "bottom" | "center";
  actionLabel?: string;
  spotlightPadding?: number;
};

export type TourDefinition = {
  id: string;
  title: string;
  steps: TourStep[];
  autoStartOnFirstVisit?: boolean;
};

export type TourProgress = Record<string, { completedAt?: string; skippedAt?: string }>;

export type TourContextValue = {
  activeTour: TourDefinition | null;
  currentStep: TourStep | null;
  currentStepIndex: number;
  totalSteps: number;
  isRunning: boolean;
  startTour: (tourId: string) => void;
  nextStep: () => void;
  prevStep: () => void;
  dismissTour: () => void;
  finishTour: () => void;
  isTourCompleted: (tourId: string) => boolean;
  hasSeenTour: (tourId: string) => boolean;
  resetTours: () => void;
};
