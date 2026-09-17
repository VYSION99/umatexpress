import { adminEmailFromRequest } from "@/lib/admin-auth";
import { callCloudflareAi, cloudflareAiConfigStatus, isCloudflareAiConfigured } from "@/lib/cloudflare-ai";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

function publicAiError(error: unknown) {
  const message = error instanceof Error ? error.message : "AI assistance could not be generated.";
  return message
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/"Authorization"\s*:\s*"[^"]+"/gi, '"Authorization":"[redacted]"')
    .slice(0, 700);
}

export async function POST(request: Request) {
  const adminEmail = await adminEmailFromRequest(request);
  if (!adminEmail) {
    return Response.json({ error: "Admin access is not authorised." }, { status: 401 });
  }
  const limited = await rateLimit(request, "admin-ai", { limit: 30, windowMs: 10 * 60_000 });
  if (!limited.ok) return rateLimitResponse(limited.retryAfter);

  let mode: "suggestion" | "passenger-help" = "suggestion";
  try {
    const body = await request.json() as { mode?: "suggestion" | "passenger-help"; context?: string; prompt?: string };
    mode = body.mode === "passenger-help" ? "passenger-help" : "suggestion";
    const context = String(body.context ?? "").trim();
    const prompt = String(body.prompt ?? "").trim();

    if (!prompt && !context) {
      return Response.json({ error: "Add a prompt or trip context before asking for help." }, { status: 400 });
    }

    if (!(await isCloudflareAiConfigured())) {
      const config = await cloudflareAiConfigStatus();
      return Response.json({
        suggestion: mode === "suggestion"
          ? "Cloudflare AI is not configured on this deployment yet. Add Cloudflare Worker secrets named CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AI_TOKEN, then redeploy. Use a Workers AI API token, not the Paystack key."
          : "Cloudflare AI is not configured on this deployment yet. Add CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AI_TOKEN as Worker secrets, then redeploy to enable passenger assistance.",
        error: `AI config status: accountId=${config.hasAccountId ? "present" : "missing"}, token=${config.hasAiToken ? "present" : "missing"}, model=${config.model}`,
      });
    }

    const finalPrompt = [
      `Mode: ${mode}`,
      context ? `Context: ${context}` : "",
      `Request: ${prompt || "Provide helpful guidance."}`,
      "Return a practical admin-ready suggestion using exactly these plain-text section headings, each on its own line: Public title:, Passenger note:, Operations advice:, Risk check:.",
      "Do not use markdown bold, bullets, numbering, tables, or quotation marks around headings.",
      "Keep it concise, Ghana-student-transport specific, and avoid promises the operator cannot guarantee.",
    ].filter(Boolean).join("\n");

    const systemPrompt = mode === "passenger-help"
      ? "You are a passenger support assistant for a student transport service. Respond helpfully and briefly, with a friendly tone. Include trip, seat, fare, and timing guidance when relevant."
      : "You are an operations assistant for UMaTeXPRESS vacationRide. Help admins design trip schedules, fares, coach messaging, seat operations, and passenger announcements. Be practical, concise, and safety-aware.";

    const suggestion = await callCloudflareAi(systemPrompt, finalPrompt);
    return Response.json({ suggestion });
  } catch (error) {
    const message = publicAiError(error);
    const fallback = mode === "passenger-help"
      ? "Cloudflare AI is unavailable right now. Please check that your Workers AI account is active and that the correct Cloudflare account ID and AI token are configured."
      : "Cloudflare AI could not process the request. Please verify that the correct Cloudflare account ID and AI token are configured and that Workers AI is enabled for this account.";
    return Response.json({ suggestion: fallback, error: message }, { status: 200 });
  }
}
