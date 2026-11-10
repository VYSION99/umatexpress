import { fail, ok } from "@/lib/campus-engine/responses";
import { readCinemaAssistantSource } from "@/lib/cinema-engine/chat-assistant";
import { requireCinemaAccount } from "@/lib/student-auth";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const account = await requireCinemaAccount(request); const { id } = await context.params;
    const params = new URL(request.url).searchParams;
    return ok({ source: await readCinemaAssistantSource({ roomId: id, studentId: account.id, jobId: params.get("job") || "", key: params.get("key") || "" }) }, { headers: { "Cache-Control": "no-store" } }, request);
  } catch (error) { return fail(error, request); }
}
