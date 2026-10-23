import { CampusEngineError } from "@/lib/campus-engine/errors";
import { rowsToObjects, runSchemaPass, turso } from "@/lib/turso";

export const CINEMA_ROOM_PLANS = {
  FREE: { label: "Free", files: 1, bytes: 500 * 1024 ** 2, minutes: 60 },
  STUDENT_PLUS: { label: "Student Plus", files: 3, bytes: 2 * 1024 ** 3, minutes: 180 },
  ORGANIZER_PRO: { label: "Club / Department Pro", files: 5, bytes: 5 * 1024 ** 3, minutes: 300 },
} as const;
export type CinemaRoomPlan = keyof typeof CINEMA_ROOM_PLANS;

let ready: Promise<void> | null = null;
export function ensureCinemaRoomPlans() {
  ready ??= runSchemaPass({
    metaTable: "campus_schema_meta",
    id: "cinemaRoomPlans",
    version: "043_cinema_room_plans",
    statements: [
      `CREATE TABLE IF NOT EXISTS cinema_room_plan_grants (account_id TEXT PRIMARY KEY, plan TEXT NOT NULL, valid_until TEXT NOT NULL DEFAULT '', granted_by TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS cinema_room_allowances (room_id TEXT PRIMARY KEY, plan TEXT NOT NULL, max_files INTEGER NOT NULL, max_bytes INTEGER NOT NULL, max_minutes INTEGER NOT NULL, created_at TEXT NOT NULL)`,
    ],
  }).catch((error: unknown) => { ready = null; throw error; });
  return ready;
}

export function roomPlanPolicy(plan: unknown) {
  const key = String(plan || "FREE") as CinemaRoomPlan;
  return CINEMA_ROOM_PLANS[key] || CINEMA_ROOM_PLANS.FREE;
}

export async function activeCinemaRoomPlan(accountId: string) {
  await ensureCinemaRoomPlans();
  const grant = rowsToObjects(await turso(
    "SELECT plan FROM cinema_room_plan_grants WHERE account_id = ? AND (valid_until = '' OR valid_until > ?) LIMIT 1",
    [accountId, new Date().toISOString()],
  ))[0];
  const plan = String(grant?.plan || "FREE") as CinemaRoomPlan;
  return { plan: plan in CINEMA_ROOM_PLANS ? plan : "FREE" as CinemaRoomPlan, ...roomPlanPolicy(plan) };
}

export async function snapshotCinemaRoomAllowance(roomId: string, accountId: string) {
  await ensureCinemaRoomPlans();
  const { plan, ...policy } = await activeCinemaRoomPlan(accountId);
  await turso(
    "INSERT OR IGNORE INTO cinema_room_allowances (room_id,plan,max_files,max_bytes,max_minutes,created_at) VALUES (?,?,?,?,?,?)",
    [roomId, plan, policy.files, policy.bytes, policy.minutes, new Date().toISOString()],
  );
  return cinemaRoomAllowance(roomId);
}

export async function cinemaRoomAllowance(roomId: string) {
  await ensureCinemaRoomPlans();
  const row = rowsToObjects(await turso(
    "SELECT plan,max_files,max_bytes,max_minutes FROM cinema_room_allowances WHERE room_id = ? LIMIT 1", [roomId],
  ))[0];
  if (!row) throw new CampusEngineError("INVALID_STATE", "This room has no upload allowance.", 409);
  return {
    plan: String(row.plan || "FREE") as CinemaRoomPlan,
    maxFiles: Math.max(1, Number(row.max_files || 1)),
    maxBytes: Math.max(1, Number(row.max_bytes || 1)),
    maxMinutes: Math.max(1, Number(row.max_minutes || 1)),
  };
}
