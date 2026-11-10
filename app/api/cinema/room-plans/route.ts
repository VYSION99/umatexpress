import { fail, ok } from "@/lib/campus-engine/responses";
import { CampusEngineError } from "@/lib/campus-engine/errors";
import { cinemaRoomPlanCatalogue, startCinemaRoomPlanCheckout } from "@/lib/cinema-engine/room-plan-subscriptions";
import { idempotentCheckout } from "@/lib/payments/idempotency";
import { rateLimitSubject, rateLimitResponse } from "@/lib/rate-limit";
import { requireStudent } from "@/lib/student-auth";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  try {
    const student = await requireStudent(request);
    return ok(await cinemaRoomPlanCatalogue(student.id), { headers: NO_STORE }, request);
  } catch (error) { return fail(error, request); }
}

export async function POST(request: Request) {
  try {
    const student = await requireStudent(request);
    const limited = await rateLimitSubject("cinema-room-plan-checkout", student.id, { limit: 5, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    return await idempotentCheckout(request, student.id, "CINEMA_ROOM_PLAN", async () => {
      const body = await request.json() as { plan?: unknown; expectedCheckoutPesewas?: unknown };
      const expected = body.expectedCheckoutPesewas;
      if (expected !== undefined && (typeof expected !== "number" || !Number.isSafeInteger(expected) || expected <= 0)) {
        throw new CampusEngineError("VALIDATION_ERROR", "Choose a plan with a valid checkout total.", 400);
      }
      const checkout = await startCinemaRoomPlanCheckout({
        accountId: student.id, email: student.email, plan: String(body.plan || ""),
        origin: new URL(request.url).origin, expectedCheckoutPesewas: expected,
      });
      return ok(checkout, { status: 201, headers: NO_STORE }, request);
    });
  } catch (error) { return fail(error, request); }
}
