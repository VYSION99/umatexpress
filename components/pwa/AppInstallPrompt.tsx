"use client";

import { useEffect, useMemo, useState } from "react";
import { Download, Smartphone, X } from "lucide-react";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

const DISMISSED_KEY = "umatexpress.installPrompt.dismissedAt";
const DISMISS_DAYS = 7;

function isStandaloneMode() {
  if (typeof window === "undefined") return false;
  const navigatorWithStandalone = navigator as Navigator & { standalone?: boolean };
  return window.matchMedia("(display-mode: standalone)").matches || Boolean(navigatorWithStandalone.standalone);
}

function recentlyDismissed() {
  try {
    const dismissedAt = Number(localStorage.getItem(DISMISSED_KEY) || 0);
    return dismissedAt > 0 && Date.now() - dismissedAt < DISMISS_DAYS * 24 * 60 * 60 * 1000;
  } catch {
    return false;
  }
}

function rememberDismissal() {
  try {
    localStorage.setItem(DISMISSED_KEY, String(Date.now()));
  } catch {
    // Storage can be blocked in private browsers. The prompt can simply return next visit.
  }
}

// The shell service worker is cache-backed, so it must not run against the dev
// server: it would serve yesterday's CSS and JS while the server recompiles.
// Console pages are staff surfaces: they must never be cached by a worker, and
// the install prompt belongs to the student app only.
function isConsoleSurface() {
  return window.location.pathname === "/console" || window.location.pathname.startsWith("/console/");
}

function serviceWorkerAllowed() {
  if (process.env.NODE_ENV !== "production") return false;
  if (isConsoleSurface()) return false;
  const { hostname, protocol } = window.location;
  return protocol === "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
}

export function AppInstallPrompt() {
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [standalone, setStandalone] = useState(false);
  const [visible, setVisible] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const canNativeInstall = Boolean(installPrompt);
  const shouldRender = visible && !standalone;
  const copy = useMemo(() => {
    if (canNativeInstall) {
      return {
        title: "Install UMaTeXPRESS",
        body: "Save the platform to your home screen for quick access to campusRide, vacationRide, tickets, and driver tools.",
        action: "Install app",
      };
    }
    return {
      title: "Add UMaTeXPRESS to your home screen",
      body: "On iPhone, open Safari, tap Share, then choose Add to Home Screen. On Android, use your browser menu if the install button is not shown.",
      action: "How to install",
    };
  }, [canNativeInstall]);

  useEffect(() => {
    if ("serviceWorker" in navigator && serviceWorkerAllowed()) {
      navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    }
    // The install prompt belongs to the student app: a staff console is never
    // offered for installation and never cached by the shell worker.
    if (isConsoleSurface()) return;

    const initialStandalone = isStandaloneMode();
    queueMicrotask(() => setStandalone(initialStandalone));
    if (!initialStandalone && !recentlyDismissed()) {
      const timer = window.setTimeout(() => setVisible(true), 1400);
      return () => window.clearTimeout(timer);
    }
  }, []);

  useEffect(() => {
    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
      if (!recentlyDismissed() && !isConsoleSurface()) setVisible(true);
    };
    const onInstalled = () => {
      setInstallPrompt(null);
      setVisible(false);
      setStandalone(true);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  async function install() {
    if (!installPrompt) {
      setExpanded(true);
      return;
    }
    await installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    if (choice.outcome === "accepted") {
      setInstallPrompt(null);
      setVisible(false);
      setStandalone(true);
    }
  }

  function dismiss() {
    rememberDismissal();
    setVisible(false);
  }

  if (!shouldRender) return null;

  return <aside className={`app-install-prompt${expanded ? " is-expanded" : ""}`} aria-label="Install UMaTeXPRESS app">
    <button className="app-install-main" onClick={install}>
      <span><Smartphone size={18} /></span>
      <strong>{expanded ? copy.title : "Install app"}</strong>
      {expanded && <small>{copy.body}</small>}
      <i><Download size={16} /> {copy.action}</i>
    </button>
    <button className="app-install-dismiss" aria-label="Dismiss install prompt" onClick={dismiss}><X size={16} /></button>
  </aside>;
}
