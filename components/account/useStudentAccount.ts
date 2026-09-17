"use client";

import { useEffect, useState } from "react";
import type { StudentAccount } from "@/lib/student-auth";

/**
 * The platform account, shared by every client surface.
 *
 * The session itself lives in an HTTP-only cookie, so the browser cannot read
 * who is signed in: this asks the server once per page load and caches the
 * answer for the rest of the visit. `publishStudentAccount` keeps every mounted
 * consumer in step straight after a sign-in or sign-out.
 */
let cache: Promise<StudentAccount | null> | null = null;
const listeners = new Set<(account: StudentAccount | null) => void>();

async function fetchAccount(): Promise<StudentAccount | null> {
  try {
    const response = await fetch("/api/auth/student", { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) return null;
    const data = await response.json() as { account?: StudentAccount | null };
    return data.account ?? null;
  } catch { return null; }
}

export function loadStudentAccount(force = false) {
  if (force || !cache) cache = fetchAccount();
  return cache;
}

export function publishStudentAccount(account: StudentAccount | null) {
  cache = Promise.resolve(account);
  for (const listener of listeners) listener(account);
}

export function useStudentAccount() {
  const [state, setState] = useState<{ ready: boolean; account: StudentAccount | null }>({ ready: false, account: null });
  useEffect(() => {
    let active = true;
    const listener = (account: StudentAccount | null) => { if (active) setState({ ready: true, account }); };
    listeners.add(listener);
    void loadStudentAccount().then((account) => { if (active) setState({ ready: true, account }); });
    return () => { active = false; listeners.delete(listener); };
  }, []);
  return state;
}
