import { validateAdminCredentials } from "@/lib/admin-auth";
import { adminMustChangePassword } from "@/lib/admin-credentials";
import { CampusEngineError } from "@/lib/campus-engine/errors";
import { verifyDriverCredentials } from "@/lib/campus-engine/driver-auth";
import {
  assertConsolePassword,
  consoleAccountRowByIdentifier,
  consoleAccountView,
  hasStoredPassword,
  provisionConsoleAccount,
  setConsolePassword,
  verifyStoredConsolePassword,
  type ConsoleAccount,
} from "@/lib/console-auth";

export type ConsoleSignIn = {
  account: ConsoleAccount;
  mustChangePassword: boolean;
  /**
   * True when the password still lives in a legacy store (admin_credentials or
   * campus_drivers). Bridged sessions are deliberately short-lived: the legacy
   * store cannot tell the console that a password changed, so the session must
   * not outlive the operator's ability to notice.
   */
  bridged: boolean;
};

async function legacyAdmin(email: string, password: string) {
  if (!await validateAdminCredentials(email, password)) return null;
  return { mustChangePassword: await adminMustChangePassword(email) };
}

async function legacyDriver(identifier: string, password: string) {
  try {
    return await verifyDriverCredentials(identifier, password);
  } catch {
    return null;
  }
}

async function verifyBridged(account: ConsoleAccount, identifier: string, password: string): Promise<ConsoleSignIn | null> {
  if (account.role === "ADMIN" || account.role === "MODERATOR") {
    const admin = await legacyAdmin(account.email, password);
    return admin ? { account, mustChangePassword: admin.mustChangePassword, bridged: true } : null;
  }
  if (account.role === "DRIVER") {
    const driver = await legacyDriver(identifier, password);
    if (!driver) return null;
    // A console identity that is bound to one driver must never accept another
    // driver's credentials, even if both would verify.
    if (account.profileId && account.profileId !== driver.id) return null;
    return { account, mustChangePassword: driver.mustChangePassword === true, bridged: true };
  }
  // Organizers have no legacy credential store to fall back to.
  return null;
}

/**
 * One sign-in for every console role. A stored console account always wins,
 * including a parked PENDING or SUSPENDED one, so an approval decision cannot
 * be bypassed by falling back to a legacy credential.
 */
export async function resolveConsoleSignIn(identifierInput: unknown, passwordInput: unknown): Promise<ConsoleSignIn | null> {
  const identifier = String(identifierInput ?? "").trim();
  const password = String(passwordInput ?? "");
  if (!identifier || !password) return null;

  const row = await consoleAccountRowByIdentifier(identifier);
  if (row) {
    const account = consoleAccountView(row);
    if (account.status !== "ACTIVE") return null;
    if (hasStoredPassword(row)) {
      if (!await verifyStoredConsolePassword(row, password)) return null;
      return { account, mustChangePassword: false, bridged: false };
    }
    return verifyBridged(account, identifier, password);
  }

  // First console sign-in for an identity that already exists in a legacy
  // store: adopt it rather than asking the operator for a second password.
  const admin = await legacyAdmin(identifier.toLowerCase(), password);
  if (admin) {
    const account = await provisionConsoleAccount({ email: identifier.toLowerCase(), name: identifier, role: "ADMIN" });
    return account ? { account, mustChangePassword: admin.mustChangePassword, bridged: true } : null;
  }

  const driver = await legacyDriver(identifier, password);
  if (driver) {
    const account = await provisionConsoleAccount({
      email: driver.email || identifier.toLowerCase(),
      name: driver.name,
      phone: driver.phone,
      role: "DRIVER",
      profileId: driver.id,
    });
    return account ? { account, mustChangePassword: driver.mustChangePassword === true, bridged: true } : null;
  }

  return null;
}

/**
 * Verifies the current password against whichever store owns it, then writes
 * the new password to the console account. A bridged account stops being
 * bridged at this point: from now on the console is its credential store.
 */
export async function changeConsolePassword(account: ConsoleAccount, currentPassword: string, newPassword: string) {
  const verified = await resolveConsoleSignIn(account.email, currentPassword);
  if (!verified || verified.account.id !== account.id) {
    throw new CampusEngineError("UNAUTHORIZED", "The current password is incorrect.", 401);
  }
  assertConsolePassword(account.role, newPassword);
  await setConsolePassword(account.id, newPassword);
}
