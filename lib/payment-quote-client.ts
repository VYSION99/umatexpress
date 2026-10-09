"use client";

import { useEffect, useState } from "react";

export type PaymentQuote = { baseAmount: number; feeAmount: number; totalAmount: number; feePercent: number; currency: "GHS" };

export function usePaymentQuote(baseAmount: number) {
  const [quote, setQuote] = useState<PaymentQuote | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!Number.isSafeInteger(baseAmount) || baseAmount <= 0) { queueMicrotask(() => { setQuote(null); setError(""); }); return; }
    const controller = new AbortController();
    queueMicrotask(() => { setQuote(null); setError(""); });
    fetch(`/api/payments/quote?amount=${baseAmount}`, { cache: "no-store", signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error("Could not calculate processing fee."); return response.json() as Promise<PaymentQuote>; })
      .then(result => { if (!controller.signal.aborted && result.baseAmount === baseAmount) setQuote(result); })
      .catch(() => { if (!controller.signal.aborted) setError("Could not calculate the total. Try again."); });
    return () => controller.abort();
  }, [baseAmount]);
  return { quote: quote?.baseAmount === baseAmount ? quote : null, error };
}
