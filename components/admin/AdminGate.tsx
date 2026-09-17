"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";

export function AdminGate({ children, label = "administrator" }: { children: ReactNode; label?: string }) {
  const router = useRouter();
  const [authorized, setAuthorized] = useState(false);

  useEffect(() => {
    let active = true;
    fetch("/api/admin/auth", { cache:"no-store", credentials:"same-origin" })
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((data) => {
        if (!active) return;
        if (data.mustChangePassword) router.replace("/admin/change-password");
        else setAuthorized(true);
      })
      .catch(() => {
        if (active) router.replace("/admin/login");
      });
    return () => { active = false; };
  }, [router]);

  if (!authorized) return <main className="admin-auth-check"><span className="spin">◌</span><p>Checking {label} access…</p></main>;
  return children;
}

