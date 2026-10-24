import { linkedConsoleForStudent } from "@/lib/account-links";
import { studentAccountFromRequest } from "@/lib/student-auth";

export async function GET(request: Request) {
  const account = await studentAccountFromRequest(request);
  if (!account) return Response.json({ error: "Sign in to view linked profiles." }, { status: 401, headers: { "Cache-Control": "no-store" } });
  if (!account.emailVerified) return Response.json({ console: { linked: false }, verificationRequired: true }, { headers: { "Cache-Control": "no-store" } });
  try {
    return Response.json({ console: await linkedConsoleForStudent(account.email) }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Linked profile status is temporarily unavailable." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
