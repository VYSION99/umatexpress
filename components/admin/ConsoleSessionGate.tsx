"use client";

import { useEffect, useState, type ReactNode } from "react";

export type ConsoleSessionInfo = {
  authenticated: true;
  account: { id: string; email: string; name: string; role: string; status: string; profileId: string };
  mustChangePassword: boolean;
};

/**
 * The console's single client-side gate. It asks the session endpoint who is
 * signed in and never decides that on its own: the role it renders is the role
 * the server just confirmed, and every API call is re-checked server-side.
 */
export function ConsoleSessionGate({
  children,
  allowPasswordChange = false,
  label = "console access",
}: {
  children: (session: ConsoleSessionInfo) => ReactNode;
  allowPasswordChange?: boolean;
  label?: string;
}) {
  const [session, setSession] = useState<ConsoleSessionInfo | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/console/session", { cache: "no-store", credentials: "same-origin" })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("not signed in"))))
      .then((data: ConsoleSessionInfo) => {
        if (!active) return;
        if (data.mustChangePassword && !allowPasswordChange) {
          window.location.replace("/console/change-password");
          return;
        }
        setSession(data);
      })
      .catch(() => {
        if (active) window.location.replace("/console/login");
      });
    return () => { active = false; };
  }, [allowPasswordChange]);

  if (!session) {
    return <main className="console-check"><span className="console-spin" aria-hidden="true">◌</span><p>Checking {label}…</p></main>;
  }
  return children(session);
}
