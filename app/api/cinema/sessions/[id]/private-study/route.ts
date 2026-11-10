import { fail, ok } from "@/lib/campus-engine/responses";
import { assertCinemaPrivateAccount, changeCinemaPrivateStudy, deleteCinemaPrivateStudy, listCinemaPrivateStudy, nudgeCinemaPrivateStudy, requestCinemaPrivateStudy } from "@/lib/cinema-engine/private-study";
import type { CinemaChatMessage } from "@/lib/cinema-engine/protocol";
import { requireCinemaAccount } from "@/lib/student-auth";
import { rateLimitResponse, rateLimitSubject } from "@/lib/rate-limit";
const HEADERS = { "Cache-Control": "private, no-store" };
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try { const account = await requireCinemaAccount(request); assertCinemaPrivateAccount(request, account.id); const { id } = await context.params;
    return ok(await listCinemaPrivateStudy(id, account.id), { headers: HEADERS }, request);
  } catch (error) { return fail(error, request); }
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const account = await requireCinemaAccount(request); assertCinemaPrivateAccount(request, account.id); const { id } = await context.params;
    const limited = await rateLimitSubject("cinema-private-study", account.id, { limit: 12, windowMs: 3600000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as Record<string, unknown>;
    const job = await requestCinemaPrivateStudy({ roomId: id, ownerId: account.id, requestId: String(body.requestId || ""), question: body.question, anchorId: body.anchorId, linkVideo: body.linkVideo !== false, expectedVideo: body.video as CinemaChatMessage["video"] });
    if (job.status === "QUEUED") await nudgeCinemaPrivateStudy(job.id, id).catch(() => undefined);
    return ok({ request: job }, { status: 202, headers: HEADERS }, request);
  } catch (error) { return fail(error, request); }
}
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const account = await requireCinemaAccount(request); assertCinemaPrivateAccount(request, account.id); const { id } = await context.params;
    const body = await request.json() as Record<string, unknown>;
    if (body.action !== "RETRY" && body.action !== "CANCEL") return ok({ error: "Choose retry or cancel." }, { status: 400, headers: HEADERS }, request);
    if (body.action === "RETRY") { const limited = await rateLimitSubject("cinema-private-study", account.id, { limit: 12, windowMs: 3600000 }); if (!limited.ok) return rateLimitResponse(limited.retryAfter); }
    const job = await changeCinemaPrivateStudy({ roomId: id, ownerId: account.id, id: String(body.requestId || ""), action: body.action });
    if (job.status === "QUEUED") await nudgeCinemaPrivateStudy(job.id, id).catch(() => undefined);
    return ok({ request: job }, { headers: HEADERS }, request);
  } catch (error) { return fail(error, request); }
}
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const account = await requireCinemaAccount(request); assertCinemaPrivateAccount(request, account.id); const { id } = await context.params;
    const body = await request.json() as Record<string, unknown>;
    return ok(await deleteCinemaPrivateStudy({ roomId: id, ownerId: account.id, id: String(body.requestId || "") }), { headers: HEADERS }, request);
  } catch (error) { return fail(error, request); }
}
