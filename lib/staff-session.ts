import { adminEmailFromRequest } from "@/lib/admin-auth";
import { consoleAccountFromRequest, type ConsoleAccount, type ConsoleRole } from "@/lib/console-auth";

/** Roles that may act on the platform's staff surfaces. */
export const STAFF_ROLES: readonly ConsoleRole[] = ["ADMIN", "MODERATOR"];

export type StaffSession = {
  email: string;
  role: ConsoleRole;
  source: "console" | "legacy";
  mustChangePassword: boolean;
  account: ConsoleAccount | null;
};

/**
 * One answer to "who is acting" for every staff surface. A console session is
 * checked first; the legacy admin session is accepted during the migration so
 * the existing screens keep working, and disappears once the console identity
 * covers every console service.
 *
 * Callers choose the roles they accept, and the default is the narrowest one:
 * a moderator session cannot satisfy an endpoint that only asked for admins.
 */
export async function staffSessionFromRequest(
  request: Request,
  roles: readonly ConsoleRole[] = ["ADMIN"],
): Promise<StaffSession | null> {
  const account = await consoleAccountFromRequest(request);
  if (account && STAFF_ROLES.includes(account.role) && roles.includes(account.role)) {
    return { email: account.email, role: account.role, source: "console", mustChangePassword: account.mustChangePassword === true, account };
  }
  const email = await adminEmailFromRequest(request);
  if (email && roles.includes("ADMIN")) {
    return { email, role: "ADMIN", source: "legacy", mustChangePassword: false, account: null };
  }
  return null;
}

export async function staffEmailFromRequest(request: Request, roles: readonly ConsoleRole[] = ["ADMIN"]) {
  const staff = await staffSessionFromRequest(request, roles);
  // A session that still owes a password change may reach the sign-in and
  // password routes (which use staffSessionFromRequest) but no staff data.
  if (!staff || staff.mustChangePassword) return null;
  return staff.email;
}
