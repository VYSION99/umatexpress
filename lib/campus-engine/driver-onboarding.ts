import { CampusEngineError } from "@/lib/campus-engine/errors";
import { hashPassword } from "@/lib/campus-engine/crypto";
import { consoleAudit } from "@/lib/console-audit";
import { assertConsolePassword, createConsoleAccount, revokeConsoleSessions } from "@/lib/console-auth";
import { ensureCampusRideTables } from "@/lib/campus-ride";
import { notifyParty, providerDecisionNotice } from "@/lib/notify-templates";
import { isTursoConfiguredRuntime, rowsToObjects, turso } from "@/lib/turso";

/**
 * CampusRide drivers, applied for instead of handed out.
 *
 * A driver was the last role whose console account only the operations team
 * could create, which meant every candidate had to reach a human before they
 * could even exist as an applicant. They can now apply from `/console/register`
 * like an organizer or a landlord, and the two records move together the same
 * way: the console account is what a person signs in with
 * (`PENDING | ACTIVE | SUSPENDED`) and the driver record is the operator
 * (`PENDING | APPROVED | REJECTED | SUSPENDED`).
 *
 * Approval opens the console, not the road. A driver with no vehicle and no zone
 * can sign in, look at the portal and wait: what puts them in front of
 * passengers is operations assigning them a vehicle and a corridor, exactly as
 * it is for a driver the team created by hand. That keeps the public form a way
 * to become an applicant, never a way to start carrying students.
 *
 * Ownership never comes from a request. An applicant writes their own record;
 * only a staff decision in `reviewDriverApplication` changes its state.
 */
export const DRIVER_APPLICATION_STATUSES = ["PENDING", "APPROVED", "REJECTED", "SUSPENDED"] as const;
export type DriverApplicationStatus = (typeof DRIVER_APPLICATION_STATUSES)[number];

export type DriverDecision = "APPROVE" | "REJECT" | "SUSPEND";

export const DRIVER_DECISIONS = ["APPROVE", "REJECT", "SUSPEND"] as const;

export function isDriverDecision(value: unknown): value is DriverDecision {
  return typeof value === "string" && (DRIVER_DECISIONS as readonly string[]).includes(value);
}

export type DriverApplication = {
  id: string;
  name: string;
  phone: string;
  email: string;
  applicationStatus: DriverApplicationStatus;
  reviewReason: string;
  active: boolean;
  vehicleId: string;
  currentZoneId: string;
  accountId: string;
  accountStatus: string;
  createdAt: string;
  updatedAt: string;
};

const APPLICATION_COLUMNS = "d.id,d.name,d.phone,COALESCE(d.email,'') AS email,"
  + "COALESCE(d.application_status,'APPROVED') AS application_status,COALESCE(d.review_reason,'') AS review_reason,"
  + "COALESCE(d.active,0) AS active,COALESCE(d.vehicle_id,'') AS vehicle_id,COALESCE(d.current_zone_id,'') AS current_zone_id,"
  + "d.created_at,d.updated_at,COALESCE(a.id,'') AS account_id,COALESCE(a.status,'') AS account_status";

/** The account a driver record fronts, so a decision can move both together. */
const APPLICATION_JOIN = "FROM campus_drivers d LEFT JOIN console_accounts a ON a.profile_id = d.id AND a.role = 'DRIVER'";

function applicationView(row: Record<string, unknown>): DriverApplication {
  return {
    id: String(row.id || ""),
    name: String(row.name || ""),
    phone: String(row.phone || ""),
    email: String(row.email || ""),
    applicationStatus: String(row.application_status || "APPROVED") as DriverApplicationStatus,
    reviewReason: String(row.review_reason || ""),
    active: Number(row.active ?? 0) === 1,
    vehicleId: String(row.vehicle_id || ""),
    currentZoneId: String(row.current_zone_id || ""),
    accountId: String(row.account_id || ""),
    accountStatus: String(row.account_status || ""),
    createdAt: String(row.created_at || ""),
    updatedAt: String(row.updated_at || ""),
  };
}

