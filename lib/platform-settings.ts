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
 * One key per switch. `value` is stored as "1" or "0" so a read cannot confuse
 * a setting with a missing row, and every write lands in the audit log with the
 * administrator who made it.
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

export type PlatformSettingKey = "hostel_payout_auto" | "organizer_payout_auto";
export type PlatformSettingSource = "SETTING" | "ENV" | "DEFAULT";

export type PlatformSettingDefinition = {
  key: PlatformSettingKey;
  label: string;
  summary: string;
  detail: string;
  /** The variable that decides this switch when no override is stored. */
  env: string;
  fallback: boolean;
};

export const PLATFORM_SETTING_DEFINITIONS: readonly PlatformSettingDefinition[] = [
  {
    key: "hostel_payout_auto",
    label: "Hostel payouts on a schedule",
    summary: "Let the scheduled job release hostel money that has left its window.",
    detail: "On, the release job sends each landlord's payable balance through Paystack on its own. Off, the ledger still accrues and a statement still reconciles, but money waits for an administrator to press Send with Paystack in the hostel payout desk.",
    env: "HOSTEL_PAYOUT_AUTO_ENABLED",
    fallback: false,
  },
  {
    key: "organizer_payout_auto",
    label: "Organizer payouts on a schedule",
    summary: "Let the same job release vacationRide organizer money.",
    detail: "The trip side of the same switch: payouts for confirmed bookings are transferred unattended. Off keeps every transfer attended, which is the safe default while an organizer is new.",
    env: "PAYOUT_AUTO_ENABLED",
    fallback: false,
  },
];

export type PlatformSettingState = PlatformSettingDefinition & {
  enabled: boolean;
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
  const storedValue = stored ? toggleFromText(stored.value) : null;
  if (stored && storedValue !== null) {
    return {
      ...definition,
      enabled: storedValue,
      source: "SETTING",
      updatedBy: stored.updatedBy,
      updatedAt: stored.updatedAt,
    };
  }
  const fromEnv = toggleFromText(await envValue(definition.env));
  if (fromEnv !== null) {
    return { ...definition, enabled: fromEnv, source: "ENV", updatedBy: "", updatedAt: "" };
  }
  return { ...definition, enabled: definition.fallback, source: "DEFAULT", updatedBy: "", updatedAt: "" };
}

/** The question every job actually asks. An override wins over the variable. */
export async function platformSettingEnabled(key: PlatformSettingKey) {
  const state = await platformSettingState(key);
  return state.enabled;
}

export async function listPlatformSettings() {
  return Promise.all(PLATFORM_SETTING_DEFINITIONS.map((definition) => platformSettingState(definition.key)));
}

/** Writes the override, records who made it, and answers with the new state. */
export async function setPlatformSetting(input: { key: unknown; enabled: unknown; actor: string }) {
  const definition = platformSettingDefinition(input.key);
  const enabled = toggleFromText(String(input.enabled));
  if (enabled === null) throw new CampusEngineError("VALIDATION_ERROR", "Send true or false for that setting.", 400);
  const actor = String(input.actor || "").trim() || "unknown";
  await ensurePlatformSettingsTable();
  const stamp = new Date().toISOString();
  await turso(
    "INSERT INTO platform_settings (key,value,updated_by,updated_at) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at",
    [definition.key, enabled ? "1" : "0", actor, stamp],
  );
  resetPlatformSettingsCache();
  await consoleAudit({
    actor,
    action: "platform_setting_updated",
    targetType: "platform_setting",
    targetReference: definition.key,
    details: { key: definition.key, enabled },
  });
  logEvent("info", "platform_setting_updated", { key: definition.key, enabled, actor });
  return { ...definition, enabled, source: "SETTING" as const, updatedBy: actor, updatedAt: stamp };
}
