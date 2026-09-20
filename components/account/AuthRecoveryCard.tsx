"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";
import { KeyRound, Loader2, MailCheck } from "lucide-react";
import "./account.css";

/** The two account surfaces the recovery endpoints serve. */
export type AuthRecoveryScope = "STUDENT" | "CONSOLE";

type Step = "request" | "reset" | "done";

/**
 * Forgot password, and the one-time sign-in code — for either account surface.
 *
 * The card deliberately says the same thing for every address: if an account
 * exists, mail is on its way. The reset itself can be finished with the code
 * from that mail or with the link that carried the token, which is what makes
 * the flow usable from a phone and from a laptop alike.
 */
export function AuthRecoveryCard(input: {
  scope: AuthRecoveryScope;
  /** "reset" sends a reset link and code; "otp" emails a sign-in code. */
  mode?: "reset" | "otp";
  /** The token from the emailed link, when the card was opened from one. */
  token?: string;
  variant?: "student" | "console";
  /** Where to go after a one-time sign-in. */
  next?: string;
  signInHref?: string;
}) {
  const mode = input.mode || "reset";
  const variant = input.variant || "student";
  const next = input.next && input.next.startsWith("/") && !input.next.startsWith("//") ? input.next : "/";
  const [step, setStep] = useState<Step>(input.token ? "reset" : "request");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  async function post(url: string, method: string, body: unknown) {
    const response = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) throw new Error(data.error || "That did not work. Try again.");
    return data;
  }

  const request = async (event: FormEvent) => {
    event.preventDefault();
    setBusy("request"); setError("");
    try {
      if (mode === "otp") {
        await post("/api/auth/recovery", "PUT", { scope: input.scope, email });
      } else {
        await post("/api/auth/recovery", "POST", { scope: input.scope, email });
      }
      setStep("reset");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "That did not work. Try again.");
    } finally {
      setBusy("");
    }
  };

  const verify = async (event: FormEvent) => {
    event.preventDefault();
    setBusy("verify"); setError("");
    try {
      if (mode === "otp") {
        await post("/api/auth/otp", "PATCH", { scope: input.scope, email, code });
        window.location.assign(next);
        return;
      }
      await post("/api/auth/recovery", "PATCH", {
        scope: input.scope, email, code, newPassword: password,
        ...(input.token ? { token: input.token } : {}),
      });
      setStep("done");
    } catch (verifyError) {
      setError(verifyError instanceof Error ? verifyError.message : "That did not work. Try again.");
    } finally {
      setBusy("");
    }
  };

  const title = step === "done"
    ? "All set"
    : mode === "otp"
      ? (step === "request" ? "Sign in with a code" : "Enter the code")
      : (step === "request" ? "Reset your password" : "Choose a new password");

  const body = <form className={variant === "console" ? "console-auth-card" : "campus-auth-card"} onSubmit={step === "request" ? request : verify}>
    {variant === "console" && <img src="/logo-web.png" alt="UMaTeXPRESS" />}
    {variant === "console" && <p>UMATEXPRESS CONSOLE</p>}
    <h1>{title}</h1>

    {step === "done" && <>
      <span><MailCheck size={16} aria-hidden /> Your password was changed, and every older session was signed out. Sign in with the new password.</span>
      <Link href={input.signInHref || (variant === "console" ? "/console/login" : "/account")}>Go to sign in</Link>
    </>}

    {step === "request" && <>
      <span>
        {mode === "otp"
          ? `We will email a one-time code to the ${input.scope === "CONSOLE" ? "console" : "student"} account on that address.`
          : "Enter the email on the account and we will send a reset link and a code."}
      </span>
      <label>Email<input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
      {error && <div className="console-auth-error" role="alert">{error}</div>}
      <button disabled={busy === "request"}>{busy === "request" ? <Loader2 size={17} className="console-spin" aria-hidden /> : <KeyRound size={17} aria-hidden />}{busy === "request" ? "Sending…" : mode === "otp" ? "Email me a code" : "Send reset link"}</button>
      <Link href={input.signInHref || (variant === "console" ? "/console/login" : "/account")}>Back to sign in</Link>
    </>}

    {step === "reset" && <>
      <span>
        {input.token
          ? "Your link is good. Choose the new password for this account."
          : <>If an account exists for <strong>{email}</strong>, the code is on its way. It expires in {mode === "otp" ? "10" : "30"} minutes.</>}
      </span>
      {!input.token && <label>Code from the email<input type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} /></label>}
      {mode === "reset" && <label>New password<input type="password" autoComplete="new-password" required value={password} onChange={(event) => setPassword(event.target.value)} /></label>}
      {error && <div className="console-auth-error" role="alert">{error}</div>}
      <button disabled={busy === "verify"}>{busy === "verify" ? <Loader2 size={17} className="console-spin" aria-hidden /> : <KeyRound size={17} aria-hidden />}{busy === "verify" ? "Checking…" : mode === "otp" ? "Sign in" : "Set the new password"}</button>
      {mode === "reset" && <Link href={input.signInHref || (variant === "console" ? "/console/login" : "/account")}>Back to sign in</Link>}
    </>}
  </form>;

  if (variant === "console") return <main className="console-auth-page">{body}</main>;
  return <div className="student-auth-interface">{body}</div>;
}
