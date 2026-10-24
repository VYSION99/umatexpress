import { ensureConsoleAccountsTable } from "@/lib/console-auth";
import { ensureStudentAccountsTable } from "@/lib/student-auth";
import { rowsToObjects, turso } from "@/lib/turso";

/** Verified email is the correlation key; these records never share sessions or permissions. */
export async function linkedStudentForConsole(email: string) {
  await ensureStudentAccountsTable();
  const row = rowsToObjects(await turso(
    "SELECT name FROM student_accounts WHERE lower(email)=? AND email_verified=1 AND COALESCE(active,1)=1 LIMIT 1",
    [email.trim().toLowerCase()],
  ))[0];
  return row ? { linked: true as const, name: String(row.name || "Student account") } : { linked: false as const };
}

export async function linkedConsoleForStudent(email: string) {
  await ensureConsoleAccountsTable();
  const row = rowsToObjects(await turso(
    "SELECT role FROM console_accounts WHERE lower(email)=? AND status='ACTIVE' LIMIT 1",
    [email.trim().toLowerCase()],
  ))[0];
  return row ? { linked: true as const, role: String(row.role) === "ADMIN_DELEGATE" ? "Admin delegate" : String(row.role).toLowerCase() } : { linked: false as const };
}
