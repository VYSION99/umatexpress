"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { CinemaPartner } from "@/lib/cinema-engine/partners";
import { FilmSlate, ShieldCheck, Ticket } from "@/components/ui/MaterialIcon";

export function CinemaPartnerWorkspace() {
  const [partner, setPartner] = useState<CinemaPartner | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    async function fetchPartner() {
      try {
        const response = await fetch("/api/console/cinema/partners", { credentials: "same-origin", cache: "no-store" });
        const data = await response.json() as { partner?: CinemaPartner; error?: string };
        if (!response.ok) throw new Error(data.error || "Failed to load partner profile.");
        setPartner(data.partner || null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load profile");
      } finally {
        setLoading(false);
      }
    }
    void fetchPartner();
  }, []);

  if (loading) {
    return (
      <section className="console-card">
        <p className="console-card-detail">Loading your cinema partner workspace...</p>
      </section>
    );
  }

  if (error || !partner) {
    return (
      <section className="console-card">
        <h2>Partner Workspace</h2>
        <p className="console-auth-error">{error || "Partner profile not found. Please contact support."}</p>
      </section>
    );
  }

  const isPending = partner.status === "PENDING";
  const isActive = partner.status === "ACTIVE";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
      <section className="console-card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "1rem" }}>
          <div>
            <span className="console-card-label">CINEMA PARTNER WORKSPACE</span>
            <h2>{partner.organizationName}</h2>
            <p className="console-card-detail">
              Screening Partner Contact: <strong>{partner.name}</strong> ({partner.email})
            </p>
          </div>
          <div>
            <span
              style={{
                display: "inline-block",
                padding: "0.35rem 0.75rem",
                borderRadius: "999px",
                fontSize: "0.85rem",
                fontWeight: 600,
                backgroundColor: isActive ? "#dcfce7" : isPending ? "#fef9c3" : "#fee2e2",
                color: isActive ? "#15803d" : isPending ? "#854d0e" : "#b91c1c",
              }}
            >
              {partner.status}
            </span>
          </div>
        </div>

        {isPending && (
          <div style={{ marginTop: "1rem", padding: "1rem", backgroundColor: "rgba(234, 179, 8, 0.08)", borderRadius: "8px", border: "1px solid rgba(234, 179, 8, 0.2)" }}>
            <h4 style={{ margin: "0 0 0.5rem 0", color: "#854d0e" }}>Account Under Verification</h4>
            <p style={{ margin: 0, fontSize: "0.9rem", color: "#854d0e" }}>
              Your partner account has been created and is waiting for review by platform operations. Once verified, official screening slots and live room syndication will be enabled automatically.
            </p>
          </div>
        )}

        {isActive && (
          <div style={{ marginTop: "1rem", padding: "1rem", backgroundColor: "rgba(34, 197, 94, 0.08)", borderRadius: "8px", border: "1px solid rgba(34, 197, 94, 0.2)" }}>
            <h4 style={{ margin: "0 0 0.5rem 0", color: "#15803d" }}>Partner Verified</h4>
            <p style={{ margin: 0, fontSize: "0.9rem", color: "#15803d" }}>
              Your venue and organization are verified. You can schedule campus screenings and broadcast watch sessions.
            </p>
          </div>
        )}
      </section>

      <section className="console-card">
        <h2>Screenings & Showings</h2>
        <p className="console-card-detail">
          Publish official screenings for university movie nights, debate panels, and campus club premieres.
        </p>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "1rem", marginTop: "1rem" }}>
          <div className="console-card" style={{ background: "var(--console-subtle-bg, #f9fafb)", border: "1px solid var(--console-border, #e5e7eb)" }}>
            <span className="console-card-icon"><FilmSlate size={20} /></span>
            <h3>Schedule Screening</h3>
            <p style={{ fontSize: "0.85rem", opacity: 0.8 }}>Create an official watch party with auditorium limits, discussions, and student RSVPs.</p>
            <div style={{ marginTop: "0.75rem" }}>
              <Link href="/cinema/events" style={{ fontWeight: 600, color: "var(--brand-primary, #6e46a8)" }}>
                Go to Event Creator &rarr;
              </Link>
            </div>
          </div>

          <div className="console-card" style={{ background: "var(--console-subtle-bg, #f9fafb)", border: "1px solid var(--console-border, #e5e7eb)" }}>
            <span className="console-card-icon"><Ticket size={20} /></span>
            <h3>Browse Public Lobby</h3>
            <p style={{ fontSize: "0.85rem", opacity: 0.8 }}>View ongoing watch rooms, participant counts, and active video streams.</p>
            <div style={{ marginTop: "0.75rem" }}>
              <Link href="/cinema" style={{ fontWeight: 600, color: "var(--brand-primary, #6e46a8)" }}>
                Open Cinema Lobby &rarr;
              </Link>
            </div>
          </div>

          <div className="console-card" style={{ background: "var(--console-subtle-bg, #f9fafb)", border: "1px solid var(--console-border, #e5e7eb)" }}>
            <span className="console-card-icon"><ShieldCheck size={20} /></span>
            <h3>Account Security</h3>
            <p style={{ fontSize: "0.85rem", opacity: 0.8 }}>Manage your console login password and registered partner credentials.</p>
            <div style={{ marginTop: "0.75rem" }}>
              <Link href="/console/account" style={{ fontWeight: 600, color: "var(--brand-primary, #6e46a8)" }}>
                Account Settings &rarr;
              </Link>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
