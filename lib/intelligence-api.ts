import { runtimeEnv } from "@/lib/runtime-env";

export type HostelInsights = {
  currentWeekBookings: number;
  previousWeekBookings: number;
  weekChange: number;
  occupancyRate: number;
  messages: string[];
  method: string;
};

type IntelligenceBinding = { fetch: (request: Request) => Promise<Response> };

async function intelligenceBinding(): Promise<IntelligenceBinding | null> {
  const binding = (await runtimeEnv())?.INTELLIGENCE;
  return binding && typeof (binding as IntelligenceBinding).fetch === "function"
    ? binding as IntelligenceBinding
    : null;
}

/** Internal Cloudflare service binding; no public URL or shared secret. */
export async function intelligenceConfigured() {
  return Boolean(await intelligenceBinding());
}

export async function callIntelligence<T>(path: string, payload: unknown, timeoutMs = 5000): Promise<T> {
  const binding = await intelligenceBinding();
  if (!binding) throw new Error("Intelligence Worker is not bound.");
  const response = await binding.fetch(new Request(new URL(path, "https://intelligence.internal/"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  }));
  if (!response.ok) throw new Error(`Intelligence Worker failed (${response.status}).`);
  return await response.json() as T;
}
