import { fail, ok } from "@/lib/campus-engine/responses";
import { generateCinemaStudyPack, readCinemaStudyPack } from "@/lib/cinema-engine/study";
import { rateLimitResponse, rateLimitSubject } from "@/lib/rate-limit";
import { requireCinemaAccount } from "@/lib/student-auth";
const NO_STORE = { "Cache-Control": "no-store" };
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) { try { const student = await requireCinemaAccount(request); const { id } = await context.params; return ok({ pack: await readCinemaStudyPack(id, student.id) }, { headers: NO_STORE }, request); } catch (e) { return fail(e, request); } }
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) { try { const student = await requireCinemaAccount(request); const limited = await rateLimitSubject("cinema-study", student.id, { limit: 4, windowMs: 60 * 60_000 }); if (!limited.ok) return rateLimitResponse(limited.retryAfter); const { id } = await context.params; return ok({ pack: await generateCinemaStudyPack({ id, studentId: student.id }) }, { headers: NO_STORE }, request); } catch (e) { return fail(e, request); } }
