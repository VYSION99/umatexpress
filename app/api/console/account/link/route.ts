import { linkedStudentForConsole } from "@/lib/account-links";
import { consoleAccountFromRequest } from "@/lib/console-auth";

export async function GET(request: Request) {
  const account = await consoleAccountFromRequest(request);
  if (!account) return Response.json({ error: "Sign in to view linked profiles." }, { status: 401, headers: { "Cache-Control": "no-store" } });
  try {
    return Response.json({ student: await linkedStudentForConsole(account.email) }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Linked profile status is temporarily unavailable." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
