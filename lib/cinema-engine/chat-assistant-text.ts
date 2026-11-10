import type { CinemaChatOverviewMode } from "./protocol";

/** An explicit standalone mention, not an email address or another username. */
export const isCinemaAssistantRequest = (text: string) => /(^|\s)@cinema(?=$|\s|[?!,:;])/i.test(text);

/** Exact commands keep an ordinary question about summaries as an ordinary question. */
export const CINEMA_OVERVIEW_REQUESTS: Record<CinemaChatOverviewMode, string> = {
  CATCH_UP: "@Cinema catch up on the recent conversation",
  REPEATED: "@Cinema group repeated questions",
  UNANSWERED: "@Cinema show questions without replies",
};
export function cinemaOverviewMode(text: string): CinemaChatOverviewMode | null {
  const normalized = text.trim().replace(/\s+/g, " ").toLowerCase();
  return (Object.keys(CINEMA_OVERVIEW_REQUESTS) as CinemaChatOverviewMode[]).find(mode => CINEMA_OVERVIEW_REQUESTS[mode].toLowerCase() === normalized) || null;
}
export function isCinemaChatQuestion(text: string) {
  if (cinemaOverviewMode(text)) return false;
  return isCinemaAssistantRequest(text) || /[?？]/u.test(text) || /^(?:who|what|when|where|why|how|can|could|would|should|does|did|is|are|explain|help)\b/i.test(text.trim());
}
