import { fail, ok } from "@/lib/campus-engine/responses";
import { assertCinemaPrivateAccount, readCinemaPrivateStudySource } from "@/lib/cinema-engine/private-study";
import { requireCinemaAccount } from "@/lib/student-auth";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const account = await requireCinemaAccount(request); assertCinemaPrivateAccount(request, account.id); const { id } = await context.params;
    const params = new URL(request.url).searchParams;
    return ok({ source: await readCinemaPrivateStudySource({ roomId: id, ownerId: account.id, id: params.get("request") || "", key: params.get("key") || "" }) }, { headers: { "Cache-Control": "private, no-store" } }, request);
  } catch (error) { return fail(error, request); }
}
