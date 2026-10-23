"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function CinemaReuseButton({ stableId, onStarted }: { stableId: string; onStarted?: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const start = async () => {
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/cinema/sessions/${stableId}/reuse`, { method: "POST", credentials: "same-origin" });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "The room could not be started again.");
      onStarted?.();
      router.push(`/cinema/${stableId}`);
      router.refresh();
    } catch (problem) { setError(problem instanceof Error ? problem.message : "The room could not be started again."); }
    finally { setBusy(false); }
  };
  return <span className="cinema-reuse-action"><button type="button" disabled={busy} onClick={() => void start()}>{busy ? "Starting…" : "Start again"}</button>{error && <span className="cinema-error" role="alert">{error}</span>}</span>;
}