export async function getDriverApplication(driverId: string): Promise<DriverApplication> {
  await ensureCampusRideTables();
  const row = rowsToObjects(await turso(
    `SELECT ${APPLICATION_COLUMNS} ${APPLICATION_JOIN} WHERE d.id = ? LIMIT 1`,
    [driverId],
  ))[0];
  if (!row) throw new CampusEngineError("NOT_FOUND", "That driver application was not found.", 404);
  return applicationView(row);
}

/**
 * The queue for staff: applicants waiting on a decision first, then the ones
 * who were sent back, then everyone already driving. The contact details come
 * along because the decision is made against a person, and the phone number is
 * the part a reviewer can actually check.
 */
export async function listDriverApplications(): Promise<DriverApplication[]> {
  await ensureCampusRideTables();
  const rows = rowsToObjects(await turso(
    `SELECT ${APPLICATION_COLUMNS} ${APPLICATION_JOIN}
     ORDER BY CASE COALESCE(d.application_status,'APPROVED') WHEN 'PENDING' THEN 0 WHEN 'REJECTED' THEN 1 WHEN 'SUSPENDED' THEN 2 ELSE 3 END,
       d.created_at DESC`,
  ));
  return rows.map(applicationView);
}

/**
 * One public application: the driver record and the console account it signs in
 * with, written together. The account is `PENDING` and the driver is inactive,
 * so nothing about the person is operational until a reviewer decides — the
 * same shape as an organizer application, on the record the campus console
 * already knows how to run.
 *
 * The password is stored in both records on purpose: the console is the
 * credential a new driver is handed, and the legacy driver endpoint still
 * exists during the migration, so the same password opens either door rather
 * than one of them silently refusing the person who just chose it.
 */
export async function registerDriverApplication(input: {
  name?: unknown; phone?: unknown; email?: unknown; password?: unknown;
}) {
  if (!(await isTursoConfiguredRuntime())) {
    throw new CampusEngineError("CONFIG_REQUIRED", "Driver applications are not available on this deployment.", 503);
  }
  const name = String(input.name || "").trim();
  const phone = String(input.phone || "").trim();
  const email = String(input.email || "").trim().toLowerCase();
  const password = String(input.password || "");
  if (!name || !phone || !email) {
    throw new CampusEngineError("VALIDATION_ERROR", "Enter your name, phone number and email address.", 400);
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new CampusEngineError("VALIDATION_ERROR", "Enter a valid email address.", 400);
  }
  // The policy the DRIVER role is held to once the account is active.
  assertConsolePassword("DRIVER", password);
  await ensureCampusRideTables();

  const duplicate = rowsToObjects(await turso(
    "SELECT id FROM campus_drivers WHERE lower(email) = ? OR phone = ? LIMIT 1",
    [email, phone],
  ))[0];
  if (duplicate) {
    throw new CampusEngineError("CONFLICT", "An application already exists for that email address or phone number.", 409);
  }
  const taken = rowsToObjects(await turso("SELECT id FROM console_accounts WHERE email = ? LIMIT 1", [email]))[0];
  if (taken) {
    throw new CampusEngineError("CONFLICT", "That email address is already registered.", 409);
  }

  const stamp = new Date().toISOString();
  const driverId = crypto.randomUUID();
  const { hash, salt, iterations } = await hashPassword(password);
  await turso(
    `INSERT INTO campus_drivers (id,name,phone,email,password_hash,password_salt,password_iterations,password_reset_required,password_changed_at,vehicle_id,current_zone_id,active,application_status,review_reason,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,0,?,'','',0,'PENDING','',?,?)`,
    [driverId, name, phone, email, hash, salt, iterations, stamp, stamp, stamp],
  );

  let accountId = "";
  try {
    accountId = await createConsoleAccount({
      email, password, name, phone, role: "DRIVER", profileId: driverId, status: "PENDING",
    });
  } catch (error) {
    await turso("DELETE FROM campus_drivers WHERE id = ?", [driverId]).catch(() => undefined);
    throw error;
  }

  await consoleAudit({
    actor: email,
    action: "DRIVER_APPLIED",
    targetType: "campus_driver",
    targetReference: driverId,
    details: { name, phone },
  }).catch(() => undefined);

  return { driverId, accountId, status: "PENDING" as const };
}

