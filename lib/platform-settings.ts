import { CampusEngineError } from "@/lib/campus-engine/errors";
import { consoleAudit } from "@/lib/console-audit";
import { logEvent } from "@/lib/observability";
import { envValue } from "@/lib/runtime-env";
import { isTursoConfiguredRuntime, rowsToObjects, runSchemaPass, turso } from "@/lib/turso";

/**
 * The deployment-wide switches.
 *
 * A cron that releases money is a policy, not a deploy: turning it on used to
 * mean editing a variable and shipping again. `platform_settings` puts the
 * switch in the console, where the person who owns the policy can flip it, and
 * leaves the environment variable as the fallback for a deployment that never
 * opens the page. Nothing else about the jobs changes: off still means the
 * ledger accrues and a person presses send.
 *
 * One key per setting. A toggle stores "1" or "0" so a read cannot confuse a
 * setting with a missing row; a limit stores its number. Every write lands in
 * the audit log with the administrator who made it.
 */
export const PLATFORM_SETTINGS_SCHEMA_VERSION = "021_platform_settings";

const PLATFORM_SETTINGS_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS platform_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT '',
    updated_by TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  )`,
];

export type PlatformSettingKey =
  | "hostel_payout_auto"
  | "organizer_payout_auto"
  | "cinema_room_idle_minutes"
  | "cinema_retention_hours";
export type PlatformSettingKind = "toggle" | "number";
export type PlatformSettingSource = "SETTING" | "ENV" | "DEFAULT";

export type PlatformSettingDefinition = {
  key: PlatformSettingKey;
  kind: PlatformSettingKind;
  label: string;
  summary: string;
  detail: string;
  /** The variable that decides this switch when no override is stored. */
  env: string;
  /** A toggle's default state, or a limit's default number. */
  fallback: boolean | number;
  /** Bounds for a numeric setting; ignored by toggles. */
  min?: number;
  max?: number;
};

export const PLATFORM_SETTING_DEFINITIONS: readonly PlatformSettingDefinition[] = [
  {
    key: "hostel_payout_auto",
    kind: "toggle",
    label: "Hostel payouts on a schedule",
    summary: "Let the scheduled job release hostel money that has left its window.",
    detail: "On, the release job sends each landlord's payable balance through Paystack on its own. Off, the ledger still accrues and a statement still reconciles, but money waits for an administrator to press Send with Paystack in the hostel payout desk.",
    env: "HOSTEL_PAYOUT_AUTO_ENABLED",
    fallback: false,
  },
  {
    key: "organizer_payout_auto",
    kind: "toggle",
    label: "Organizer payouts on a schedule",
    summary: "Let the same job release vacationRide organizer money.",
    detail: "The trip side of the same switch: payouts for confirmed bookings are transferred unattended. Off keeps every transfer attended, which is the safe default while an organizer is new.",
    env: "PAYOUT_AUTO_ENABLED",
    fallback: false,
  },
  {
    key: "cinema_room_idle_minutes",
    kind: "number",
    label: "Cinema idle rooms",
    summary: "How long a study room may sit with nobody connected before it ends itself.",
    detail: "Cleanup ends a live room once its last socket has been gone this long; a room that was created and never opened ends after the same wait. Five minutes is the floor, so a reconnect after a brief drop cannot kill a room.",
    env: "CINEMA_ROOM_IDLE_MINUTES",
    fallback: 30,
    min: 5,
    max: 24 * 60,
  },
  {
    key: "cinema_retention_hours",
    kind: "number",
    label: "Cinema retention",
    summary: "How long an ended room keeps its chat and membership before cleanup deletes them.",
    detail: "After the host ends a room, its messages and participant list survive for this many hours so a reconnect can still read the last fifty messages. Then the cleanup job purges both and leaves the room as a tombstone. One hour is the floor.",
    env: "CINEMA_RETENTION_HOURS",
    fallback: 2,
    min: 1,
    max: 48,
  },
];

export type PlatformSettingState = PlatformSettingDefinition & {
  enabled: boolean;
  /** A limit's current number; for a toggle, 1 when on and 0 when off. */
  value: number;
  source: PlatformSettingSource;
  updatedBy: string;
  updatedAt: string;
};

type StoredSetting = { value: string; updatedBy: string; updatedAt: string };

/** A read of four console pages in a burst is one query, not four. */
const SETTINGS_CACHE_TTL_MS = 15_000;
let settingsCache: { at: number; rows: Map<string, StoredSetting> } | null = null;

/** Tests and the write path use this so a toggle is visible immediately. */
export function resetPlatformSettingsCache() {
  settingsCache = null;
}

let settingsTableReady: Promise<void> | null = null;

/** Memoised per isolate: a console read must not run DDL on every request. */
export function ensurePlatformSettingsTable() {
  settingsTableReady ??= runSchemaPass({
    metaTable: "campus_schema_meta",
    id: "platformSettings",
    version: PLATFORM_SETTINGS_SCHEMA_VERSION,
    statements: PLATFORM_SETTINGS_STATEMENTS,
  }).catch((error: unknown) => {
    settingsTableReady = null;
    throw error;
  });
  return settingsTableReady;
}

export function platformSettingDefinition(key: unknown) {
  const wanted = String(key ?? "").trim();
  const definition = PLATFORM_SETTING_DEFINITIONS.find((entry) => entry.key === wanted);
  if (!definition) throw new CampusEngineError("VALIDATION_ERROR", "That platform setting does not exist.", 400);
  return definition;
}

function toggleFromText(value: string) {
  const raw = value.trim().toLowerCase();
  if (!raw) return null;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return null;
}

function numberFromText(value: string) {
  const raw = value.trim();
  if (!raw) return null;
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : null;
}

/** A limit is a whole number inside its own bounds, whatever was stored. */
function clampSettingNumber(definition: PlatformSettingDefinition, value: number) {
  const rounded = Math.round(value);
  const min = Number.isFinite(Number(definition.min)) ? Number(definition.min) : 0;
  const max = Number.isFinite(Number(definition.max)) ? Number(definition.max) : Number.MAX_SAFE_INTEGER;
  return Math.min(Math.max(rounded, min), max);
}

async function storedSettings() {
  if (settingsCache && Date.now() - settingsCache.at < SETTINGS_CACHE_TTL_MS) return settingsCache.rows;
  const rows = new Map<string, StoredSetting>();
  try {
    if (await isTursoConfiguredRuntime()) {
      await ensurePlatformSettingsTable();
      for (const row of rowsToObjects(await turso(
        "SELECT key, value, COALESCE(updated_by,'') AS updated_by, COALESCE(updated_at,'') AS updated_at FROM platform_settings",
      ))) {
        const key = String(row.key || "").trim();
        if (!key) continue;
        rows.set(key, {
          value: String(row.value ?? ""),
          updatedBy: String(row.updated_by || ""),
          updatedAt: String(row.updated_at || ""),
        });
      }
    }
  } catch (error) {
    // A switch that cannot be read must not stop the job it guards: fall back
    // to the environment, and leave the failure visible in the logs.
    logEvent("warn", "platform_settings_unreadable", { reason: error instanceof Error ? error.message : "unknown" });
    return new Map<string, StoredSetting>();
  }
  settingsCache = { at: Date.now(), rows };
  return rows;
}

/** What a switch is right now, and where that answer came from. */
export async function platformSettingState(key: PlatformSettingKey): Promise<PlatformSettingState> {
  const definition = platformSettingDefinition(key);
  const stored = (await storedSettings()).get(definition.key);
  if (definition.kind === "number") {
    const storedValue = stored ? numberFromText(stored.value) : null;
    if (stored && storedValue !== null) {
      const value = clampSettingNumber(definition, storedValue);
      return { ...definition, enabled: value > 0, value, source: "SETTING", updatedBy: stored.updatedBy, updatedAt: stored.updatedAt };
    }
    const fromEnv = numberFromText(await envValue(definition.env));
    if (fromEnv !== null) {
      const value = clampSettingNumber(definition, fromEnv);
      return { ...definition, enabled: value > 0, value, source: "ENV", updatedBy: "", updatedAt: "" };
    }
    const value = clampSettingNumber(definition, Number(definition.fallback));
    return { ...definition, enabled: value > 0, value, source: "DEFAULT", updatedBy: "", updatedAt: "" };
  }
  const storedToggle = stored ? toggleFromText(stored.value) : null;
  if (stored && storedToggle !== null) {
    return {
      ...definition,
      enabled: storedToggle,
      value: storedToggle ? 1 : 0,
      source: "SETTING",
      updatedBy: stored.updatedBy,
      updatedAt: stored.updatedAt,
    };
  }
  const fromEnv = toggleFromText(await envValue(definition.env));
  if (fromEnv !== null) {
    return { ...definition, enabled: fromEnv, value: fromEnv ? 1 : 0, source: "ENV", updatedBy: "", updatedAt: "" };
  }
  const fallback = definition.fallback === true;
  return { ...definition, enabled: fallback, value: fallback ? 1 : 0, source: "DEFAULT", updatedBy: "", updatedAt: "" };
}

/** The question every job actually asks. An override wins over the variable. */
export async function platformSettingEnabled(key: PlatformSettingKey) {
  const state = await platformSettingState(key);
  return state.enabled;
}

/** A numeric setting's current value: stored override, variable, or default. */
export async function platformSettingNumber(key: PlatformSettingKey) {
  return (await platformSettingState(key)).value;
}

export async function listPlatformSettings() {
  return Promise.all(PLATFORM_SETTING_DEFINITIONS.map((definition) => platformSettingState(definition.key)));
}

/** Writes the override, records who made it, and answers with the new state. */
export async function setPlatformSetting(input: { key: unknown; enabled?: unknown; value?: unknown; actor: string }) {
  const definition = platformSettingDefinition(input.key);
  const actor = String(input.actor || "").trim() || "unknown";
  await ensurePlatformSettingsTable();
  const stamp = new Date().toISOString();
  let storedValue: string;
  let details: Record<string, unknown>;
  if (definition.kind === "number") {
    const numeric = numberFromText(String(input.value ?? input.enabled ?? ""));
    if (numeric === null) throw new CampusEngineError("VALIDATION_ERROR", "Send a number for that setting.", 400);
    const value = clampSettingNumber(definition, numeric);
    storedValue = String(value);
    details = { key: definition.key, value };
  } else {
    const enabled = toggleFromText(String(input.enabled));
    if (enabled === null) throw new CampusEngineError("VALIDATION_ERROR", "Send true or false for that setting.", 400);
    storedValue = enabled ? "1" : "0";
    details = { key: definition.key, enabled };
  }
  await turso(
    "INSERT INTO platform_settings (key,value,updated_by,updated_at) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at",
    [definition.key, storedValue, actor, stamp],
  );
  resetPlatformSettingsCache();
  await consoleAudit({
    actor,
    action: "platform_setting_updated",
    targetType: "platform_setting",
    targetReference: definition.key,
    details,
  });
  logEvent("info", "platform_setting_updated", { key: definition.key, value: storedValue, actor });
  return platformSettingState(definition.key);
}
