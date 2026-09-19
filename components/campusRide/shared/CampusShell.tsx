import Link from "next/link";
import type { ReactNode } from "react";
import { CampusNav } from "./CampusNav";

export function CampusShell({ area, title, subtitle, children }: { area: string; title: string; subtitle: string; children: ReactNode }) {
  const interfaceClass = area === "CAMPUSRIDE" ? "campus-student-shell" : area.includes("DRIVER") ? "campus-driver-shell" : area.includes("ADMIN") ? "campus-admin-shell" : "";
  return <main className={`campus-shell ${interfaceClass}`}>
    <header className="campus-hero">
      <Link href="/" className="campus-logo" aria-label="UMaTeXPRESS home"><img src="/logo-mark.png" alt="UMaTeXPRESS" /></Link>
      <div className="campus-hero-copy">
        <p>{area}</p>
        <h1>{title}</h1>
        <span>{subtitle}</span>
      </div>
      <CampusNav area={area} variant="desktop" />
    </header>
    {children}
    <CampusNav area={area} variant="mobile" />
  </main>;
}

export function CampusStatusBanner({ title, message }: { title: string; message: string }) {
  return <section className="campus-status-banner"><strong>{title}</strong><span>{message}</span></section>;
}
