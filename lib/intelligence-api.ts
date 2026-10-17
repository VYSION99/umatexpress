import { envValue } from "@/lib/runtime-env";

export type HostelInsights = {
  currentWeekBookings: number;
  previousWeekBookings: number;
  weekChange: number;
  occupancyRate: number;
  messages: string[];
  method: string;
};

/** Server-only optional service. The browser never receives its URL or secret. */
export async function intelligenceConfigured() {
  return Boolean(await envValue("INTELLIGENCE_API_URL") && (await envValue("INTELLIGENCE_API_SECRET")).length >= 32);
}

export async function callIntelligence<T>(path: string, payload: unknown, timeoutMs = 5000): Promise<T> {
  const base = await envValue("INTELLIGENCE_API_URL");
  const secret = await envValue("INTELLIGENCE_API_SECRET");
  if (!base || secret.length < 32) throw new Error("Intelligence API is not configured.");
  const url = new URL(base);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
    throw new Error("Intelligence API URL must use HTTPS, except for local development.");
  }
  const response = await fetch(new URL(path, `${url.href.replace(/\/$/, "")}/`), {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Intelligence API failed (${response.status}).`);
  return await response.json() as T;
}
