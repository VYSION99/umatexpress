import { campusErrorPayload } from "@/lib/campus-engine/errors";
import { requireConsoleRole } from "@/lib/console-auth";
import { resolveHostelHost } from "@/lib/hostel-engine/managers";
import { identityDocumentFile } from "@/lib/hostel-engine/onboarding";
export async function GET(request: Request, context: { params: Promise<{ documentId: string }> }) {
  try {
    const account = await requireConsoleRole(request, ["LANDLORD", "ADMIN", "MODERATOR"]);
    const { documentId } = await context.params;
    const landlordId = account.role === "LANDLORD" ? (await resolveHostelHost(account)).landlordId : null;
    const document = await identityDocumentFile(documentId, landlordId);
    return new Response(document.body, { headers: { "Content-Type": document.contentType, "Content-Disposition": "inline", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  } catch (error) { const { status, body } = campusErrorPayload(error); return Response.json(body, { status, headers: { "Cache-Control": "no-store" } }); }
}
