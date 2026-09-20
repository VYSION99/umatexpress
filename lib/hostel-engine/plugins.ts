import { CampusEngineError } from "@/lib/campus-engine/errors";
import { consoleAudit } from "@/lib/console-audit";
import { ensureHostelResidencyTables } from "@/lib/hostel-engine/residency";
import { incrementMetric, logEvent } from "@/lib/observability";
import { initializePaystackTransaction, verifyPaystackTransaction } from "@/lib/paystack";
import { isTursoConfiguredRuntime, rowsToObjects, runSchemaPass, turso } from "@/lib/turso";

/**
 * Hostel plugins: the services a landlord can switch on for a property.
 *
 * The platform owns the catalogue and prices each plugin once. A landlord
 * subscribes to the ones they want for an academic year and pays the platform
 * a per-year fee for each; that fee sits beside the 9% commission the platform
 * already takes from every bed payment, it does not replace it. The landlord
 * then sets the price a resident pays for the service, and residents request
 * those services from the resident page. A plugin with a resident price of zero
 * is included in the rent.
 */

export const HOSTEL_PLUGIN_CATEGORIES = ["UTILITY", "SERVICE", "COMFORT", "SECURITY"] as const;
export type HostelPluginCategory = (typeof HOSTEL_PLUGIN_CATEGORIES)[number];

export const HOSTEL_SERVICE_STATUSES = ["REQUESTED", "APPROVED", "DECLINED", "ACTIVE", "COMPLETED", "CANCELLED"] as const;
export type HostelServiceStatus = (typeof HOSTEL_SERVICE_STATUSES)[number];

export const HOSTEL_SUBSCRIPTION_STATUSES = ["PENDING_PAYMENT", "ACTIVE", "EXPIRED", "CANCELLED"] as const;
export type HostelSubscriptionStatus = (typeof HOSTEL_SUBSCRIPTION_STATUSES)[number];

export const HOSTEL_PLUGIN_HOLD_MINUTES = 30;

/** Same grace the bed holds get: verify with the provider before letting go. */
export const HOSTEL_PLUGIN_HOLD_GRACE_MINUTES = 15;

/**
 * Prices are pesewas per academic year. Every platform price is different so a
 * landlord's statement can name a plugin without a lookup, and the suggested
 * resident price is a starting point the landlord can change.
 */
export const HOSTEL_PLUGIN_SEED = [
  { code: "WIFI", name: "Fibre Wi-Fi", description: "Shared fibre internet, installed and maintained by the platform's vendor.", category: "UTILITY", price: 24_000, resident: 12_000 },
  { code: "WATER", name: "Water storage & supply", description: "Tank, pump and a guaranteed supply through the dry season.", category: "UTILITY", price: 12_000, resident: 6_000 },
  { code: "POWER", name: "Backup power", description: "Inverter or generator cover for lights, fans and charging.", category: "UTILITY", price: 30_000, resident: 15_000 },
  { code: "LAUNDRY", name: "Laundry service", description: "Weekly wash, dry and fold collected from the hostel.", category: "SERVICE", price: 18_000, resident: 15_000 },
  { code: "CLEANING", name: "Room cleaning", description: "Scheduled cleaning of the room and shared washrooms.", category: "SERVICE", price: 15_000, resident: 8_000 },
  { code: "MEALS", name: "Meal plan", description: "A daily or weekly meal plan delivered to the hostel.", category: "SERVICE", price: 26_000, resident: 40_000 },
  { code: "FURNITURE", name: "Furnished room", description: "Bed, mattress, wardrobe, desk and chair included.", category: "COMFORT", price: 36_000, resident: 24_000 },
  { code: "SECURITY", name: "24/7 security", description: "Gated entry, night guard and visitor logging.", category: "SECURITY", price: 20_000, resident: 10_000 },
  { code: "MAINTENANCE", name: "Maintenance & repairs", description: "Same-week repairs for plumbing, wiring and fittings.", category: "SERVICE", price: 10_000, resident: 0 },
  { code: "PEST", name: "Pest control", description: "Termite and mosquito treatment each term.", category: "SERVICE", price: 9_000, resident: 0 },
] as const;

