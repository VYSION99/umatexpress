import { CampusEngineError } from "@/lib/campus-engine/errors";
import { rowsToObjects, runSchemaPass, turso } from "@/lib/turso";

export const CINEMA_ROOM_PLANS = {
  FREE: { label: "Free", description: "A simple room for one video.", files: 1, bytes: 500 * 1024 ** 2, minutes: 60, approval: null },
  STUDENT_PLUS: { label: "Student Plus", description: "More room for a study playlist.", files: 3, bytes: 2 * 1024 ** 3, minutes: 180, approval: null },
  STUDENT_POLITICS_PLUS: { label: "Student Politics Plus", description: "File rooms for approved student election and campaign organizers.", files: 6, bytes: 3 * 1024 ** 3, minutes: 240, approval: "POLITICS" },
  ORGANIZER_PRO: { label: "Club / Department Pro", description: "Longer screenings for approved clubs and departments.", files: 10, bytes: 5 * 1024 ** 3, minutes: 300, approval: "ORGANIZER" },
  PRO_PLUS: { label: "Pro Plus", description: "More files and storage for recurring screenings and teaching playlists.", files: 15, bytes: 8 * 1024 ** 3, minutes: 300, approval: "ORGANIZER" },
} as const;
export type CinemaRoomPlan = keyof typeof CINEMA_ROOM_PLANS;
export type CinemaRoomPlanApproval = typeof CINEMA_ROOM_PLANS[CinemaRoomPlan]["approval"];

export function isCinemaRoomPlan(value: string): value is CinemaRoomPlan {
  return Object.hasOwn(CINEMA_ROOM_PLANS, value);
}

let ready: Promise<void> | null = null;
export function ensureCinemaRoomPlans() {
  ready ??= runSchemaPass({
    metaTable: "campus_schema_meta",
    id: "cinemaRoomPlans",
    version: "059_cinema_room_plan_refunds",
    statements: [
      `CREATE TABLE IF NOT EXISTS cinema_room_plan_grants (account_id TEXT PRIMARY KEY, plan TEXT NOT NULL, valid_until TEXT NOT NULL DEFAULT '', granted_by TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS cinema_room_allowances (room_id TEXT PRIMARY KEY, plan TEXT NOT NULL, max_files INTEGER NOT NULL, max_bytes INTEGER NOT NULL, max_minutes INTEGER NOT NULL, created_at TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS cinema_room_plan_prices (plan TEXT PRIMARY KEY, price_pesewas INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 0, updated_by TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '')`,
      `CREATE TABLE IF NOT EXISTS cinema_room_plan_orders (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, plan TEXT NOT NULL, base_amount INTEGER NOT NULL, checkout_amount INTEGER NOT NULL, reference TEXT NOT NULL UNIQUE, checkout_url TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'PENDING', valid_until TEXT NOT NULL, paid_at TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
      "CREATE INDEX IF NOT EXISTS idx_cinema_room_orders_account ON cinema_room_plan_orders(account_id,created_at DESC)",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_cinema_room_orders_one_pending ON cinema_room_plan_orders(account_id) WHERE status='PENDING'",
      `INSERT INTO cinema_room_plan_prices(plan,price_pesewas,enabled)
       VALUES ('STUDENT_PLUS',3700,1),('STUDENT_POLITICS_PLUS',5900,1),('ORGANIZER_PRO',8600,1),('PRO_PLUS',11900,1)
       ON CONFLICT(plan) DO UPDATE SET price_pesewas=excluded.price_pesewas
       WHERE cinema_room_plan_prices.updated_by=''
         AND ((excluded.plan='STUDENT_PLUS' AND cinema_room_plan_prices.price_pesewas=2900)
           OR (excluded.plan='ORGANIZER_PRO' AND cinema_room_plan_prices.price_pesewas=7900))`,
      `CREATE TABLE IF NOT EXISTS cinema_room_plan_politics_approvals (
        account_id TEXT PRIMARY KEY, valid_until TEXT NOT NULL DEFAULT '')`,
      `CREATE TABLE IF NOT EXISTS cinema_room_plan_refunds (
        refund_id TEXT PRIMARY KEY, order_reference TEXT NOT NULL, amount INTEGER NOT NULL, created_at TEXT NOT NULL)`,
      "CREATE INDEX IF NOT EXISTS idx_cinema_plan_refunds_order ON cinema_room_plan_refunds(order_reference)",
    ],
  }).catch((error: unknown) => { ready = null; throw error; });
  return ready;
}

export function roomPlanPolicy(plan: unknown) {
  const key = String(plan || "FREE");
  return isCinemaRoomPlan(key) ? CINEMA_ROOM_PLANS[key] : CINEMA_ROOM_PLANS.FREE;
}

export async function activeCinemaRoomPlan(accountId: string) {
  await ensureCinemaRoomPlans();
  const grant = rowsToObjects(await turso(
    "SELECT plan,valid_until FROM cinema_room_plan_grants WHERE account_id = ? AND (valid_until = '' OR valid_until > ?) LIMIT 1",
    [accountId, new Date().toISOString()],
  ))[0];
  const storedPlan = String(grant?.plan || "FREE");
  const plan = isCinemaRoomPlan(storedPlan) ? storedPlan : "FREE";
  return { plan, validUntil: String(grant?.valid_until || ""), ...CINEMA_ROOM_PLANS[plan] };
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
