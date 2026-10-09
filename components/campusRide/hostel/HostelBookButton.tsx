"use client";

import { checkoutFetch } from "@/lib/checkout-client";

import { useEffect, useState } from "react";
import { CalendarBlank, CircleNotch } from "@/components/ui/MaterialIcon";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useStudentAccount } from "@/components/account/useStudentAccount";

/**
 * Holding a bed needs an account; browsing never does. The click first checks
 * who is signed in, and only then asks the server for a checkout link — the
 * server re-checks anyway, so this is about sending the student somewhere
 * useful rather than about security.
 */
export function HostelBookButton({ listingId, bedLabel, feeReady }: { listingId: string; bedLabel: string; feeReady: boolean }) {
  const router = useRouter();
  const { ready, account } = useStudentAccount();
  const [from, setFrom] = useState("/hostel");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // The sign-in link brings the student back to the bed they were looking at.
  // Reading the address inside an effect keeps the first render identical on
  // the server, where there is no window.
  useEffect(() => { queueMicrotask(() => setFrom(`${window.location.pathname}${window.location.search}`)); }, []);

  const hold = async () => {
    if (!feeReady) return;
    setError("");
    setBusy(true);
    try {
      const response = await checkoutFetch("/api/hostel/bookings", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ listingId }),
      });
      const data = await response.json() as { authorizationUrl?: string; reference?: string; error?: string };
      if (!response.ok) {
        if (response.status === 409) router.refresh();
        throw new Error(data.error || "That bed could not be held.");
      }
      if (!data.authorizationUrl) throw new Error("The checkout could not be opened. Please try again.");
      // Paystack has to be a real navigation: the checkout page is another origin.
      window.location.assign(data.authorizationUrl);
    } catch (holdError) {
      setError(holdError instanceof Error ? holdError.message : "That bed could not be held.");
      setBusy(false);
    }
  };

  return <div className="hostel-book">
    {ready && !account
      ? <Link className="hostel-book-button" href={`/account?next=${encodeURIComponent(from)}`}>
        <CalendarBlank size={14} aria-hidden />Sign in to hold
      </Link>
      : <button
        type="button"
        className="hostel-book-button"
        onClick={hold}
        disabled={busy || !ready || !feeReady}
        aria-label={`Hold ${bedLabel} for ten minutes`}
      >
        {busy ? <CircleNotch size={14} className="console-spin" aria-hidden /> : <CalendarBlank size={14} aria-hidden />}
        {!ready ? "Checking your account…" : busy ? "Holding…" : "Hold this bed"}
      </button>}
    {error ? <small className="hostel-book-error">{error}</small> : <small>Held for 10 minutes while you pay.</small>}
  </div>;
}
