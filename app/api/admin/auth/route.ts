import { adminEmailFromRequest, adminSessionCookie, clearAdminSessionCookie, validateAdminCredentials } from "@/lib/admin-auth";
import { adminMustChangePassword, changeAdminPassword } from "@/lib/admin-credentials";

export async function GET(request: Request) {
  const email = await adminEmailFromRequest(request);
  const mustChangePassword = email ? await adminMustChangePassword(email) : false;
  return Response.json({ authenticated: Boolean(email), email, mustChangePassword }, { status: email ? 200 : 401, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { email?: string; password?: string };
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!await validateAdminCredentials(email, password)) {
      return Response.json({ error: "Invalid administrator email or password." }, { status: 401 });
    }
    const secure = new URL(request.url).protocol === "https:";
    const mustChangePassword = await adminMustChangePassword(email);
    return Response.json({ authenticated: true, email, mustChangePassword }, { headers: { "Set-Cookie": await adminSessionCookie(email, secure), "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Sign-in failed." }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  const email = await adminEmailFromRequest(request);
  if (!email) return Response.json({ error: "Admin access is not authorised." }, { status: 401 });
  try {
    const body = await request.json() as { currentPassword?: string; newPassword?: string };
    await changeAdminPassword(email, String(body.currentPassword || ""), String(body.newPassword || ""));
    return Response.json({ changed: true, mustChangePassword: false }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Password could not be changed." }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  const secure = new URL(request.url).protocol === "https:";
  return Response.json({ authenticated: false }, { headers: { "Set-Cookie": clearAdminSessionCookie(secure), "Cache-Control": "no-store" } });
}
