import { envValue } from "@/lib/runtime-env";
import { callIntelligence, intelligenceConfigured } from "@/lib/intelligence-api";
import type { CuriosityIntent, TravelChoice } from "./catalog";

export type InterpretedCuriosityGoal = {
  intents: Array<CuriosityIntent | "health">;
  travelChoice?: TravelChoice;
  sensitive: boolean;
};

const MAX_GOAL_CHARS = 120;

const SENSITIVE_PATTERN = /\b(health|sick|unwell|ill|doctor|clinic|hospital|medicine|pharmacy|counsel|counselling|counseling|therapy|mental|depress|anxious|crisis|loan|bursary|financial|hardship)\b/i;

const INTENT_PATTERNS: Array<{ intent: CuriosityIntent; pattern: RegExp }> = [
  { intent: "print", pattern: /\b(print|printing|photocopy|copy|bind|binding|spiral|thesis|handout)\b/i },
  { intent: "food", pattern: /\b(food|eat|eating|meal|lunch|dinner|breakfast|snack|canteen|hungry)\b/i },
  { intent: "housing", pattern: /\b(hostel|hostels|room|bed|accommodation|stay|rent|landlord|housing)\b/i },
  { intent: "social", pattern: /\b(cinema|movie|film|watch|stream|break|relax|chill|hangout)\b/i },
  { intent: "travel", pattern: /\b(ride|bus|travel|travelling|traveling|trip|transport|shuttle|around campus|on campus|heading home|travel home|go home|vacation)\b/i },
];

const HOME_TRAVEL_PATTERN = /\b(heading home|travel home|go home|going home|vacation|long[- ]distance|accra|kumasi|takoradi)\b/i;
const CAMPUS_TRAVEL_PATTERN = /\b(around campus|on campus|campus ride|shuttle|to lecture|to library|within campus)\b/i;

/**
 * Deterministic, in-memory slot extractor.
 * Raw text is never logged or persisted; only closed enum slots are returned.
 */
export function interpretCuriosityGoal(rawGoal: unknown): InterpretedCuriosityGoal {
  const text = String(rawGoal ?? "").trim().slice(0, MAX_GOAL_CHARS);
  if (!text) return { intents: ["unknown"], sensitive: false };
  if (SENSITIVE_PATTERN.test(text)) {
    return { intents: ["health"], sensitive: true };
  }

  const matched: Array<{ intent: CuriosityIntent; index: number }> = [];
  for (const { intent, pattern } of INTENT_PATTERNS) {
    const match = pattern.exec(text);
    if (match && match.index >= 0) {
      matched.push({ intent, index: match.index });
    }
  }

  if (matched.length === 0) {
    return { intents: ["unknown"], sensitive: false };
  }

  matched.sort((a, b) => a.index - b.index);
  const intents = matched.slice(0, 3).map((item) => item.intent);

  let travelChoice: TravelChoice | undefined;
  if (intents.includes("travel")) {
    const wantsHome = HOME_TRAVEL_PATTERN.test(text);
    const wantsCampus = CAMPUS_TRAVEL_PATTERN.test(text);
    if (wantsHome && !wantsCampus) travelChoice = "home";
    else if (wantsCampus && !wantsHome) travelChoice = "campus";
  }

  return {
    intents,
    ...(travelChoice ? { travelChoice } : {}),
    sensitive: false,
  };
}

const ALLOWED_INTENTS = new Set<string>(["travel", "housing", "food", "print", "social", "unknown"]);

export async function curiosityGoalParserEnabled(): Promise<boolean> {
  const parserFlag = (await envValue("CURIOSITY_GOAL_PARSER_ENABLED")).toLowerCase();
  return ["1", "true"].includes(parserFlag);
}

/**
 * Optional async interpreter gated by `CURIOSITY_GOAL_PARSER_ENABLED=true`.
 * Runs deterministic rules first; only calls the private Python Intelligence
 * Worker if enabled, bound, and deterministic rules returned `unknown`.
 */
export async function interpretCuriosityGoalAsync(rawGoal: unknown): Promise<InterpretedCuriosityGoal> {
  const deterministic = interpretCuriosityGoal(rawGoal);
  if (deterministic.sensitive || deterministic.intents[0] !== "unknown") {
    return deterministic;
  }
  if (!(await curiosityGoalParserEnabled()) || !(await intelligenceConfigured())) {
    return deterministic;
  }
  const text = String(rawGoal ?? "").trim().slice(0, MAX_GOAL_CHARS);
  if (!text) return deterministic;
  try {
    const reply = await callIntelligence<{ intents?: unknown; travelChoice?: unknown; sensitive?: unknown }>(
      "v1/curiosity/parse",
      { goal: text },
      1_500,
    );
    if (reply?.sensitive === true) return { intents: ["health"], sensitive: true };
    if (Array.isArray(reply?.intents)) {
      const valid = reply.intents
        .map((item) => String(item || "").toLowerCase())
        .filter((item): item is CuriosityIntent => ALLOWED_INTENTS.has(item) && item !== "unknown")
        .slice(0, 3);
      if (valid.length > 0) {
        const travelChoice = reply.travelChoice === "campus" || reply.travelChoice === "home" ? reply.travelChoice : undefined;
        return { intents: valid, ...(travelChoice ? { travelChoice } : {}), sensitive: false };
      }
    }
  } catch {
    /* Fall back to deterministic result on any Worker error or timeout. */
  }
  return deterministic;
}
