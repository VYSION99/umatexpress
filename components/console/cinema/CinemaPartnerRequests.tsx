"use client";

import { useCallback, useEffect, useState } from "react";
import type { CinemaPartner } from "@/lib/cinema-engine/partners";

export function CinemaPartnerRequests() {
  const [partners, setPartners] = useState<CinemaPartner[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [notes, setNotes] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const response = await fetch("/api/console/cinema/partners", { credentials: "same-origin", cache: "no-store" });
    const data = await response.json() as { partners?: CinemaPartner[]; error?: string };
    if (!response.ok) throw new Error(data.error || "Partner requests could not be loaded.");
    setPartners(data.partners || []);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void load().catch((problem) => setError(problem instanceof Error ? problem.message : "Partner requests could not be loaded.")), 0);
    return () => clearTimeout(timer);
  }, [load]);

  const decide = async (item: CinemaPartner, approve: boolean) => {
    setBusy(item.id);
    setError("");
    try {
      const response = await fetch("/api/console/cinema/partners", {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ partnerId: item.id, approve, reviewNote: notes[item.id] || "" }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "Decision could not be saved.");
      await load();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Decision could not be saved.");
    } finally {
      setBusy("");
    }
  };

  const pending = partners.filter((p) => p.status === "PENDING");

  return (
    <section className="console-card" aria-label="Cinema partner approvals">
      <h2>Cinema partner approvals</h2>
      <p>Review screening venues, student entertainment directors and cinema partners applying to publish official showings.</p>
      {error && <p role="alert" className="console-auth-error">{error}</p>}
      {pending.length === 0 ? (
        <p className="console-card-detail">No partner applications waiting for review.</p>
      ) : (
        <div className="console-table-wrap">
          <table className="console-table">
            <thead>
              <tr>
                <th>Partner / Venue</th>
                <th>Contact</th>
                <th>Verification & Decision</th>
              </tr>
            </thead>
            <tbody>
              {pending.map((item) => (
                <tr key={item.id}>
                  <td>
                    <strong>{item.organizationName}</strong>
                    <br />
                    <span style={{ fontSize: "0.85rem", opacity: 0.8 }}>Contact: {item.name}</span>
                  </td>
                  <td>
                    <div>{item.email}</div>
                    <small>{item.phone}</small>
                  </td>
                  <td>
                    <label>
                      Verification or rejection note
                      <textarea
                        rows={2}
                        maxLength={500}
                        value={notes[item.id] || ""}
                        onChange={(event) => setNotes((current) => ({ ...current, [item.id]: event.target.value }))}
                        placeholder="Confirm venue credentials or record rejection reason..."
                      />
                    </label>
                    <div style={{ marginTop: "0.5rem", display: "flex", gap: "0.5rem" }}>
                      <button
                        type="button"
                        disabled={busy === item.id}
                        onClick={() => void decide(item, true)}
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        disabled={busy === item.id || (notes[item.id] || "").trim().length < 5}
                        onClick={() => void decide(item, false)}
                      >
                        Reject
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
