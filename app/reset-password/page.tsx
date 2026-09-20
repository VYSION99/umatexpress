import { AuthRecoveryCard } from "@/components/account/AuthRecoveryCard";

export const metadata = { title: "Reset your UMaTeXPRESS password" };

/**
 * The page the reset mail links to. The token is read on the server and handed
 * to the card, so the page works with JavaScript still booting and never puts
 * the token in a client-side route.
 */
export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string; scope?: string; mode?: string }> }) {
  const params = await searchParams;
  const scope = String(params.scope || "STUDENT").toUpperCase() === "CONSOLE" ? "CONSOLE" : "STUDENT";
  // `?mode=otp` turns the page into the one-time sign-in code form, which is
  // the same code with a different ending: a session instead of a new password.
  const mode = String(params.mode || "") === "otp" ? "otp" as const : "reset" as const;
  return <main className="campus-shell">
    <AuthRecoveryCard scope={scope} mode={mode} token={mode === "otp" ? "" : String(params.token || "")} variant="student" next="/" signInHref="/account" />
  </main>;
}
