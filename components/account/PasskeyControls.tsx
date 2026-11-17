"use client";

import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
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

  const passwordInput = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoading(true); setLoadError("");
    try {
      const response = await fetch(`/api/auth/passkeys?scope=${scope}`, { credentials: "same-origin", cache: "no-store", signal });
      if (!response.ok) throw new Error("Could not load your passkeys. Try again.");
      const data = await response.json();
      if (!signal?.aborted) setPasskeys(data.passkeys || []);
    } catch (cause) {
      if (!signal?.aborted) setLoadError(cause instanceof Error ? cause.message : "Could not load your passkeys.");
    } finally { if (!signal?.aborted) setLoading(false); }
  }, [scope]);

  useEffect(() => {
    if (!available()) return;
    const controller = new AbortController();
    void fetch(`/api/auth/passkeys?scope=${scope}`, { credentials: "same-origin", cache: "no-store", signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error("Could not load your passkeys. Try again.");
        return response.json();
      })
      .then(data => { if (!controller.signal.aborted) setPasskeys(data.passkeys || []); })
      .catch(cause => { if (!controller.signal.aborted) setLoadError(cause instanceof Error ? cause.message : "Could not load your passkeys."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [scope]);
  useEffect(() => {
    if (window.location.hash !== "#passkeys") return;
    const frame = requestAnimationFrame(() => document.getElementById("passkeys")?.scrollIntoView({ block: "start" }));
    return () => cancelAnimationFrame(frame);
  }, [supported]);
  if (!supported) return <div className="passkey-settings" id="passkeys"><h3>Passkeys</h3><p>Passkeys are unavailable in this browser or connection. Open this page over HTTPS in a browser that supports passkeys.</p></div>;

  async function add() {
    const currentPassword = passwordInput.current?.value || password;
    if (!currentPassword) { setError("Enter your current password first."); return; }
    setBusy(true); setError(""); setMessage("");
    try {
      const start = await post({ scope, action: "register-options", password: currentPassword });
      const response = await startRegistration({ optionsJSON: start.options as Parameters<typeof startRegistration>[0]["optionsJSON"] });
      await post({ scope, action: "register-verify", challengeId: start.challengeId, response });
      setPassword(""); setMessage("Passkey added. You can use it the next time you sign in.");
      await refresh();
    } catch (cause) {
      if (cause instanceof Error && cause.name === "NotAllowedError") setMessage("Passkey setup was cancelled or timed out. You can try again when ready.");
      else setError(cause instanceof Error ? cause.message : "Could not add a passkey. Try again.");
    } finally { setBusy(false); }
  }

  async function remove(id: string) {
    const currentPassword = passwordInput.current?.value || password;
    if (!currentPassword) { setError("Enter your current password before removing a passkey."); return; }
    setBusy(true); setError(""); setMessage("");
    try {
      await post({ scope, id, password: currentPassword }, "DELETE");
      setPassword(""); setMessage("Passkey removed."); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not remove passkey."); }
    finally { setBusy(false); }
  }

  return <div className="passkey-settings" id="passkeys">
    <h3>Passkeys</h3>
    <p>Use your device screen lock, fingerprint, or face unlock to sign in. Keep your password and email recovery available.</p>
    <div className="passkey-list" aria-busy={loading}>
      <h4>Registered passkeys {!loading && !loadError && <span>{passkeys.length}</span>}</h4>
      {loading ? <p role="status">Loading your passkeys…</p> : loadError ? <div><p role="alert" className="passkey-message is-error">{loadError}</p><button type="button" className="passkey-retry" onClick={() => void refresh()}>Try again</button></div> : passkeys.length === 0 ? <p>No passkeys added yet. Add one below to use it at your next sign-in.</p> : <ul>{passkeys.map((passkey, index) => <li key={passkey.id}><span>Passkey {index + 1}<small>Added {passkeyDate(passkey.created_at)}</small><small>Last used: {passkey.last_used_at ? passkeyDate(passkey.last_used_at) : "Not used yet"}</small></span><button type="button" disabled={busy} aria-label={`Remove passkey ${index + 1}`} onClick={() => void remove(passkey.id)}>Remove</button></li>)}</ul>}
    </div>
    <form className="passkey-setup" onSubmit={event => { event.preventDefault(); void add(); }}>
      <h4>Add a passkey</h4>
      <p>Your browser will guide you through choosing a device or security key.</p>
      <label>Current password<input ref={passwordInput} type="password" autoComplete="current-password" value={password} onChange={event => { setPassword(event.target.value); setError(""); setMessage(""); }} aria-describedby="passkey-password-help" /></label>
      <small id="passkey-password-help">Confirm your password to add or remove a passkey.</small>
      <button type="submit" disabled={busy}>{busy ? "Please wait…" : "Add a passkey"}</button>
    </form>
    {message && <p role="status" className="passkey-message">{message}</p>}
    {error && <p role="alert" className="passkey-message is-error">{error}</p>}
  </div>;
}

function passkeyDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unavailable" : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
