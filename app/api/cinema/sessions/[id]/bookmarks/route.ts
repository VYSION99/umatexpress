import { fail, ok } from "@/lib/campus-engine/responses";
import { addCinemaBookmark, deleteCinemaBookmark, listCinemaBookmarks } from "@/lib/cinema-engine/rooms";
import { rateLimitSubject, rateLimitResponse } from "@/lib/rate-limit";
import { requireCinemaAccount } from "@/lib/student-auth";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const student = await requireCinemaAccount(request);
    const { id } = await context.params;
    return ok({ bookmarks: await listCinemaBookmarks({ id, studentId: student.id }) }, { headers: NO_STORE }, request);
  } catch (error) {
    return fail(error, request);
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const student = await requireCinemaAccount(request);
    const limited = await rateLimitSubject("cinema-bookmarks", student.id, { limit: 30, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const { id } = await context.params;
    const body = await request.json() as { label?: unknown; atSeconds?: unknown };
    return ok({ bookmark: await addCinemaBookmark({ id, studentId: student.id, displayName: student.name, label: body.label, atSeconds: body.atSeconds }) }, { status: 201, headers: NO_STORE }, request);
  } catch (error) {
    return fail(error, request);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const student = await requireCinemaAccount(request);
    const limited = await rateLimitSubject("cinema-bookmarks", student.id, { limit: 60, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const { id } = await context.params;
    const bookmarkId = new URL(request.url).searchParams.get("bookmarkId") || "";
    return ok(await deleteCinemaBookmark({ id, studentId: student.id, bookmarkId }), { headers: NO_STORE }, request);
  } catch (error) {
    return fail(error, request);
  }
}
