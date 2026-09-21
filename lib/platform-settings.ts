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
  | "cinema_retention_hours"
  | "cinema_uploads_enabled"
  | "cinema_max_upload_bytes"
  | "cinema_max_upload_minutes"
  | "cinema_upload_takedown_limit"
  | "cinema_voice_enabled"
  | "cinema_camera_enabled"
  | "cinema_recordings_enabled"
  | "cinema_max_recording_minutes"
  | "cinema_whiteboard_enabled"
  | "cinema_whiteboard_generations_per_hour";
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
  {
    key: "cinema_uploads_enabled",
    kind: "toggle",
    label: "Cinema uploads",
    summary: "Let a host attach one video file to a study room.",
    detail: "On, a host may upload a video to the private bucket and the room plays it for members only. Off stops new uploads; a room that already has one keeps playing it, and the retention job still deletes it. The bytes never have a public URL.",
    env: "CINEMA_UPLOADS_ENABLED",
    fallback: true,
  },
  {
    key: "cinema_max_upload_bytes",
    kind: "number",
    label: "Cinema upload size",
    summary: "The largest video file a study room accepts, in bytes.",
    detail: "Two gigabytes is the documented default. The client is told the part size and splits the file accordingly, and the worker refuses a part that would take the file past this limit. Storage is R2, which charges for bytes held until the retention job deletes them.",
    env: "CINEMA_MAX_UPLOAD_BYTES",
    fallback: 2 * 1024 * 1024 * 1024,
    min: 8 * 1024 * 1024,
    max: 20 * 1024 * 1024 * 1024,
  },
  {
    key: "cinema_max_upload_minutes",
    kind: "number",
    label: "Cinema upload length",
    summary: "The longest video a study room accepts, in minutes, when the server can read its length.",
    detail: "Length is read from the MP4 header the server can see, not from what the uploader claims. A file whose header the server cannot read (some WebM files, or an MP4 that stores its index at the end) is stored with an unknown length and is bounded by the size limit instead; the player still clamps to the media's own length.",
    env: "CINEMA_MAX_UPLOAD_MINUTES",
    fallback: 120,
    min: 1,
    max: 600,
  },
  {
    key: "cinema_upload_takedown_limit",
    kind: "number",
    label: "Cinema upload strikes",
    summary: "How many videos a student may have taken down before uploads are refused.",
    detail: "A moderator's removal counts against the uploader, not the room: when the count reaches this number, that student's new uploads are refused while their rooms keep working with YouTube. A video deleted by retention is not a strike, and the count never touches the rest of the platform.",
    env: "CINEMA_UPLOAD_TAKEDOWN_LIMIT",
    fallback: 2,
    min: 1,
    max: 10,
  },
  {
    key: "cinema_voice_enabled",
    kind: "toggle",
    label: "Cinema voice",
    summary: "Let study-room members talk to each other with their microphone.",
    detail: "On, a member may turn their mic on and the room relays the WebRTC handshake between browsers. The audio itself is peer to peer — or through Cloudflare's TURN relay when a network cannot connect directly — and the platform never records or stores it. Off hides the mic control and refuses new handshakes; rooms keep working.",
    env: "CINEMA_VOICE_ENABLED",
    fallback: true,
  },
  {
    key: "cinema_camera_enabled",
    kind: "toggle",
    label: "Cinema camera",
    summary: "Let study-room members share their camera alongside their voice.",
    detail: "The switch is separate from voice because a camera is the more sensitive of the two: a deployment can allow talking and still refuse video. Off hides the camera control and stops new camera tracks from being negotiated; an already-negotiated track is left to the browser, which is why turning this off is a policy for new rooms rather than a kill switch for a running call.",
    env: "CINEMA_CAMERA_ENABLED",
    fallback: true,
  },
  {
    key: "cinema_recordings_enabled",
    kind: "toggle",
    label: "Cinema recordings",
    summary: "Let a member record their own voice and camera into their private storage.",
    detail: "A recording captures the recorder's own microphone and camera — never the room's video playback — and the room is shown that one is running before it starts. The file lands in the private bucket, only the recorder can download it, and the same retention window that deletes a room's upload deletes it. Off hides the record control.",
    env: "CINEMA_RECORDINGS_ENABLED",
    fallback: true,
  },
  {
    key: "cinema_max_recording_minutes",
    kind: "number",
    label: "Cinema recording length",
    summary: "The longest a single room recording may run, in minutes.",
    detail: "The client stops the recorder at this length so a forgotten tab cannot fill the bucket or the device's memory. The finished file is bounded by the same size limit as an uploaded video, and a recording longer than the byte cap is refused before any part is sent.",
    env: "CINEMA_MAX_RECORDING_MINUTES",
    fallback: 120,
    min: 1,
    max: 600,
  },
  {
    key: "cinema_whiteboard_enabled",
    kind: "toggle",
    label: "Cinema AI whiteboard",
    summary: "Let a study room ask the AI for a diagram, a derivation or a simulated lab.",
    detail: "On, any member may ask a question and the room's context — title, video position, the last few chat lines and the previous board — is sent to Cloudflare's AI, which answers with a bounded scene: text, maths, code, diagrams or simulated steps. The board is stored with the room and deleted by the same retention window. Off hides the panel and refuses new boards; boards already on screen stay readable until retention deletes them.",
    env: "CINEMA_WHITEBOARD_ENABLED",
    fallback: true,
  },
  {
    key: "cinema_whiteboard_generations_per_hour",
    kind: "number",
    label: "Cinema whiteboard pace",
    summary: "How many AI boards one student may ask for in an hour.",
    detail: "Each board is a model call billed to this account, so the pace is a setting rather than a constant. The limit is per student and the room's other members are unaffected; a refused request answers with the seconds to wait. The default is deliberately modest for a classroom.",
    env: "CINEMA_WHITEBOARD_GENERATIONS_PER_HOUR",
    fallback: 12,
    min: 1,
    max: 60,
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
