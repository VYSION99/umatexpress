import { callCloudflareAi, isCloudflareAiConfigured } from "@/lib/cloudflare-ai";

export async function campusAiHelp(area: "student" | "driver" | "admin", context: string, prompt: string) {
  if (!(await isCloudflareAiConfigured())) {
    return "AI help is not configured yet. Continue with the visible ride, queue, and map details on this screen.";
  }
  const systemPrompt = `You are the campusRide ${area} assistant for UMaTeXPRESS. Be brief, practical, safety-aware, and specific to campus transport.`;
  return callCloudflareAi(systemPrompt, [`Area: ${area}`, context, `Request: ${prompt}`].filter(Boolean).join("\n"));
}

