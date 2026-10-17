"use client";

import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { PasskeyScope } from "@/lib/passkeys";
import "./account.css";

type Passkey = { id: string; created_at: string; last_used_at: string };

function available() {
  return typeof window !== "undefined" && window.isSecureContext && typeof PublicKeyCredential !== "undefined";
}
const subscribe = () => () => undefined;
function usePasskeySupport() { return useSyncExternalStore(subscribe, available, () => false); }

async function post(body: Record<string, unknown>, method = "POST") {
  const response = await fetch("/api/auth/passkeys", {
    method, credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const result = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(String(result.error || "Passkey request failed. Try again."));
  return result;
}

export function PasskeySignInButton({ scope, onSuccess }: { scope: PasskeyScope; onSuccess: () => void }) {
  const supported = usePasskeySupport();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!supported) return null;

  async function signIn() {
    setBusy(true); setError("");
    try {
      const start = await post({ scope, action: "signin-options" });
      const response = await startAuthentication({ optionsJSON: start.options as Parameters<typeof startAuthentication>[0]["optionsJSON"] });
      await post({ scope, action: "signin-verify", challengeId: start.challengeId, response });
      onSuccess();
    } catch (cause) {
      if (cause instanceof Error && cause.name !== "NotAllowedError") setError(cause.message);
    } finally { setBusy(false); }
  }

  return <div className="passkey-signin">
    <button type="button" className="passkey-secondary" disabled={busy} onClick={() => void signIn()}>{busy ? "Checking passkey…" : "Sign in with a passkey"}</button>
    {error && <p role="alert" className="passkey-message is-error">{error}</p>}
  </div>;
}

export function PasskeySettings({ scope }: { scope: PasskeyScope }) {
  const supported = usePasskeySupport();
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!available()) return;
    void fetch(`/api/auth/passkeys?scope=${scope}`, { credentials: "same-origin", cache: "no-store" })
      .then(response => response.ok ? response.json() : Promise.reject())
      .then(data => setPasskeys(data.passkeys || []))
      .catch(() => undefined);
  }, [scope]);
  if (!supported) return null;

  async function refresh() {
    const response = await fetch(`/api/auth/passkeys?scope=${scope}`, { credentials: "same-origin", cache: "no-store" });
    if (response.ok) setPasskeys((await response.json()).passkeys || []);
  }

  async function add() {
    if (!password) { setError("Enter your current password first."); return; }
    setBusy(true); setError(""); setMessage("");
    try {
      const start = await post({ scope, action: "register-options", password });
      const response = await startRegistration({ optionsJSON: start.options as Parameters<typeof startRegistration>[0]["optionsJSON"] });
      await post({ scope, action: "register-verify", challengeId: start.challengeId, response });
      setPassword(""); setMessage("Passkey added. You can use it the next time you sign in.");
      await refresh();
    } catch (cause) {
      if (cause instanceof Error && cause.name !== "NotAllowedError") setError(cause.message);
    } finally { setBusy(false); }
  }

  async function remove(id: string) {
    if (!password) { setError("Enter your current password before removing a passkey."); return; }
    setBusy(true); setError(""); setMessage("");
    try {
      await post({ scope, id, password }, "DELETE");
      setPassword(""); setMessage("Passkey removed."); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not remove passkey."); }
    finally { setBusy(false); }
  }

  return <div className="passkey-settings">
    <h3>Passkeys</h3>
    <p>Use your device screen lock, fingerprint, or face unlock to sign in. Keep your password and email recovery available.</p>
    <label>Current password<input type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} /></label>
    <button type="button" disabled={busy} onClick={() => void add()}>{busy ? "Please wait…" : "Add a passkey"}</button>
    {passkeys.length > 0 && <ul>{passkeys.map((passkey, index) => <li key={passkey.id}><span>Passkey {index + 1}<small>Added {new Date(passkey.created_at).toLocaleDateString()}</small></span><button type="button" disabled={busy} onClick={() => void remove(passkey.id)}>Remove</button></li>)}</ul>}
    {message && <p role="status" className="passkey-message">{message}</p>}
    {error && <p role="alert" className="passkey-message is-error">{error}</p>}
  </div>;
}
