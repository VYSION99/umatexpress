import { campusErrorPayload } from "@/lib/campus-engine/errors";
import { listPublicPrintCopyProviders } from "@/lib/print-copy/directory";

export async function GET() {
  try {
    return Response.json({ providers: await listPublicPrintCopyProviders() }, { headers: { "Cache-Control": "public, max-age=60, stale-while-revalidate=300" } });
  } catch (error) {
    const failure = campusErrorPayload(error);
    return Response.json(failure.body, { status: failure.status, headers: { "Cache-Control": "no-store" } });
  }
}
