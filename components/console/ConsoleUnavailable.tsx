"use client";

import type { ConsoleSessionInfo } from "@/components/admin/ConsoleSessionGate";
import { ConsoleShell } from "@/components/console/ConsoleShell";

/**
 * The one way a console page says "this service is not yours". Every service
 * page renders the same shell with the same hero shape, so a wrong-role visit
 * still looks like the console instead of a bare error — and the rail keeps
 * offering the services that role may actually open.
 */
export function ConsoleUnavailable({ session, service, label, blurb }: {
  session: ConsoleSessionInfo;
  service: string;
  label: string;
  blurb: string;
}) {
  return <ConsoleShell session={session} service={service} label={label} title="Not available" blurb={blurb}>{null}</ConsoleShell>;
}