const PLUGIN_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS hostel_plugins (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'SERVICE',
    price INTEGER NOT NULL,
    suggested_resident_price INTEGER NOT NULL DEFAULT 0,
    billing_period TEXT NOT NULL DEFAULT 'ACADEMIC_YEAR',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS hostel_plugin_subscriptions (
    id TEXT PRIMARY KEY,
    landlord_id TEXT NOT NULL,
    plugin_id TEXT NOT NULL,
    period_id TEXT NOT NULL,
    property_id TEXT NOT NULL DEFAULT '',
    platform_price INTEGER NOT NULL,
    resident_price INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'PENDING_PAYMENT',
    reference TEXT NOT NULL,
    access_token_hash TEXT NOT NULL DEFAULT '',
    hold_expires_at TEXT NOT NULL DEFAULT '',
    activated_at TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS hostel_service_requests (
    id TEXT PRIMARY KEY,
    booking_id TEXT NOT NULL,
    plugin_id TEXT NOT NULL,
    landlord_id TEXT NOT NULL,
    student_email TEXT NOT NULL DEFAULT '',
    price INTEGER NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'REQUESTED',
    decided_by TEXT NOT NULL DEFAULT '',
    decided_at TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_hostel_plugins_code ON hostel_plugins(code)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_hostel_subscriptions_reference ON hostel_plugin_subscriptions(reference)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_hostel_subscriptions_scope ON hostel_plugin_subscriptions(landlord_id, plugin_id, period_id, property_id)",
  "CREATE INDEX IF NOT EXISTS idx_hostel_subscriptions_status ON hostel_plugin_subscriptions(status, hold_expires_at)",
  "CREATE INDEX IF NOT EXISTS idx_hostel_service_booking ON hostel_service_requests(booking_id, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_hostel_service_landlord ON hostel_service_requests(landlord_id, status, created_at DESC)",
];

let pluginTablesReady: Promise<void> | null = null;

export function ensureHostelPluginTables() {
  pluginTablesReady ??= (async () => {
    await ensureHostelResidencyTables();
    await runSchemaPass({ id: "hostel_plugins", version: "015_hostel_plugins", statements: PLUGIN_SCHEMA_STATEMENTS });
    await seedHostelPlugins();
  })();
  return pluginTablesReady;
}

async function seedHostelPlugins() {
  const stamp = new Date().toISOString();
  for (const plugin of HOSTEL_PLUGIN_SEED) {
    await turso(
      `INSERT INTO hostel_plugins (id,code,name,description,category,price,suggested_resident_price,billing_period,active,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,'ACADEMIC_YEAR',1,?,?) ON CONFLICT(code) DO NOTHING`,
      [`plugin_${plugin.code.toLowerCase()}`, plugin.code, plugin.name, plugin.description, plugin.category, plugin.price, plugin.resident, stamp, stamp],
    );
  }
}

/**
 * The catalogue belongs to the platform, not to a landlord: an administrator
 * prices a plugin once and every landlord pays that price. Passing a pluginId
 * edits that entry; passing only a code creates a new one. Switching a plugin
 * off hides it from landlords without touching subscriptions already paid for.
 */
export async function saveHostelPlugin(input: {
  actor: string;
  pluginId?: unknown;
  code?: unknown;
  name?: unknown;
  description?: unknown;
  category?: unknown;
  price?: unknown;
  suggestedResidentPrice?: unknown;
  active?: unknown;
}) {
  await ensureHostelPluginTables();
  const pluginId = String(input.pluginId || "").trim();
  const category = String(input.category ?? "SERVICE").trim().toUpperCase();
  if (!HOSTEL_PLUGIN_CATEGORIES.includes(category as HostelPluginCategory)) {
    throw new CampusEngineError("VALIDATION_ERROR", "Choose one of the plugin categories.", 400);
  }
  const stamp = new Date().toISOString();

  if (pluginId) {
    const existing = rowsToObjects(await turso("SELECT * FROM hostel_plugins WHERE id = ? LIMIT 1", [pluginId]))[0];
    if (!existing) throw new CampusEngineError("NOT_FOUND", "That plugin was not found.", 404);
    const name = input.name === undefined ? String(existing.name) : String(input.name).trim().slice(0, 80);
    if (!name) throw new CampusEngineError("VALIDATION_ERROR", "Give the plugin a name.", 400);
    const price = input.price === undefined ? Number(existing.price) : Math.max(0, Math.round(Number(input.price) || 0));
    const suggested = input.suggestedResidentPrice === undefined
      ? Number(existing.suggested_resident_price)
      : Math.max(0, Math.round(Number(input.suggestedResidentPrice) || 0));
    const active = input.active === undefined ? Number(existing.active) === 1 : Boolean(input.active);
    const description = input.description === undefined
      ? String(existing.description)
      : String(input.description).trim().slice(0, 400);
    await turso(
      `UPDATE hostel_plugins SET name = ?, description = ?, category = ?, price = ?, suggested_resident_price = ?, active = ?, updated_at = ?
       WHERE id = ?`,
      [name, description, category, price, suggested, active ? 1 : 0, stamp, pluginId],
    );
    await consoleAudit({
      actor: input.actor, action: "HOSTEL_PLUGIN_UPDATED", targetType: "hostel_plugin", targetReference: pluginId,
      details: { name, price, suggested, active },
    }).catch(() => undefined);
    return pluginView(rowsToObjects(await turso("SELECT * FROM hostel_plugins WHERE id = ? LIMIT 1", [pluginId]))[0]);
  }

  const code = String(input.code || "").trim().toUpperCase().replace(/[^A-Z0-9_]/g, "").slice(0, 24);
  if (!code) throw new CampusEngineError("VALIDATION_ERROR", "Give the plugin a short code.", 400);
  const name = String(input.name || "").trim().slice(0, 80);
  if (!name) throw new CampusEngineError("VALIDATION_ERROR", "Give the plugin a name.", 400);
  const duplicate = rowsToObjects(await turso("SELECT id FROM hostel_plugins WHERE code = ? LIMIT 1", [code]))[0];
  if (duplicate) throw new CampusEngineError("CONFLICT", `${code} is already on the catalogue.`, 409);
  const id = `plugin_${code.toLowerCase()}`;
  await turso(
    `INSERT INTO hostel_plugins (id,code,name,description,category,price,suggested_resident_price,billing_period,active,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,'ACADEMIC_YEAR',?,?,?)`,
    [
      id, code, name, String(input.description || "").trim().slice(0, 400), category,
      Math.max(0, Math.round(Number(input.price) || 0)),
      Math.max(0, Math.round(Number(input.suggestedResidentPrice) || 0)),
      input.active === false ? 0 : 1, stamp, stamp,
    ],
  );
  await consoleAudit({
    actor: input.actor, action: "HOSTEL_PLUGIN_CREATED", targetType: "hostel_plugin", targetReference: id, details: { code, name },
  }).catch(() => undefined);
  return pluginView(rowsToObjects(await turso("SELECT * FROM hostel_plugins WHERE id = ? LIMIT 1", [id]))[0]);
}

export type HostelPlugin = {
  id: string;
  code: string;
  name: string;
  description: string;
  category: string;
  price: number;
  suggestedResidentPrice: number;
  billingPeriod: string;
  active: boolean;
};

export type HostelPluginSubscription = {
  id: string;
  landlordId: string;
  pluginId: string;
  pluginCode: string;
  pluginName: string;
  pluginCategory: string;
  periodId: string;
  periodName: string;
  propertyId: string;
  platformPrice: number;
  residentPrice: number;
  status: HostelSubscriptionStatus;
  reference: string;
  holdExpiresAt: string;
  activatedAt: string;
  createdAt: string;
};

export type HostelServiceRequest = {
  id: string;
  bookingId: string;
  pluginId: string;
  pluginName: string;
  pluginCategory: string;
  landlordId: string;
  studentEmail: string;
  studentName: string;
  price: number;
  note: string;
  status: HostelServiceStatus;
  decidedBy: string;
  decidedAt: string;
  createdAt: string;
};

function pluginView(row: Record<string, unknown>): HostelPlugin {
  return {
    id: String(row.id || ""),
    code: String(row.code || ""),
    name: String(row.name || ""),
    description: String(row.description || ""),
    category: String(row.category || "SERVICE"),
    price: Number(row.price || 0),
    suggestedResidentPrice: Number(row.suggested_resident_price || 0),
    billingPeriod: String(row.billing_period || "ACADEMIC_YEAR"),
    active: Number(row.active ?? 1) === 1,
  };
}

function subscriptionView(row: Record<string, unknown>): HostelPluginSubscription {
  return {
    id: String(row.id || ""),
    landlordId: String(row.landlord_id || ""),
    pluginId: String(row.plugin_id || ""),
    pluginCode: String(row.plugin_code || ""),
    pluginName: String(row.plugin_name || ""),
    pluginCategory: String(row.plugin_category || ""),
    periodId: String(row.period_id || ""),
    periodName: String(row.period_name || ""),
    propertyId: String(row.property_id || ""),
    platformPrice: Number(row.platform_price || 0),
    residentPrice: Number(row.resident_price || 0),
    status: String(row.status || "PENDING_PAYMENT") as HostelSubscriptionStatus,
    reference: String(row.reference || ""),
    holdExpiresAt: String(row.hold_expires_at || ""),
    activatedAt: String(row.activated_at || ""),
    createdAt: String(row.created_at || ""),
  };
}

function serviceView(row: Record<string, unknown>): HostelServiceRequest {
  return {
    id: String(row.id || ""),
    bookingId: String(row.booking_id || ""),
    pluginId: String(row.plugin_id || ""),
    pluginName: String(row.plugin_name || ""),
    pluginCategory: String(row.plugin_category || ""),
    landlordId: String(row.landlord_id || ""),
    studentEmail: String(row.student_email || ""),
    studentName: String(row.student_name || ""),
    price: Number(row.price || 0),
    note: String(row.note || ""),
    status: String(row.status || "REQUESTED") as HostelServiceStatus,
    decidedBy: String(row.decided_by || ""),
    decidedAt: String(row.decided_at || ""),
    createdAt: String(row.created_at || ""),
  };
}

const SUBSCRIPTION_COLUMNS = `sub.id,sub.landlord_id,sub.plugin_id,sub.period_id,sub.property_id,sub.platform_price,sub.resident_price,sub.status,sub.reference,
  sub.hold_expires_at,sub.activated_at,sub.created_at,
  COALESCE(pl.code,'') AS plugin_code,COALESCE(pl.name,'') AS plugin_name,COALESCE(pl.category,'') AS plugin_category,
  COALESCE(pe.name,'') AS period_name`;

const SUBSCRIPTION_JOINS = `FROM hostel_plugin_subscriptions sub
  LEFT JOIN hostel_plugins pl ON pl.id = sub.plugin_id
  LEFT JOIN hostel_periods pe ON pe.id = sub.period_id`;

export async function listHostelPlugins() {
  await ensureHostelPluginTables();
  const rows = rowsToObjects(await turso("SELECT * FROM hostel_plugins WHERE active = 1 ORDER BY price DESC, name COLLATE NOCASE ASC"));
  return rows.map(pluginView);
}

/** The catalogue as staff see it, including plugins they have switched off. */
export async function listHostelPluginsForStaff() {
  await ensureHostelPluginTables();
  const rows = rowsToObjects(await turso("SELECT * FROM hostel_plugins ORDER BY active DESC, name COLLATE NOCASE ASC"));
  return rows.map(pluginView);
}

export async function listLandlordPluginSubscriptions(landlordId: string) {
  await ensureHostelPluginTables();
  const rows = rowsToObjects(await turso(
    `SELECT ${SUBSCRIPTION_COLUMNS} ${SUBSCRIPTION_JOINS} WHERE sub.landlord_id = ? ORDER BY sub.created_at DESC`,
    [landlordId],
  ));
  return rows.map(subscriptionView);
}

/** What a resident of this property may ask for: active plugins for the year. */
export async function listResidentPlugins(input: { landlordId: string; periodId: string; propertyId?: string }) {
  await ensureHostelPluginTables();
  const rows = rowsToObjects(await turso(
    `SELECT ${SUBSCRIPTION_COLUMNS} ${SUBSCRIPTION_JOINS}
     WHERE sub.landlord_id = ? AND sub.period_id = ? AND sub.status = 'ACTIVE'
       AND (sub.property_id = '' OR sub.property_id = ?)
     ORDER BY pl.name COLLATE NOCASE ASC`,
    [input.landlordId, input.periodId, String(input.propertyId || "")],
  ));
  return rows.map(subscriptionView);
}

export async function releaseExpiredPluginHolds(options: { graceMinutes?: number } = {}) {
  await ensureHostelPluginTables();
  const graceMinutes = Math.max(0, Math.round(options.graceMinutes ?? HOSTEL_PLUGIN_HOLD_GRACE_MINUTES));
  const now = new Date(Date.now() - graceMinutes * 60_000).toISOString();
  const expired = await turso(
    "UPDATE hostel_plugin_subscriptions SET status = 'EXPIRED', updated_at = ? WHERE status = 'PENDING_PAYMENT' AND hold_expires_at <> '' AND hold_expires_at < ?",
    [now, now],
  );
  return Number(expired?.affected_row_count || 0);
}

function subscriptionReference() {
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  return `HP-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

export async function startPluginSubscription(input: {
  landlordId: string;
  landlordEmail: string;
  pluginId: string;
  periodId: string;
  propertyId?: string;
  residentPrice?: number;
  origin: string;
}) {
  if (!(await isTursoConfiguredRuntime())) {
    throw new CampusEngineError("CONFIG_REQUIRED", "Configure Turso before taking plugin subscriptions.", 503);
  }
  await ensureHostelPluginTables();
  await releaseExpiredPluginHolds();

  const plugin = rowsToObjects(await turso("SELECT * FROM hostel_plugins WHERE id = ? AND active = 1 LIMIT 1", [String(input.pluginId || "")]))[0];
  if (!plugin) throw new CampusEngineError("NOT_FOUND", "That plugin is not available.", 404);
  const period = rowsToObjects(await turso("SELECT id FROM hostel_periods WHERE id = ? AND COALESCE(active,1) = 1 LIMIT 1", [String(input.periodId || "")]))[0];
  if (!period) throw new CampusEngineError("VALIDATION_ERROR", "Choose an open academic year.", 400);
  const propertyId = String(input.propertyId || "").trim();
  if (propertyId) {
    const owned = rowsToObjects(await turso("SELECT id FROM hostel_properties WHERE id = ? AND landlord_id = ? LIMIT 1", [propertyId, input.landlordId]))[0];
    if (!owned) throw new CampusEngineError("NOT_FOUND", "That property does not belong to your account.", 404);
  }
  const existing = rowsToObjects(await turso(
    "SELECT id,status FROM hostel_plugin_subscriptions WHERE landlord_id = ? AND plugin_id = ? AND period_id = ? AND property_id = ? LIMIT 1",
    [input.landlordId, String(plugin.id), String(period.id), propertyId],
  ))[0];
  if (existing && String(existing.status) === "ACTIVE") {
    throw new CampusEngineError("CONFLICT", "That plugin is already active for this year.", 409);
  }
  if (existing && String(existing.status) === "PENDING_PAYMENT") {
    throw new CampusEngineError("CONFLICT", "Finish the payment already open for that plugin.", 409);
  }

  const platformPrice = Math.max(0, Math.round(Number(plugin.price || 0)));
  const suggested = Math.max(0, Math.round(Number(plugin.suggested_resident_price || 0)));
  const residentPrice = input.residentPrice === undefined || !Number.isFinite(Number(input.residentPrice))
    ? suggested
    : Math.max(0, Math.round(Number(input.residentPrice)));
  const reference = subscriptionReference();
  const stamp = new Date().toISOString();
  const holdExpiresAt = new Date(Date.now() + HOSTEL_PLUGIN_HOLD_MINUTES * 60_000).toISOString();
  const id = existing ? String(existing.id) : crypto.randomUUID();

  if (existing) {
    await turso(
      "UPDATE hostel_plugin_subscriptions SET status = 'PENDING_PAYMENT', platform_price = ?, resident_price = ?, reference = ?, hold_expires_at = ?, updated_at = ? WHERE id = ?",
      [platformPrice, residentPrice, reference, holdExpiresAt, stamp, id],
    );
  } else {
    await turso(
      `INSERT INTO hostel_plugin_subscriptions (id,landlord_id,plugin_id,period_id,property_id,platform_price,resident_price,status,reference,hold_expires_at,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,'PENDING_PAYMENT',?,?,?,?)`,
      [id, input.landlordId, String(plugin.id), String(period.id), propertyId, platformPrice, residentPrice, reference, holdExpiresAt, stamp, stamp],
    );
  }

  try {
    const paystack = await initializePaystackTransaction({
      email: input.landlordEmail,
      amount: platformPrice,
      reference,
      callbackUrl: `${input.origin}/console/hostels?plugin=${encodeURIComponent(reference)}`,
      metadata: { purpose: "HOSTEL_PLUGIN", reference, pluginCode: String(plugin.code) },
    });
    await incrementMetric("hostel_plugin_started");
    return { subscription: await getPluginSubscriptionByReference(reference), authorizationUrl: paystack.authorizationUrl };
  } catch (error) {
    await turso("UPDATE hostel_plugin_subscriptions SET status = 'CANCELLED', updated_at = ? WHERE reference = ?", [new Date().toISOString(), reference]).catch(() => undefined);
    throw error;
  }
}

export async function getPluginSubscriptionByReference(reference: string) {
  await ensureHostelPluginTables();
  const row = rowsToObjects(await turso(`SELECT ${SUBSCRIPTION_COLUMNS} ${SUBSCRIPTION_JOINS} WHERE sub.reference = ? LIMIT 1`, [String(reference || "")]))[0];
  return row ? subscriptionView(row) : null;
}

/** A failed charge or an abandoned window closes the subscription attempt. */
export async function cancelPluginSubscription(reference: string) {
  await ensureHostelPluginTables();
  const updated = await turso(
    "UPDATE hostel_plugin_subscriptions SET status = 'CANCELLED', updated_at = ? WHERE reference = ? AND status = 'PENDING_PAYMENT'",
    [new Date().toISOString(), String(reference || "")],
  );
  return Number(updated?.affected_row_count || 0) > 0;
}

/** Idempotent activation: checkout return and webhook both land here. */
export async function activatePluginSubscription(input: { reference: string; amount?: number; source: string }) {
  await ensureHostelPluginTables();
  const subscription = await getPluginSubscriptionByReference(input.reference);
  if (!subscription) return { handled: false, reason: "SUBSCRIPTION_NOT_FOUND" as const };
  if (subscription.status === "ACTIVE") return { handled: true, status: "ALREADY_ACTIVE" as const, subscription };
  if (subscription.status !== "PENDING_PAYMENT") return { handled: true, status: "NOT_PENDING" as const, subscription };
  const stamp = new Date().toISOString();
  await turso(
    "UPDATE hostel_plugin_subscriptions SET status = 'ACTIVE', activated_at = ?, hold_expires_at = '', updated_at = ? WHERE reference = ? AND status = 'PENDING_PAYMENT'",
    [stamp, stamp, subscription.reference],
  );
  await incrementMetric("hostel_plugin_activated");
  logEvent("info", "hostel_plugin_activated", { reference: subscription.reference, plugin: subscription.pluginCode, landlord: subscription.landlordId, source: input.source });
  await consoleAudit({
    actor: input.source, action: "HOSTEL_PLUGIN_ACTIVATED", targetType: "hostel_plugin_subscription", targetReference: subscription.reference,
    details: { plugin: subscription.pluginCode, amount: input.amount ?? subscription.platformPrice },
  }).catch(() => undefined);
  return { handled: true, status: "ACTIVE" as const, subscription: await getPluginSubscriptionByReference(subscription.reference) };
}

/**
 * The landlord's checkout return. The console session is the authorisation, so
 * no payment cookie is minted here; the landlord owns every subscription on
 * their own account.
 */
export async function verifyPluginSubscriptionPayment(landlordId: string, reference: string) {
  await ensureHostelPluginTables();
  const subscription = await getPluginSubscriptionByReference(reference);
  if (!subscription) throw new CampusEngineError("NOT_FOUND", "That subscription was not found.", 404);
  if (subscription.landlordId !== landlordId) throw new CampusEngineError("FORBIDDEN", "That subscription belongs to another account.", 403);
  if (subscription.status === "ACTIVE") return subscription;
  if (subscription.status === "EXPIRED" || subscription.status === "CANCELLED") {
    throw new CampusEngineError("INVALID_STATE", "That subscription window has closed. Start it again.", 409);
  }
  if (subscription.holdExpiresAt && subscription.holdExpiresAt < new Date().toISOString()) {
    await releaseExpiredPluginHolds();
    throw new CampusEngineError("INVALID_STATE", "That subscription window has closed. Start it again.", 409);
  }
  const payment = await verifyPaystackTransaction(reference);
  if (payment.status === "SUCCESSFUL" && payment.amount >= subscription.platformPrice) {
    await activatePluginSubscription({ reference, amount: payment.amount, source: "console" });
    return (await getPluginSubscriptionByReference(reference)) as HostelPluginSubscription;
  }
  if (payment.status === "FAILED") {
    await turso("UPDATE hostel_plugin_subscriptions SET status = 'CANCELLED', updated_at = ? WHERE reference = ?", [new Date().toISOString(), reference]);
  }
  return (await getPluginSubscriptionByReference(reference)) as HostelPluginSubscription;
}

/** A resident asks for one of the plugins their hostel has switched on. */
export async function requestHostelService(input: {
  booking: { id: string; landlordId: string; periodId: string; propertyId: string; studentEmail: string; studentName: string; status: string };
  pluginId: string;
  note?: string;
}) {
  await ensureHostelPluginTables();
  if (input.booking.status !== "PAID") {
    throw new CampusEngineError("INVALID_STATE", "Services open once your bed payment is confirmed.", 409);
  }
  const plugin = rowsToObjects(await turso("SELECT * FROM hostel_plugins WHERE id = ? AND active = 1 LIMIT 1", [String(input.pluginId || "")]))[0];
  if (!plugin) throw new CampusEngineError("NOT_FOUND", "That service is not available.", 404);
  const subscription = rowsToObjects(await turso(
    `SELECT id,resident_price FROM hostel_plugin_subscriptions
     WHERE landlord_id = ? AND plugin_id = ? AND period_id = ? AND status = 'ACTIVE' AND (property_id = '' OR property_id = ?) LIMIT 1`,
    [input.booking.landlordId, String(plugin.id), input.booking.periodId, input.booking.propertyId],
  ))[0];
  if (!subscription) throw new CampusEngineError("INVALID_STATE", "Your hostel has not switched that service on.", 409);
  const open = rowsToObjects(await turso(
    "SELECT id FROM hostel_service_requests WHERE booking_id = ? AND plugin_id = ? AND status IN ('REQUESTED','APPROVED','ACTIVE') LIMIT 1",
    [input.booking.id, String(plugin.id)],
  ))[0];
  if (open) throw new CampusEngineError("CONFLICT", "You already have that service in progress.", 409);

  const id = crypto.randomUUID();
  const stamp = new Date().toISOString();
  await turso(
    `INSERT INTO hostel_service_requests (id,booking_id,plugin_id,landlord_id,student_email,price,note,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,'REQUESTED',?,?)`,
    [id, input.booking.id, String(plugin.id), input.booking.landlordId, input.booking.studentEmail, Number(subscription.resident_price || 0), String(input.note || "").slice(0, 300), stamp, stamp],
  );
  await incrementMetric("hostel_service_requested");
  return getHostelServiceRequest(id);
}

export async function getHostelServiceRequest(id: string) {
  await ensureHostelPluginTables();
  const row = rowsToObjects(await turso(
    `SELECT req.*,COALESCE(pl.name,'') AS plugin_name,COALESCE(pl.category,'') AS plugin_category,COALESCE(b.student_name,'') AS student_name
     FROM hostel_service_requests req
     LEFT JOIN hostel_plugins pl ON pl.id = req.plugin_id
     LEFT JOIN hostel_bookings b ON b.id = req.booking_id
     WHERE req.id = ? LIMIT 1`,
    [id],
  ))[0];
  return row ? serviceView(row) : null;
}

export async function listServiceRequestsForBooking(bookingId: string) {
  await ensureHostelPluginTables();
  const rows = rowsToObjects(await turso(
    `SELECT req.*,COALESCE(pl.name,'') AS plugin_name,COALESCE(pl.category,'') AS plugin_category,COALESCE(b.student_name,'') AS student_name
     FROM hostel_service_requests req
     LEFT JOIN hostel_plugins pl ON pl.id = req.plugin_id
     LEFT JOIN hostel_bookings b ON b.id = req.booking_id
     WHERE req.booking_id = ? ORDER BY req.created_at DESC`,
    [bookingId],
  ));
  return rows.map(serviceView);
}

export async function listServiceRequestsForLandlord(landlordId: string, options: { limit?: number } = {}) {
  await ensureHostelPluginTables();
  const limit = Math.min(Math.max(Number(options.limit || 100), 1), 500);
  const rows = rowsToObjects(await turso(
    `SELECT req.*,COALESCE(pl.name,'') AS plugin_name,COALESCE(pl.category,'') AS plugin_category,COALESCE(b.student_name,'') AS student_name
     FROM hostel_service_requests req
     LEFT JOIN hostel_plugins pl ON pl.id = req.plugin_id
     LEFT JOIN hostel_bookings b ON b.id = req.booking_id
     WHERE req.landlord_id = ? ORDER BY CASE req.status WHEN 'REQUESTED' THEN 0 ELSE 1 END,req.created_at DESC LIMIT ${limit}`,
    [landlordId],
  ));
  return rows.map(serviceView);
}

const SERVICE_TRANSITIONS: Record<string, HostelServiceStatus[]> = {
  APPROVE: ["APPROVED"],
  DECLINE: ["DECLINED"],
  START: ["ACTIVE"],
  COMPLETE: ["COMPLETED"],
  CANCEL: ["CANCELLED"],
};

export function isHostelServiceAction(value: unknown): value is keyof typeof SERVICE_TRANSITIONS {
  return typeof value === "string" && Object.hasOwn(SERVICE_TRANSITIONS, value);
}

/** The landlord or their delegate manager moves a request along. */
export async function decideHostelService(input: { landlordId: string; requestId: string; action: keyof typeof SERVICE_TRANSITIONS; actor: string }) {
  await ensureHostelPluginTables();
  const request = await getHostelServiceRequest(String(input.requestId || ""));
  if (!request || request.landlordId !== input.landlordId) {
    throw new CampusEngineError("NOT_FOUND", "That service request was not found.", 404);
  }
  const next = SERVICE_TRANSITIONS[input.action][0];
  const allowedFrom: Record<HostelServiceStatus, HostelServiceStatus[]> = {
    REQUESTED: ["APPROVED", "DECLINED", "CANCELLED"],
    APPROVED: ["ACTIVE", "CANCELLED"],
    ACTIVE: ["COMPLETED", "CANCELLED"],
    DECLINED: [],
    COMPLETED: [],
    CANCELLED: [],
  };
  if (!allowedFrom[request.status].includes(next)) {
    throw new CampusEngineError("INVALID_STATE", `A ${request.status.toLowerCase()} request cannot become ${next.toLowerCase()}.`, 409);
  }
  const stamp = new Date().toISOString();
  await turso(
    "UPDATE hostel_service_requests SET status = ?, decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ?",
    [next, String(input.actor || ""), stamp, stamp, request.id],
  );
  await consoleAudit({
    actor: input.actor, action: `HOSTEL_SERVICE_${input.action}`, targetType: "hostel_service_request", targetReference: request.id,
    details: { from: request.status, to: next },
  }).catch(() => undefined);
  return getHostelServiceRequest(request.id);
}
