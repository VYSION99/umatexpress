import { campusAiHelp } from "@/lib/campus-ai";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

function cleanError(error: unknown) {
  return (error instanceof Error ? error.message : "AI help failed.").replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]").slice(0, 500);
}

export async function POST(request: Request) {
  try {
    const limited = await rateLimit(request, "campus-ai", { limit: 40, windowMs: 10 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as { area?: "student" | "driver" | "admin"; context?: string; prompt?: string };
    const area = body.area === "driver" || body.area === "admin" ? body.area : "student";
    const prompt = String(body.prompt || "").trim();
    const context = String(body.context || "").trim();
    if (!prompt && !context) return Response.json({ error: "Add a campusRide question first." }, { status: 400 });
    const suggestion = await campusAiHelp(area, context, prompt || "Give helpful next-step guidance.");
    return Response.json({ suggestion });
  } catch (error) {
    return Response.json({ suggestion: "AI help is unavailable right now. Use the visible map, queue, and ride status details.", error: cleanError(error) }, { status: 200 });
  }
}
