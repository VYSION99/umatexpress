import { callCloudflareAi, isCloudflareAiConfigured } from "@/lib/cloudflare-ai";
import { formatTime } from "@/lib/trips";
import { getDynamicTrip } from "@/lib/dynamic-trips";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

function fallbackMessage() {
  return "Please arrive at least 30 minutes before departure with your ticket details ready. Keep your phone reachable for organizer updates, travel light where possible, and confirm your selected seat before payment.";
}

export async function POST(request: Request) {
  try {
    const limited = await rateLimit(request, "passenger-ai", { limit: 40, windowMs: 10 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as { tripId?: string; travelDate?: string };
    const tripId = String(body.tripId || "");
    const travelDate = String(body.travelDate || "");
    const trip = await getDynamicTrip(tripId);

    if (!trip || !trip.active || trip.travelDate !== travelDate) {
      return Response.json({ suggestion: fallbackMessage() });
    }

    const departure = formatTime(trip.time);
    const arrival = formatTime(trip.arrival);

    if (!(await isCloudflareAiConfigured())) {
      return Response.json({ suggestion: fallbackMessage() });
    }

    const systemPrompt = "You are a concise passenger support assistant for UMaTeXPRESS, a Ghana student transport booking service. Give practical travel guidance only. Do not discuss unrelated topics.";
    const userPrompt = [
      `Route: ${trip.from} to ${trip.to}`,
      `Travel date: ${travelDate}`,
      `Departure: ${departure}`,
      `Arrival: ${arrival}`,
      `Fare: GHS ${trip.price}`,
      "Write 2 short sentences telling the passenger what to expect before boarding and what to prepare.",
    ].join("\n");

    const suggestion = await callCloudflareAi(systemPrompt, userPrompt);
    return Response.json({ suggestion });
  } catch {
    return Response.json({ suggestion: fallbackMessage() });
  }
}
