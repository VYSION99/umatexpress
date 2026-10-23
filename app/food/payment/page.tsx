"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { CheckCircle, CircleNotch, XCircle } from "@/components/ui/MaterialIcon";

export default function FoodPaymentPage() {
  const [state, setState] = useState("CHECKING");
  const [reference, setReference] = useState("");
  const [order, setOrder] = useState("");

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    queueMicrotask(() => {
      const ref = new URLSearchParams(window.location.search).get("reference") || "";
      if (stopped) return;
      setReference(ref);
      if (!ref) { setState("MISSING"); return; }
      let tries = 0;
      const retry = (check: () => Promise<void>) => { if (tries++ < 12) timer = setTimeout(check, 2500); };
      const check = async () => {
        try {
          const response = await fetch(`/api/food/payments?reference=${encodeURIComponent(ref)}`, { cache: "no-store" });
          const data = await response.json() as { status?: string; paid?: boolean; orderReference?: string };
          if (stopped) return;
          if (!response.ok) {
            if (response.status === 429 || response.status >= 500) { setState("PENDING"); retry(check); return; }
            setState("FAILED"); return;
          }
          setOrder(data.orderReference || "");
          setState(data.paid ? "SUCCESSFUL" : data.status || "PENDING");
          if (!data.paid && ["PENDING", "CHECKING"].includes(String(data.status || ""))) retry(check);
        } catch {
          if (!stopped) { setState("PENDING"); retry(check); }
        }
      };
      void check();
    });
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, []);

  return <main className="status-page"><section className="status-card">
    <img className="status-logo" src="/logo-web.png" alt="UMATeXPRESS" />
    {state === "CHECKING" || state === "PENDING" ? <><CircleNotch className="spin" /><h1>Confirming your Food payment</h1><p>Keep this page open. Do not start another payment while Paystack confirms this one.</p></>
      : state === "SUCCESSFUL" ? <><CheckCircle className="status-icon success" /><h1>Payment confirmed</h1><p>{order ? `${order} is paid. ` : ""}The provider can now prepare your pickup.</p><Link href="/food">View my pickups</Link></>
      : <><XCircle className="status-icon fail" /><h1>{state === "REVIEW" ? "Payment needs review" : "Payment not confirmed"}</h1><p>{state === "REVIEW" ? "The amount received did not match the order. Staff will review it; do not pay again." : "Open your pickup status before trying again. If money was deducted, contact support with this reference."}</p><Link href="/food">Return to Food</Link></>}
    {reference && <p className="payment-reference">Reference: {reference}</p>}
  </section></main>;
}