/**
 * The staff decision.
 *
 * Approval is the only move that makes both records live: the driver becomes
 * active and the console account `ACTIVE`. A rejection sends the applicant a
 * reason and leaves the account parked `PENDING`, so the record stays as the
 * place they resubmit from rather than becoming a second application. A
 * suspension is for someone who was already approved: it stops the account,
 * ends any ride they had open and takes them off the map, because a driver the
 * platform has just stopped is not a driver who should still be collecting
 * passengers.
 */
export async function reviewDriverApplication(input: {
  driverId: string; action: DriverDecision; reason?: unknown; actor: string;
}): Promise<DriverApplication> {
  const driverId = String(input.driverId || "").trim();
  if (!driverId) throw new CampusEngineError("VALIDATION_ERROR", "Choose an application to review.", 400);
  await ensureCampusRideTables();
  const application = await getDriverApplication(driverId);
  const reason = String(input.reason || "").trim();
  const stamp = new Date().toISOString();

  if (input.action === "APPROVE" && application.applicationStatus === "APPROVED" && application.active) {
    throw new CampusEngineError("INVALID_STATE", "This driver is already approved.", 409);
  }
  if (input.action === "SUSPEND" && application.applicationStatus !== "APPROVED") {
    throw new CampusEngineError("INVALID_STATE", "Reject this application instead of suspending it — the driver was never approved.", 409);
  }
  if (input.action === "REJECT" && !reason) {
    throw new CampusEngineError("VALIDATION_ERROR", "Give a reason so the applicant knows what to fix.", 400);
  }
  if (input.action === "SUSPEND" && !reason) {
    throw new CampusEngineError("VALIDATION_ERROR", "Give a reason so the driver knows why they were stopped.", 400);
  }

  if (input.action === "APPROVE") {
    await turso(
      "UPDATE campus_drivers SET application_status='APPROVED',review_reason='',active=1,updated_at=? WHERE id=?",
      [stamp, driverId],
    );
    if (application.accountId) {
      await turso("UPDATE console_accounts SET status='ACTIVE', updated_at=? WHERE id=?", [stamp, application.accountId]);
    }
  } else if (input.action === "REJECT") {
    await turso(
      "UPDATE campus_drivers SET application_status='REJECTED',review_reason=?,active=0,updated_at=? WHERE id=?",
      [reason, stamp, driverId],
    );
  } else {
    await turso(
      "UPDATE campus_drivers SET application_status='SUSPENDED',review_reason=?,active=0,current_zone_id='',current_latitude=NULL,current_longitude=NULL,updated_at=? WHERE id=?",
      [reason, stamp, driverId],
    );
    if (application.accountId) {
      await turso("UPDATE console_accounts SET status='SUSPENDED', updated_at=? WHERE id=?", [stamp, application.accountId]);
      await revokeConsoleSessions(application.accountId);
    }
    // `openDriverRide` makes the same move when a driver replaces their ride, so
    // this needs no new ride state: the live ride is simply over.
    await turso(
      "UPDATE campus_rides SET status='COMPLETED',accepting_queue=0,ended_at=?,updated_at=? WHERE driver_id=? AND status IN ('OPEN','PAUSED','FULL')",
      [stamp, stamp, driverId],
    );
  }

  await consoleAudit({
    actor: input.actor,
    action: `DRIVER_APPLICATION_${input.action}`,
    targetType: "campus_driver",
    targetReference: driverId,
    details: { from: application.applicationStatus, reason },
  });
  // The decision is recorded either way; the applicant is told through the
  // outbox, which is also the in-app record.
  await notifyParty({
    recipient: application.email,
    reference: driverId,
    notice: providerDecisionNotice("driver", input.action, { reason }),
  });
  return getDriverApplication(driverId);
}
