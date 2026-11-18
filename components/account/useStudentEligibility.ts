"use client";

import { useEffect, useState } from "react";
import type { StudentAccount } from "@/lib/student-auth";
import { validStudentEmail } from "@/lib/student-email";

/** Student eligibility may come from a verified primary or linked UMaT email. */
export function useStudentEligibility(account: StudentAccount | null): boolean | null {
  const primary = Boolean(account && validStudentEmail(account.email) && (account.emailVerified || !account.verificationRequired));
  const [linked, setLinked] = useState<{ accountId: string; eligible: boolean } | null>(null);

  useEffect(() => {
    if (!account?.emailVerified || primary) return;
    const accountId = account.id;
    const controller = new AbortController();
    void fetch("/api/auth/student/eligibility", { credentials: "same-origin", cache: "no-store", signal: controller.signal })
      .then(response => response.ok ? response.json() as Promise<{ studentAccess?: { verified?: boolean } }> : null)
      .then(data => { if (!controller.signal.aborted) setLinked({ accountId, eligible: data?.studentAccess?.verified === true }); })
      .catch(() => { if (!controller.signal.aborted) setLinked({ accountId, eligible: false }); });
    return () => controller.abort();
  }, [account?.id, account?.emailVerified, primary]);

  if (primary) return true;
  if (!account || !account.emailVerified) return false;
  return linked?.accountId === account.id ? linked.eligible : null;
}
