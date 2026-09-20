import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

/**
 * Residency: the bed a student paid for, the services switched on around it,
 * the thread between the two people, and the delegation that lets a manager
 * answer instead of the owner.
 *
 * The engine runs against a fake Turso that keeps the tables in memory, so a
 * test can assert on the state a query left behind — the bed that stayed
 * reserved, the payout row that was written once, the message the second
 * settle did not write again.
 */

process.env.TURSO_DATABASE_URL = "https://hostel-residency-test.turso.io";
process.env.TURSO_AUTH_TOKEN = "test-token";
process.env.PAYSTACK_SECRET_KEY = "sk_test_hostel_residency_key";
process.env.PAYSTACK_CURRENCY = "GHS";
process.env.CONSOLE_SESSION_SECRET = "test-console-session-secret-at-least-32-chars";
process.env.PAYOUT_ENCRYPTION_KEY = "test-payout-encryption-key-at-least-32-chars";

const landlords = [];
const consoleAccounts = [];
const periods = [];
const properties = [];
const rooms = [];
const spaces = [];
const listings = [];
const bookings = [];
const payouts = [];
const payoutBatches = [];
const outbox = [];
const plugins = [];
const subscriptions = [];
const serviceRequests = [];
const messages = [];
const announcements = [];
const managers = [];

function cell(value) {
  if (value === null || value === undefined) return { type: "null" };
  if (typeof value === "number") return { type: Number.isInteger(value) ? "integer" : "real", value: String(value) };
  return { type: "text", value: String(value) };
}
function table(columns, rows) {
  return { cols: columns.map((name) => ({ name })), rows: rows.map((row) => columns.map((name) => cell(row[name]))) };
}
const empty = { cols: [], rows: [] };
const ok = (result) => ({ type: "ok", response: { result: result || {} } });
const affected = (count) => ok({ affected_row_count: count });
const matched = (pattern, sql) => pattern.test(sql);

const BOOKING_COLUMNS = [
  "id", "reference", "listing_id", "space_id", "room_id", "property_id", "landlord_id", "period_id",
  "student_email", "student_name", "student_phone", "price", "utilities_fee", "total_amount",
  "commission_bps", "commission_amount", "net_amount", "status", "hold_expires_at", "paid_at", "note",
  "created_at", "updated_at", "property_name", "property_address", "room_label", "space_label",
  "period_name", "period_starts_on", "period_ends_on", "landlord_name", "landlord_phone", "landlord_email",
];

/** One booking joined to everything the views read, built from live state. */
function bookingRow(booking) {
  const property = properties.find((item) => item.id === booking.property_id) || {};
  const room = rooms.find((item) => item.id === booking.room_id) || {};
  const space = spaces.find((item) => item.id === booking.space_id) || {};
  const period = periods.find((item) => item.id === booking.period_id) || {};
  const landlord = landlords.find((item) => item.id === booking.landlord_id) || {};
  return {
    ...booking,
    property_name: property.name || "",
    property_address: property.address || "",
    room_label: room.label || "",
    space_label: space.label || "",
    period_name: period.name || "",
    period_starts_on: period.starts_on || "",
    period_ends_on: period.ends_on || "",
    landlord_name: landlord.organization || landlord.name || "",
    landlord_phone: landlord.phone || "",
    landlord_email: landlord.email || "",
  };
}

/** The listing→bed→room→property→landlord join the booking gate reads. */
function bookableRow(listingId) {
  const listing = listings.find((item) => item.id === listingId);
  const space = listing && spaces.find((item) => item.id === listing.space_id);
  const room = space && rooms.find((item) => item.id === space.room_id);
  const property = room && properties.find((item) => item.id === room.property_id);
  const landlord = property && landlords.find((item) => item.id === property.landlord_id);
  const period = listing && periods.find((item) => item.id === listing.period_id);
  if (!listing || !space || !room || !property || !landlord) return null;
  return {
    listing_id: listing.id,
    space_id: space.id,
    period_id: listing.period_id,
    price: listing.price,
    space_status: space.status,
    space_label: space.label,
    room_id: room.id,
    room_label: room.label,
    room_status: room.status,
    utilities_fee: room.utilities_fee,
    property_id: property.id,
    property_name: property.name,
    property_status: property.status,
    utilities_enabled: property.utilities_enabled,
    landlord_id: landlord.id,
    commission_bps: landlord.commission_bps ?? 900,
    landlord_status: landlord.status,
    period_starts_on: period?.starts_on || "",
    period_active: period?.active ?? 0,
  };
}

const SUBSCRIPTION_COLUMNS = [
  "id", "landlord_id", "plugin_id", "period_id", "property_id", "platform_price", "resident_price",
  "status", "reference", "hold_expires_at", "activated_at", "created_at",
  "plugin_code", "plugin_name", "plugin_category", "period_name",
];

function subscriptionRow(subscription) {
  const plugin = plugins.find((item) => item.id === subscription.plugin_id) || {};
  const period = periods.find((item) => item.id === subscription.period_id) || {};
  return {
    ...subscription,
    plugin_code: plugin.code || "",
    plugin_name: plugin.name || "",
    plugin_category: plugin.category || "",
    period_name: period.name || "",
  };
}

const SERVICE_COLUMNS = [
  "id", "booking_id", "plugin_id", "landlord_id", "student_email", "price", "note", "status",
  "decided_by", "decided_at", "created_at", "updated_at", "plugin_name", "plugin_category", "student_name",
];

function serviceRow(request) {
  const plugin = plugins.find((item) => item.id === request.plugin_id) || {};
  const booking = bookings.find((item) => item.id === request.booking_id) || {};
  return {
    ...request,
    plugin_name: plugin.name || "",
    plugin_category: plugin.category || "",
    student_name: booking.student_name || "",
  };
}

function handle(sql, args) {
  // --- console accounts ----------------------------------------------------
  if (matched(/SELECT COALESCE\(token_version,0\) AS token_version FROM console_accounts/, sql)) {
    const row = consoleAccounts.find((item) => item.id === args[0]);
    return ok(row ? table(["token_version"], [{ token_version: row.token_version ?? 0 }]) : empty);
  }
  if (matched(/FROM console_accounts WHERE lower\(email\) = \? LIMIT 1/, sql)) {
    const row = consoleAccounts.find((item) => item.email === String(args[0]).toLowerCase());
    return ok(row ? table(["id", "email", "name", "phone", "role", "status", "profile_id", "token_version"], [row]) : empty);
  }
  if (matched(/INSERT INTO console_accounts/, sql)) {
    const [id, email, name, phone, , , , role, status, profileId, createdAt, updatedAt] = args;
    consoleAccounts.push({ id, email, name, phone, role, status, profile_id: profileId, token_version: 0, created_at: createdAt, updated_at: updatedAt });
    return affected(1);
  }
  if (matched(/UPDATE console_accounts SET role = 'LANDLORD', status = 'ACTIVE'/, sql)) {
    const row = consoleAccounts.find((item) => item.id === args[3]);
    if (row) { row.name = args[0]; row.phone = args[1]; row.status = "ACTIVE"; row.role = "LANDLORD"; }
    return affected(row ? 1 : 0);
  }
  if (matched(/UPDATE console_accounts SET password_hash = \?/, sql)) {
    return affected(consoleAccounts.some((item) => item.id === args[4]) ? 1 : 0);
  }
  if (matched(/UPDATE console_accounts SET token_version = COALESCE\(token_version,0\) \+ 1/, sql)) {
    const row = consoleAccounts.find((item) => item.id === args[1]);
    if (row) row.token_version = Number(row.token_version || 0) + 1;
    return affected(row ? 1 : 0);
  }
  if (matched(/UPDATE console_accounts SET status = 'SUSPENDED'/, sql)) {
    const row = consoleAccounts.find((item) => item.id === args[1]);
    if (row) row.status = "SUSPENDED";
    return affected(row ? 1 : 0);
  }

  // --- landlords and managers ---------------------------------------------
  if (matched(/SELECT id,COALESCE\(email,''\) AS email FROM hostel_landlords WHERE id = \? LIMIT 1/, sql)) {
    const row = landlords.find((item) => item.id === args[0]);
    return ok(row ? table(["id", "email"], [row]) : empty);
  }
  if (matched(/SELECT id FROM hostel_managers WHERE landlord_id = \? AND lower\(email\) = \? AND status = 'ACTIVE' LIMIT 1/, sql)) {
    const row = managers.find((item) => item.landlord_id === args[0] && item.email === String(args[1]).toLowerCase() && item.status === "ACTIVE");
    return ok(row ? table(["id"], [row]) : empty);
  }
  if (matched(/SELECT id,status FROM hostel_managers WHERE landlord_id = \? AND lower\(email\) = \? LIMIT 1/, sql)) {
    const row = managers.find((item) => item.landlord_id === args[0] && item.email === String(args[1]).toLowerCase());
    return ok(row ? table(["id", "status"], [row]) : empty);
  }
  if (matched(/SELECT \* FROM hostel_managers WHERE id = \? AND landlord_id = \? LIMIT 1/, sql)) {
    const row = managers.find((item) => item.id === args[0] && item.landlord_id === args[1]);
    return ok(row ? table(Object.keys(row), [row]) : empty);
  }
  if (matched(/SELECT \* FROM hostel_managers WHERE id = \? LIMIT 1/, sql)) {
    const row = managers.find((item) => item.id === args[0]);
    return ok(row ? table(Object.keys(row), [row]) : empty);
  }
  if (matched(/SELECT \* FROM hostel_managers WHERE landlord_id = \? ORDER BY created_at DESC/, sql)) {
    const rows = managers.filter((item) => item.landlord_id === args[0]);
    return ok(rows.length ? table(Object.keys(rows[0]), rows) : empty);
  }
  if (matched(/UPDATE hostel_managers SET name = \?, phone = \?, status = 'ACTIVE'/, sql)) {
    const row = managers.find((item) => item.id === args[4]);
    if (row) { row.name = args[0]; row.phone = args[1]; row.status = "ACTIVE"; row.invited_by = args[2]; }
    return affected(row ? 1 : 0);
  }
  if (matched(/INSERT INTO hostel_managers/, sql)) {
    const [id, landlordId, name, email, phone, invitedBy, createdAt, updatedAt] = args;
    managers.push({ id, landlord_id: landlordId, name, email, phone, status: "ACTIVE", invited_by: invitedBy, created_at: createdAt, updated_at: updatedAt });
    return affected(1);
  }
  if (matched(/UPDATE hostel_managers SET status = 'REVOKED'/, sql)) {
    const row = managers.find((item) => item.id === args[1]);
    if (row) row.status = "REVOKED";
    return affected(row ? 1 : 0);
  }

  // --- periods, properties, rooms, beds ------------------------------------
  if (matched(/FROM hostel_periods WHERE id = \? AND COALESCE\(active,1\) = 1 LIMIT 1/, sql)) {
    const row = periods.find((item) => item.id === args[0] && item.active === 1);
    return ok(row ? table(["id", "name"], [row]) : empty);
  }
  if (matched(/SELECT id FROM hostel_properties WHERE id = \? AND landlord_id = \? LIMIT 1/, sql)) {
    const row = properties.find((item) => item.id === args[0] && item.landlord_id === args[1]);
    return ok(row ? table(["id"], [row]) : empty);
  }

  // --- booking lifecycle ----------------------------------------------------
  if (matched(/FROM hostel_listings l\s+JOIN hostel_spaces s/, sql)) {
    const row = bookableRow(args[0]);
    return ok(row ? table(Object.keys(row), [row]) : empty);
  }
  if (matched(/SELECT reference FROM hostel_bookings WHERE student_email = \? AND period_id = \? AND status IN \('PAID','PAYMENT_REVIEW'\)/, sql)) {
    const row = bookings.find((item) => item.student_email === args[0] && item.period_id === args[1] && ["PAID", "PAYMENT_REVIEW"].includes(item.status));
    return ok(row ? table(["reference"], [row]) : empty);
  }
  if (matched(/SELECT reference FROM hostel_bookings WHERE student_email = \? AND status IN \('PAID','PAYMENT_REVIEW'\)/, sql)) {
    const rows = bookings.filter((item) => item.student_email === args[0] && ["PAID", "PAYMENT_REVIEW"].includes(item.status));
    return ok(rows.length ? table(["reference"], rows) : empty);
  }
  if (matched(/UPDATE hostel_spaces SET status = 'RESERVED'/, sql)) {
    const row = spaces.find((item) => item.id === args[1] && item.status === "AVAILABLE");
    if (row) row.status = "RESERVED";
    return affected(row ? 1 : 0);
  }
  if (matched(/INSERT INTO hostel_bookings/, sql)) {
    const [
      id, reference, listingId, spaceId, roomId, propertyId, landlordId, periodId, studentEmail, studentName, studentPhone,
      price, utilitiesFee, totalAmount, commissionBps, commissionAmount, netAmount, holdExpiresAt, accessTokenHash, note, createdAt, updatedAt,
    ] = args;
    bookings.push({
      id, reference, listing_id: listingId, space_id: spaceId, room_id: roomId, property_id: propertyId,
      landlord_id: landlordId, period_id: periodId, student_email: studentEmail, student_name: studentName,
      student_phone: studentPhone, price, utilities_fee: utilitiesFee, total_amount: totalAmount,
      commission_bps: commissionBps, commission_amount: commissionAmount, net_amount: netAmount,
      status: "PENDING_PAYMENT", hold_expires_at: holdExpiresAt, paid_at: "", access_token_hash: accessTokenHash,
      note, created_at: createdAt, updated_at: updatedAt,
    });
    return affected(1);
  }
  if (matched(/UPDATE hostel_bookings SET status = 'CANCELLED'/, sql)) {
    const row = bookings.find((item) => item.reference === args[1]);
    if (row) row.status = "CANCELLED";
    return affected(row ? 1 : 0);
  }
  if (matched(/UPDATE hostel_bookings SET status = 'PAID'/, sql)) {
    const row = bookings.find((item) => item.reference === args[4] && item.status === "PENDING_PAYMENT");
    if (row) { row.status = "PAID"; row.paid_at = args[0]; row.hold_expires_at = ""; }
    return affected(row ? 1 : 0);
  }
  if (matched(/UPDATE hostel_bookings SET status = 'PAYMENT_REVIEW', paid_at = \?/, sql)) {
    const late = /status IN \('EXPIRED','CANCELLED'\)/.test(sql);
    const row = bookings.find((item) => item.reference === args[4]
      && (late ? ["EXPIRED", "CANCELLED"].includes(item.status) : item.status === "PENDING_PAYMENT"));
    if (row) { row.status = "PAYMENT_REVIEW"; row.paid_at = args[0]; }
    return affected(row ? 1 : 0);
  }
  if (matched(/UPDATE hostel_bookings SET status = 'EXPIRED', hold_expires_at = '', updated_at = \? WHERE reference = \? AND status = 'PENDING_PAYMENT'/, sql)) {
    const row = bookings.find((item) => item.reference === args[1] && item.status === "PENDING_PAYMENT");
    if (row) { row.status = "EXPIRED"; row.hold_expires_at = ""; }
    return affected(row ? 1 : 0);
  }
  if (matched(/UPDATE hostel_bookings SET status = 'EXPIRED', hold_expires_at = '', updated_at = \? WHERE reference = \?/, sql)) {
    const row = bookings.find((item) => item.reference === args[1]);
    if (row) { row.status = "EXPIRED"; row.hold_expires_at = ""; }
    return affected(row ? 1 : 0);
  }
  if (matched(/UPDATE hostel_bookings SET status = 'EXPIRED', updated_at = \? WHERE status = 'PENDING_PAYMENT' AND hold_expires_at <> '' AND hold_expires_at < \?/, sql)) {
    const due = bookings.filter((item) => item.status === "PENDING_PAYMENT" && item.hold_expires_at && item.hold_expires_at < args[1]);
    due.forEach((item) => { item.status = "EXPIRED"; item.hold_expires_at = ""; });
    return affected(due.length);
  }
  if (matched(/UPDATE hostel_spaces SET status = 'AVAILABLE', updated_at = \?\s+WHERE status = 'RESERVED' AND id IN/, sql)) {
    const due = new Set(bookings.filter((item) => item.status === "PENDING_PAYMENT" && item.hold_expires_at && item.hold_expires_at < args[1]).map((item) => item.space_id));
    const freed = spaces.filter((item) => item.status === "RESERVED" && due.has(item.id));
    freed.forEach((item) => { item.status = "AVAILABLE"; });
    return affected(freed.length);
  }
  if (matched(/UPDATE hostel_spaces SET status = 'AVAILABLE', updated_at = \? WHERE id = \? AND status = 'RESERVED'/, sql)) {
    const row = spaces.find((item) => item.id === args[1] && item.status === "RESERVED");
    if (row) row.status = "AVAILABLE";
    return affected(row ? 1 : 0);
  }
  if (matched(/UPDATE hostel_spaces SET status = 'OCCUPIED', updated_at = \? WHERE id = \?/, sql)) {
    const row = spaces.find((item) => item.id === args[1]);
    if (row) row.status = "OCCUPIED";
    return affected(row ? 1 : 0);
  }
  if (matched(/SELECT access_token_hash FROM hostel_bookings WHERE reference = \? LIMIT 1/, sql)) {
    const row = bookings.find((item) => item.reference === args[0]);
    return ok(row ? table(["access_token_hash"], [row]) : empty);
  }
  if (matched(/FROM hostel_bookings b[\s\S]*WHERE b\.landlord_id = \?/, sql)) {
    const rows = bookings.filter((item) => item.landlord_id === args[0]).map(bookingRow);
    return ok(rows.length ? table(BOOKING_COLUMNS, rows) : empty);
  }
  if (matched(/FROM hostel_bookings b[\s\S]*WHERE b\.reference = \? LIMIT 1/, sql)) {
    const row = bookings.find((item) => item.reference === args[0]);
    return ok(row ? table(BOOKING_COLUMNS, [bookingRow(row)]) : empty);
  }

  // --- payouts --------------------------------------------------------------
  if (matched(/INSERT INTO hostel_payouts/, sql)) {
    const [id, bookingId, landlordId, gross, bps, commission, net, releaseAfter, createdAt, updatedAt] = args;
    if (!payouts.some((item) => item.booking_id === bookingId)) {
      payouts.push({ id, booking_id: bookingId, landlord_id: landlordId, gross_amount: gross, commission_bps: bps, commission_amount: commission, net_amount: net, status: "ACCRUED", release_after: releaseAfter, created_at: createdAt, updated_at: updatedAt });
    }
    return affected(1);
  }

  // --- notifications --------------------------------------------------------
  if (matched(/INSERT INTO notification_outbox/, sql)) {
    const key = `${args[6]}:${args[3]}`;
    if (outbox.some((item) => item.key === key)) return affected(0);
    outbox.push({ key, recipient: args[2], template: args[3], subject: args[4], message: args[5], reference: args[6] });
    return affected(1);
  }

  // --- plugins and subscriptions -------------------------------------------
  if (matched(/INSERT INTO hostel_plugins/, sql)) {
    const [id, code, name, description, category, price, residentPrice, createdAt, updatedAt] = args;
    if (!plugins.some((item) => item.code === code)) {
      plugins.push({ id, code, name, description, category, price, suggested_resident_price: residentPrice, billing_period: "ACADEMIC_YEAR", active: 1, created_at: createdAt, updated_at: updatedAt });
    }
    return affected(1);
  }
  if (matched(/SELECT \* FROM hostel_plugins WHERE id = \? AND active = 1 LIMIT 1/, sql)) {
    const row = plugins.find((item) => item.id === args[0] && item.active === 1);
    return ok(row ? table(Object.keys(row), [row]) : empty);
  }
  if (matched(/SELECT \* FROM hostel_plugins WHERE active = 1 ORDER BY price DESC/, sql)) {
    const rows = plugins.filter((item) => item.active === 1).sort((left, right) => right.price - left.price);
    return ok(rows.length ? table(Object.keys(rows[0]), rows) : empty);
  }
  if (matched(/UPDATE hostel_plugin_subscriptions SET status = 'EXPIRED'/, sql)) {
    const due = subscriptions.filter((item) => item.status === "PENDING_PAYMENT" && item.hold_expires_at && item.hold_expires_at < args[1]);
    due.forEach((item) => { item.status = "EXPIRED"; });
    return affected(due.length);
  }
  if (matched(/SELECT id,status FROM hostel_plugin_subscriptions WHERE landlord_id = \? AND plugin_id = \? AND period_id = \? AND property_id = \? LIMIT 1/, sql)) {
    const row = subscriptions.find((item) => item.landlord_id === args[0] && item.plugin_id === args[1] && item.period_id === args[2] && item.property_id === args[3]);
    return ok(row ? table(["id", "status"], [row]) : empty);
  }
  if (matched(/INSERT INTO hostel_plugin_subscriptions/, sql)) {
    const [id, landlordId, pluginId, periodId, propertyId, platformPrice, residentPrice, reference, holdExpiresAt, createdAt, updatedAt] = args;
    subscriptions.push({ id, landlord_id: landlordId, plugin_id: pluginId, period_id: periodId, property_id: propertyId, platform_price: platformPrice, resident_price: residentPrice, status: "PENDING_PAYMENT", reference, hold_expires_at: holdExpiresAt, activated_at: "", created_at: createdAt, updated_at: updatedAt });
    return affected(1);
  }
  if (matched(/UPDATE hostel_plugin_subscriptions SET status = 'PENDING_PAYMENT', platform_price = \?/, sql)) {
    const row = subscriptions.find((item) => item.id === args[5]);
    if (row) { row.status = "PENDING_PAYMENT"; row.platform_price = args[0]; row.resident_price = args[1]; row.reference = args[2]; row.hold_expires_at = args[3]; }
    return affected(row ? 1 : 0);
  }
  if (matched(/UPDATE hostel_plugin_subscriptions SET status = 'ACTIVE', activated_at = \?/, sql)) {
    const row = subscriptions.find((item) => item.reference === args[2] && item.status === "PENDING_PAYMENT");
    if (row) { row.status = "ACTIVE"; row.activated_at = args[0]; row.hold_expires_at = ""; }
    return affected(row ? 1 : 0);
  }
  if (matched(/UPDATE hostel_plugin_subscriptions SET status = 'CANCELLED', updated_at = \? WHERE reference = \? AND status = 'PENDING_PAYMENT'/, sql)) {
    const row = subscriptions.find((item) => item.reference === args[1] && item.status === "PENDING_PAYMENT");
    if (row) row.status = "CANCELLED";
    return affected(row ? 1 : 0);
  }
  if (matched(/UPDATE hostel_plugin_subscriptions SET status = 'CANCELLED', updated_at = \? WHERE reference = \?/, sql)) {
    const row = subscriptions.find((item) => item.reference === args[1]);
    if (row) row.status = "CANCELLED";
    return affected(row ? 1 : 0);
  }
  if (matched(/FROM hostel_plugin_subscriptions sub[\s\S]*WHERE sub\.reference = \? LIMIT 1/, sql)) {
    const row = subscriptions.find((item) => item.reference === args[0]);
    return ok(row ? table(SUBSCRIPTION_COLUMNS, [subscriptionRow(row)]) : empty);
  }
  if (matched(/FROM hostel_plugin_subscriptions sub[\s\S]*WHERE sub\.landlord_id = \? ORDER BY sub\.created_at DESC/, sql)) {
    const rows = subscriptions.filter((item) => item.landlord_id === args[0]).map(subscriptionRow);
    return ok(rows.length ? table(SUBSCRIPTION_COLUMNS, rows) : empty);
  }
  if (matched(/FROM hostel_plugin_subscriptions[\s\S]*sub\.status = 'ACTIVE'/, sql)) {
    const [landlordId, periodId, propertyId] = args;
    const rows = subscriptions
      .filter((item) => item.landlord_id === landlordId && item.period_id === periodId && item.status === "ACTIVE" && (item.property_id === "" || item.property_id === propertyId))
      .map(subscriptionRow);
    return ok(rows.length ? table(SUBSCRIPTION_COLUMNS, rows) : empty);
  }
  if (matched(/SELECT id,resident_price FROM hostel_plugin_subscriptions/, sql)) {
    const row = subscriptions.find((item) => item.landlord_id === args[0] && item.plugin_id === args[1] && item.period_id === args[2] && item.status === "ACTIVE" && (item.property_id === "" || item.property_id === args[3]));
    return ok(row ? table(["id", "resident_price"], [row]) : empty);
  }

  // --- service requests -----------------------------------------------------
  if (matched(/SELECT id FROM hostel_service_requests WHERE booking_id = \? AND plugin_id = \? AND status IN \('REQUESTED','APPROVED','ACTIVE'\) LIMIT 1/, sql)) {
    const row = serviceRequests.find((item) => item.booking_id === args[0] && item.plugin_id === args[1] && ["REQUESTED", "APPROVED", "ACTIVE"].includes(item.status));
    return ok(row ? table(["id"], [row]) : empty);
  }
  if (matched(/INSERT INTO hostel_service_requests/, sql)) {
    const [id, bookingId, pluginId, landlordId, studentEmail, price, note, createdAt, updatedAt] = args;
    serviceRequests.push({ id, booking_id: bookingId, plugin_id: pluginId, landlord_id: landlordId, student_email: studentEmail, price, note, status: "REQUESTED", decided_by: "", decided_at: "", created_at: createdAt, updated_at: updatedAt });
    return affected(1);
  }
  if (matched(/FROM hostel_service_requests req[\s\S]*WHERE req\.id = \? LIMIT 1/, sql)) {
    const row = serviceRequests.find((item) => item.id === args[0]);
    return ok(row ? table(SERVICE_COLUMNS, [serviceRow(row)]) : empty);
  }
  if (matched(/FROM hostel_service_requests req[\s\S]*WHERE req\.booking_id = \? ORDER BY req\.created_at DESC/, sql)) {
    const rows = serviceRequests.filter((item) => item.booking_id === args[0]).map(serviceRow);
    return ok(rows.length ? table(SERVICE_COLUMNS, rows) : empty);
  }
  if (matched(/FROM hostel_service_requests req[\s\S]*WHERE req\.landlord_id = \? ORDER BY CASE/, sql)) {
    const rows = serviceRequests.filter((item) => item.landlord_id === args[0]).map(serviceRow);
    return ok(rows.length ? table(SERVICE_COLUMNS, rows) : empty);
  }
  if (matched(/UPDATE hostel_service_requests SET status = \?, decided_by = \?, decided_at = \?, updated_at = \? WHERE id = \?/, sql)) {
    const row = serviceRequests.find((item) => item.id === args[4]);
    if (row) { row.status = args[0]; row.decided_by = args[1]; row.decided_at = args[2]; }
    return affected(row ? 1 : 0);
  }

  // --- messages and announcements -------------------------------------------
  if (matched(/INSERT INTO hostel_messages/, sql)) {
    const system = /VALUES \(\?,\?,'SYSTEM'/.test(sql);
    if (system) {
      const [id, bookingId, content, readAt, createdAt] = args;
      messages.push({
        seq: messages.length, id, booking_id: bookingId, sender_type: "SYSTEM", sender_id: "",
        sender_name: "UMaTeXPRESS", content, metadata: "", read_by: "", read_at: readAt, created_at: createdAt,
      });
    } else {
      const [id, bookingId, senderType, senderId, senderName, content, metadata, createdAt] = args;
      messages.push({
        seq: messages.length, id, booking_id: bookingId, sender_type: senderType, sender_id: senderId,
        sender_name: senderName, content, metadata, read_by: "", read_at: "", created_at: createdAt,
      });
    }
    return affected(1);
  }
  if (matched(/SELECT COUNT\(\*\) AS c FROM hostel_messages WHERE booking_id = \? AND sender_type IN/, sql)) {
    const counterpart = /'HOST','ADMIN'/.test(sql) ? ["HOST", "ADMIN"] : ["STUDENT"];
    const count = messages.filter((item) => item.booking_id === args[0] && counterpart.includes(item.sender_type) && !item.read_at).length;
    return ok(table(["c"], [{ c: count }]));
  }
  if (matched(/SELECT booking_id,COUNT\(\*\) AS c FROM hostel_messages/, sql)) {
    const counterpart = /'HOST','ADMIN'/.test(sql) ? ["HOST", "ADMIN"] : ["STUDENT"];
    const ids = args;
    const counted = new Map();
    messages
      .filter((item) => ids.includes(item.booking_id) && counterpart.includes(item.sender_type) && !item.read_at)
      .forEach((item) => counted.set(item.booking_id, (counted.get(item.booking_id) || 0) + 1));
    return ok(table(["booking_id", "c"], [...counted.entries()].map(([booking_id, c]) => ({ booking_id, c }))));
  }
  if (matched(/SELECT \* FROM hostel_messages WHERE booking_id = \? ORDER BY created_at DESC/, sql)) {
    // Newest first, the way the engine reads a thread before reversing it.
    const rows = messages
      .filter((item) => item.booking_id === args[0])
      .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)) || right.seq - left.seq);
    return ok(rows.length ? table(Object.keys(rows[0]), rows) : empty);
  }
  if (matched(/UPDATE hostel_messages SET read_by = \?, read_at = \? WHERE id IN/, sql)) {
    const ids = args.slice(2);
    let count = 0;
    for (const id of ids) {
      const row = messages.find((item) => item.id === id && !item.read_at);
      if (row) { row.read_by = args[0]; row.read_at = args[1]; count += 1; }
    }
    return affected(count);
  }
  if (matched(/INSERT INTO hostel_announcements/, sql)) {
    const [id, landlordId, propertyId, authorEmail, authorName, title, body, createdAt, updatedAt] = args;
    announcements.push({ seq: announcements.length, id, landlord_id: landlordId, property_id: propertyId, author_email: authorEmail, author_name: authorName, title, body, status: "PUBLISHED", created_at: createdAt, updated_at: updatedAt });
    return affected(1);
  }
  if (matched(/FROM hostel_announcements a LEFT JOIN hostel_properties p ON p\.id = a\.property_id\s+WHERE a\.id = \? LIMIT 1/, sql)) {
    const row = announcements.find((item) => item.id === args[0]);
    if (!row) return ok(empty);
    const property = properties.find((item) => item.id === row.property_id) || {};
    return ok(table(["id", "landlord_id", "property_id", "author_name", "title", "body", "created_at", "property_name"], [{ ...row, property_name: property.name || "" }]));
  }
  if (matched(/FROM hostel_announcements a[\s\S]*WHERE a\.landlord_id = \? AND a\.status = 'PUBLISHED'/, sql)) {
    const rows = announcements
      .filter((item) => item.landlord_id === args[0] && item.status === "PUBLISHED" && (item.property_id === "" || item.property_id === args[1]))
      .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)) || right.seq - left.seq)
      .map((item) => ({ ...item, property_name: (properties.find((property) => property.id === item.property_id) || {}).name || "" }));
    return ok(rows.length ? table(["id", "landlord_id", "property_id", "author_name", "title", "body", "created_at", "property_name"], rows) : empty);
  }
  if (matched(/FROM hostel_announcements a[\s\S]*WHERE a\.landlord_id = \? ORDER BY a\.created_at DESC/, sql)) {
    const rows = announcements
      .filter((item) => item.landlord_id === args[0])
      .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)) || right.seq - left.seq)
      .map((item) => ({ ...item, property_name: (properties.find((property) => property.id === item.property_id) || {}).name || "" }));
    return ok(rows.length ? table(["id", "landlord_id", "property_id", "author_name", "title", "body", "created_at", "property_name"], rows) : empty);
  }

  // --- payout batches -------------------------------------------------------
  if (matched(/SELECT id,name,phone,email,COALESCE\(organization,''\) AS organization/, sql)) {
    const row = landlords.find((item) => item.id === args[0]);
    if (!row) return ok(empty);
    return ok(table(["id", "name", "phone", "email", "organization", "status", "kyc_status", "review_reason", "commission_bps", "created_at", "updated_at"], [{
      id: row.id, name: row.name, phone: row.phone, email: row.email,
      organization: row.organization || "", status: row.status || "ACTIVE",
      kyc_status: row.kyc_status || "PENDING", review_reason: "",
      commission_bps: row.commission_bps ?? 900, created_at: row.created_at || "", updated_at: row.updated_at || "",
    }]));
  }
  if (matched(/SELECT COALESCE\(payout_method,''\) AS payout_method/, sql)) {
    const row = landlords.find((item) => item.id === args[0]);
    if (!row) return ok(empty);
    return ok(table(["payout_method", "payout_account_name", "payout_account_last4", "payout_bank_code", "payout_bank_name", "payout_updated_at"], [{
      payout_method: row.payout_method || "", payout_account_name: row.payout_account_name || "",
      payout_account_last4: row.payout_account_last4 || "", payout_bank_code: row.payout_bank_code || "",
      payout_bank_name: row.payout_bank_name || "", payout_updated_at: row.payout_updated_at || "",
    }]));
  }
  if (matched(/UPDATE hostel_landlords SET payout_method=\?/, sql)) {
    const [method, accountName, sealed, last4, bankCode, bankName, payoutUpdatedAt, updatedAt, landlordId] = args;
    const row = landlords.find((item) => item.id === landlordId);
    if (row) {
      row.payout_method = method; row.payout_account_name = accountName; row.payout_account_number = sealed;
      row.payout_account_last4 = last4; row.payout_bank_code = bankCode; row.payout_bank_name = bankName;
      row.payout_updated_at = payoutUpdatedAt; row.updated_at = updatedAt;
    }
    return affected(row ? 1 : 0);
  }
  if (matched(/SELECT COALESCE\(payout_account_number,''\) AS payout_account_number FROM hostel_landlords/, sql)) {
    const row = landlords.find((item) => item.id === args[0]);
    return ok(row ? table(["payout_account_number"], [{ payout_account_number: row.payout_account_number || "" }]) : empty);
  }
  if (matched(/INSERT INTO hostel_payout_batches/, sql)) {
    const [id, landlordId, reference, note, actor, createdAt, updatedAt] = args;
    payoutBatches.push({ id, landlord_id: landlordId, total_amount: 0, entry_count: 0, transfer_reference: reference, note, created_by: actor, created_at: createdAt, updated_at: updatedAt });
    return affected(1);
  }
  if (matched(/UPDATE hostel_payouts SET status = 'RELEASED', batch_id = \?/, sql)) {
    const [batchId, reference, releasedAt, actor, , landlordId, stamp] = args;
    const rows = payouts.filter((item) => item.landlord_id === landlordId && item.status === "ACCRUED" && String(item.release_after) <= stamp);
    rows.forEach((item) => {
      item.status = "RELEASED"; item.batch_id = batchId; item.transfer_reference = reference;
      item.released_at = releasedAt; item.released_by = actor;
    });
    return affected(rows.length);
  }
  if (matched(/UPDATE hostel_payout_batches SET total_amount = \?, entry_count = \?, updated_at = \? WHERE id = \?/, sql)) {
    const row = payoutBatches.find((item) => item.id === args[3]);
    if (row) { row.total_amount = args[0]; row.entry_count = args[1]; row.updated_at = args[2]; }
    return affected(row ? 1 : 0);
  }
  if (matched(/SELECT COUNT\(\*\) AS entry_count, COALESCE\(SUM\(net_amount\),0\) AS total_amount FROM hostel_payouts WHERE landlord_id = \? AND status = 'ACCRUED' AND release_after <= \?/, sql)) {
    const rows = payouts.filter((item) => item.landlord_id === args[0] && item.status === "ACCRUED" && String(item.release_after) <= args[1]);
    return ok(table(["entry_count", "total_amount"], [{ entry_count: rows.length, total_amount: rows.reduce((sum, item) => sum + Number(item.net_amount), 0) }]));
  }
  if (matched(/SELECT COUNT\(\*\) AS entry_count, COALESCE\(SUM\(net_amount\),0\) AS total_amount FROM hostel_payouts WHERE batch_id = \?/, sql)) {
    const rows = payouts.filter((item) => item.batch_id === args[0]);
    return ok(table(["entry_count", "total_amount"], [{ entry_count: rows.length, total_amount: rows.reduce((sum, item) => sum + Number(item.net_amount), 0) }]));
  }
  if (matched(/SELECT \* FROM hostel_payout_batches WHERE landlord_id = \? ORDER BY created_at DESC/, sql)) {
    const rows = payoutBatches.filter((item) => item.landlord_id === args[0]).sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)));
    return ok(rows.length ? table(Object.keys(rows[0]), rows) : empty);
  }
  if (matched(/SELECT COALESCE\(SUM\(CASE WHEN status = 'ACCRUED' AND release_after <= \?/, sql)) {
    const [stamp] = args;
    const accrued = payouts.filter((item) => item.status === "ACCRUED");
    const payable = accrued.filter((item) => String(item.release_after) <= stamp);
    const sum = (rows) => rows.reduce((total, item) => total + Number(item.net_amount), 0);
    return ok(table(["payable_amount", "accrued_amount", "released_amount", "commission_amount"], [{
      payable_amount: sum(payable), accrued_amount: sum(accrued),
      released_amount: sum(payouts.filter((item) => item.status === "RELEASED")),
      commission_amount: payouts.reduce((total, item) => total + Number(item.commission_amount), 0),
    }]));
  }
  if (matched(/FROM hostel_payouts p\s+LEFT JOIN hostel_bookings b ON b\.id = p\.booking_id/, sql)) {
    const rows = payouts
      .filter((item) => item.landlord_id === args[0])
      .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))
      .map((item) => {
        const booking = bookings.find((entry) => entry.id === item.booking_id) || {};
        return {
          ...item,
          booking_reference: booking.reference || "",
          student_name: booking.student_name || "",
          property_name: (properties.find((entry) => entry.id === booking.property_id) || {}).name || "",
          period_name: (periods.find((entry) => entry.id === booking.period_id) || {}).name || "",
        };
      });
    const columns = ["id", "booking_id", "landlord_id", "gross_amount", "commission_bps", "commission_amount", "net_amount", "status", "release_after", "released_at", "transfer_reference", "created_at", "booking_reference", "student_name", "property_name", "period_name"];
    return ok(rows.length ? table(columns, rows) : empty);
  }
  if (matched(/FROM hostel_landlords l\s+JOIN hostel_payouts p ON p\.landlord_id = l\.id/, sql)) {
    const stamp = args[0];
    const rows = landlords.map((landlord) => {
      const entries = payouts.filter((item) => item.landlord_id === landlord.id);
      const accrued = entries.filter((item) => item.status === "ACCRUED");
      const payable = accrued.filter((item) => String(item.release_after) <= stamp);
      const sum = (list) => list.reduce((total, item) => total + Number(item.net_amount), 0);
      return {
        id: landlord.id, name: landlord.name, organization: landlord.organization || "", email: landlord.email || "",
        phone: landlord.phone || "", status: landlord.status || "ACTIVE", kyc_status: landlord.kyc_status || "PENDING",
        commission_bps: landlord.commission_bps ?? 900, payout_method: landlord.payout_method || "",
        payout_account_name: landlord.payout_account_name || "", payout_account_last4: landlord.payout_account_last4 || "",
        payout_bank_name: landlord.payout_bank_name || "", payout_updated_at: landlord.payout_updated_at || "",
        accrued_amount: sum(accrued), payable_amount: sum(payable), payable_count: payable.length,
        released_amount: sum(entries.filter((item) => item.status === "RELEASED")), entry_count: entries.length,
      };
    }).filter((landlord) => landlord.entry_count > 0);
    const columns = ["id", "name", "organization", "email", "phone", "status", "kyc_status", "commission_bps", "payout_method", "payout_account_name", "payout_account_last4", "payout_bank_name", "payout_updated_at", "accrued_amount", "payable_amount", "payable_count", "released_amount", "entry_count"];
    return ok(rows.length ? table(columns, rows) : empty);
  }

  if (matched(/INSERT INTO rate_limit_windows/, sql) && /RETURNING count/.test(sql)) return ok(table(["count"], [{ count: 1 }]));
  return ok(empty);
}

globalThis.fetch = async (url, init) => {
  const target = String(typeof url === "string" ? url : url?.url || "");
  if (target.includes("api.paystack.co")) {
    if (target.includes("/transaction/verify/")) {
      const reference = decodeURIComponent(target.split("/transaction/verify/")[1]);
      return { ok: true, json: async () => ({ status: true, data: { id: 991_001, reference, amount: paystackAmounts.get(reference) ?? 0, currency: "GHS", status: "success" } }) };
    }
    const body = JSON.parse(init.body);
    paystackAmounts.set(body.reference, body.amount);
    return { ok: true, json: async () => ({ status: true, data: { authorization_url: `https://checkout.paystack.com/${body.reference}`, access_code: "ac_test", reference: body.reference } }) };
  }
  const body = JSON.parse(init.body);
  const results = body.requests
    .filter((request) => request.type === "execute")
    .map(({ stmt }) => {
      const args = (stmt.args || []).map((arg) => (arg.type === "null" ? null : arg.value));
      return handle(stmt.sql, args);
    });
  results.push({ type: "ok" });
  return { ok: true, json: async () => ({ results }) };
};

/** What the mocked Paystack said a reference was worth, for the verify calls. */
const paystackAmounts = new Map();

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => vite.close());

const {
  HOSTEL_DEFAULT_COMMISSION_BPS, listHostelBookingsForLandlord,
  releaseExpiredHostelHolds, settleHostelBooking, startHostelBooking,
} = await vite.ssrLoadModule("/lib/hostel-engine/residency.ts");
const {
  activatePluginSubscription, cancelPluginSubscription, decideHostelService, getPluginSubscriptionByReference,
  listHostelPlugins, listLandlordPluginSubscriptions, listResidentPlugins, listServiceRequestsForBooking,
  listServiceRequestsForLandlord, releaseExpiredPluginHolds, requestHostelService, startPluginSubscription,
} = await vite.ssrLoadModule("/lib/hostel-engine/plugins.ts");
const {
  createHostelAnnouncement, listHostelAnnouncements, listHostelMessages, sendHostelMessage,
  unreadHostelMessageCount, unreadHostelMessageCounts,
} = await vite.ssrLoadModule("/lib/hostel-engine/messages.ts");
const {
  assertHostelOwner, inviteHostelManager, listHostelManagers, resolveHostelHost, revokeHostelManager,
} = await vite.ssrLoadModule("/lib/hostel-engine/managers.ts");
const { authorizeStudentHostelBooking, residentDashboard } = await vite.ssrLoadModule("/lib/hostel-engine/resident.ts");
const {
  getHostelPayoutAccount, hostelPayoutStatement, listHostelPayoutLandlords,
  platformHostelPayoutBalance, recordHostelPayoutBatch, revealHostelPayoutAccount, saveHostelPayoutAccount,
} = await vite.ssrLoadModule("/lib/hostel-engine/payouts.ts");
const { CampusEngineError } = await vite.ssrLoadModule("/lib/campus-engine/errors.ts");

landlords.push({
  id: "landlord-a", name: "Mr. Owusu", organization: "Owusu Hostels", phone: "0551234567",
  email: "owusu@example.com", status: "ACTIVE", commission_bps: 900,
});
consoleAccounts.push({
  id: "acc-owner", email: "owusu@example.com", name: "Mr. Owusu", phone: "0551234567",
  role: "LANDLORD", status: "ACTIVE", profile_id: "landlord-a", token_version: 0,
});
periods.push({ id: "period-1", name: "2025/2026", starts_on: "2025-09-01", ends_on: "2026-07-31", active: 1 });
properties.push({
  id: "property-a", landlord_id: "landlord-a", name: "Owusu Lodge", address: "Tarkwa Banso",
  latitude: 5.3, longitude: -1.99, utilities_enabled: 1, status: "APPROVED",
});
rooms.push({ id: "room-a", property_id: "property-a", label: "A1", capacity: 3, utilities_fee: 5000, status: "ACTIVE" });
spaces.push(
  { id: "space-a", room_id: "room-a", label: "Bed 1", status: "AVAILABLE" },
  { id: "space-b", room_id: "room-a", label: "Bed 2", status: "AVAILABLE" },
);
listings.push(
  { id: "listing-a", space_id: "space-a", period_id: "period-1", price: 120_000, status: "APPROVED" },
  { id: "listing-b", space_id: "space-b", period_id: "period-1", price: 120_000, status: "APPROVED" },
);

const ORIGIN = "https://umatexpress.test";
const student = { email: "ama@st.umat.edu.gh", name: "Ama Mensah", phone: "0240000001" };
const otherStudent = { email: "kofi@st.umat.edu.gh", name: "Kofi Boateng", phone: "0240000002" };

/** Carried between tests, because a residency is a sequence, not a snapshot. */
let heldA;
let paidBooking;
let subscriptionReference = "";

async function holdBed(listingId, who = student) {
  return startHostelBooking({ listingId, student: who, origin: ORIGIN, secure: true });
}

/** The guest key the checkout minted, as the browser would send it back. */
function paymentRequest(reference, token, path = "https://umatexpress.test/api/hostel/bookings") {
  return new Request(path, { headers: { cookie: `umx_payment_access_${reference}=${encodeURIComponent(token)}` } });
}

async function expectError(promise, code, status) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof CampusEngineError, `expected a CampusEngineError, got ${error}`);
    assert.equal(error.code, code);
    if (status !== undefined) assert.equal(error.status, status);
    return true;
  });
}

test("a bed is claimed once, and the split is the platform's 9%", async () => {
  const first = await holdBed("listing-a");
  heldA = first;
  assert.equal(first.booking.status, "PENDING_PAYMENT");
  assert.equal(spaces.find((item) => item.id === "space-a").status, "RESERVED");
  assert.equal(first.booking.commissionBps, HOSTEL_DEFAULT_COMMISSION_BPS);
  // The bed is GH₵1,200 for the year and the room bills GH₵50 of utilities, so
  // the 9% is charged on what the student actually pays.
  assert.equal(first.booking.price, 120_000);
  assert.equal(first.booking.utilitiesFee, 5_000);
  assert.equal(first.booking.totalAmount, 125_000);
  assert.equal(first.booking.commissionAmount, 11_250);
  assert.equal(first.booking.netAmount, 113_750);
  assert.equal(first.holdMinutes, 10);

  // A second student racing for the same bed loses, because the claim is one
  // conditional UPDATE rather than a read followed by a write.
  await expectError(holdBed("listing-a", otherStudent), "INVALID_STATE", 409);
  assert.equal(spaces.find((item) => item.id === "space-a").status, "RESERVED");
  assert.equal(bookings.filter((item) => item.space_id === "space-a").length, 1);
});

test("a student who already paid for this year cannot hold a second bed", async () => {
  spaces.push({ id: "space-e", room_id: "room-a", label: "Bed 5", status: "AVAILABLE" });
  listings.push({ id: "listing-e", space_id: "space-e", period_id: "period-1", price: 95_000, status: "APPROVED" });

  const held = await holdBed("listing-b", otherStudent);
  const settled = await settleHostelBooking({ reference: held.booking.reference, amount: held.booking.totalAmount, transactionId: "tx-kofi", provider: "PAYSTACK", source: "test" });
  assert.equal(settled.status, "PAID");

  // The free bed is not the point: one student holds one bed per academic year.
  await expectError(holdBed("listing-e", otherStudent), "CONFLICT", 409);
  assert.equal(spaces.find((item) => item.id === "space-e").status, "AVAILABLE");
});

test("settling writes the payout once, turns the bed over and opens the thread", async () => {
  const reference = heldA.booking.reference;
  const settled = await settleHostelBooking({ reference, amount: heldA.booking.totalAmount, transactionId: "tx-ama", provider: "PAYSTACK", source: "test" });
  assert.equal(settled.status, "PAID");
  assert.equal(settled.booking.status, "PAID");
  assert.equal(spaces.find((item) => item.id === "space-a").status, "OCCUPIED");

  const payout = payouts.filter((item) => item.booking_id === settled.booking.id);
  assert.equal(payout.length, 1);
  // Cells come back from the fake the way Turso sends them: as text.
  assert.equal(Number(payout[0].commission_amount), 11_250);
  assert.equal(Number(payout[0].net_amount), 113_750);
  assert.equal(payout[0].status, "ACCRUED");

  const studentMail = outbox.filter((item) => item.template === "hostel_booking_confirmed" && item.reference === reference);
  const hostMail = outbox.filter((item) => item.template === "hostel_booking_landlord" && item.reference === `${reference}:host`);
  assert.equal(studentMail.length, 1);
  assert.equal(hostMail.length, 1);
  assert.match(hostMail[0].message, /Your share is 1137\.50/);

  const thread = await listHostelMessages(settled.booking.id, "HOST");
  assert.equal(thread.length, 1);
  assert.equal(thread[0].senderType, "SYSTEM");
  assert.match(thread[0].content, /Payment received/);
  assert.match(thread[0].content, /keeps 112\.50/);

  // Settling again is the same as settling once: no second payout, no second
  // system message, and the late caller is told the booking was already paid.
  const again = await settleHostelBooking({ reference, amount: heldA.booking.totalAmount, source: "webhook" });
  assert.equal(again.status, "ALREADY_PAID");
  assert.equal(payouts.filter((item) => item.booking_id === settled.booking.id).length, 1);
  assert.equal(messages.filter((item) => item.booking_id === settled.booking.id).length, 1);
  assert.equal(outbox.filter((item) => item.template === "hostel_booking_confirmed" && item.reference === reference).length, 1);

  paidBooking = settled.booking;
  const list = await listHostelBookingsForLandlord("landlord-a");
  assert.ok(list.some((item) => item.reference === reference && item.status === "PAID"));
});

test("a short payment is held for review and the bed stays reserved", async () => {
  spaces.push({ id: "space-c", room_id: "room-a", label: "Bed 3", status: "AVAILABLE" });
  listings.push({ id: "listing-c", space_id: "space-c", period_id: "period-1", price: 90_000, status: "APPROVED" });
  const held = await holdBed("listing-c", { email: "yaw@st.umat.edu.gh", name: "Yaw Owusu", phone: "0240000003" });

  const settled = await settleHostelBooking({ reference: held.booking.reference, amount: 60_000, provider: "PAYSTACK", source: "test" });
  assert.equal(settled.status, "PAYMENT_REVIEW");
  assert.equal(spaces.find((item) => item.id === "space-c").status, "RESERVED");
  assert.equal(payouts.some((item) => item.booking_id === held.booking.id), false);
});

test("money that lands after the hold expired goes to a person, not to the void", async () => {
  spaces.push({ id: "space-d", room_id: "room-a", label: "Bed 4", status: "AVAILABLE" });
  listings.push({ id: "listing-d", space_id: "space-d", period_id: "period-1", price: 100_000, status: "APPROVED" });
  const held = await holdBed("listing-d", { email: "adjoa@st.umat.edu.gh", name: "Adjoa Sarpong", phone: "0240000004" });

  // The hold runs out while the student is still on the checkout page.
  bookings.find((item) => item.reference === held.booking.reference).hold_expires_at = new Date(Date.now() - 60_000).toISOString();
  const released = await releaseExpiredHostelHolds({ graceMinutes: 0 });
  assert.ok(released >= 1);
  assert.equal(spaces.find((item) => item.id === "space-d").status, "AVAILABLE");

  const late = await settleHostelBooking({ reference: held.booking.reference, amount: held.booking.totalAmount, transactionId: "tx-late", provider: "PAYSTACK", source: "webhook" });
  assert.equal(late.status, "PAYMENT_REVIEW");
  assert.equal(late.booking.status, "PAYMENT_REVIEW");
  // The bed was not quietly re-reserved for a student whose window had closed.
  assert.equal(spaces.find((item) => item.id === "space-d").status, "AVAILABLE");
});

test("a booking is only readable with its own key", async () => {
  spaces.push({ id: "space-f", room_id: "room-a", label: "Bed 6", status: "AVAILABLE" });
  listings.push({ id: "listing-f", space_id: "space-f", period_id: "period-1", price: 80_000, status: "APPROVED" });
  const held = await holdBed("listing-f", { email: "esi@st.umat.edu.gh", name: "Esi Danso", phone: "0240000005" });
  const reference = held.booking.reference;

  const authorised = await authorizeStudentHostelBooking(paymentRequest(reference, held.token), reference);
  assert.equal(authorised.reference, reference);

  await expectError(authorizeStudentHostelBooking(paymentRequest(reference, "wrong-token"), reference), "FORBIDDEN", 403);
  await expectError(authorizeStudentHostelBooking(new Request("https://umatexpress.test/api/hostel/bookings"), reference), "FORBIDDEN", 403);
  await expectError(authorizeStudentHostelBooking(paymentRequest(reference, held.token), "HP-NOPE"), "NOT_FOUND", 404);
});

test("the catalogue prices every plugin once, and a subscription holds for half an hour", async () => {
  const catalogue = await listHostelPlugins();
  assert.equal(catalogue.length, 10);
  assert.equal(new Set(catalogue.map((plugin) => plugin.price)).size, 10);
  assert.ok(catalogue.every((plugin) => plugin.price > 0 && plugin.suggestedResidentPrice >= 0));

  const started = await startPluginSubscription({
    landlordId: "landlord-a", landlordEmail: "owusu@example.com",
    pluginId: "plugin_wifi", periodId: "period-1", origin: ORIGIN,
  });
  subscriptionReference = started.subscription.reference;
  assert.equal(started.subscription.status, "PENDING_PAYMENT");
  assert.equal(started.subscription.platformPrice, 24_000);
  // The landlord did not name a resident price, so the catalogue's suggestion stands.
  assert.equal(started.subscription.residentPrice, 12_000);
  const holdMs = new Date(started.subscription.holdExpiresAt).getTime() - Date.now();
  assert.ok(holdMs > 29 * 60_000 && holdMs <= 30 * 60_000, `expected a 30 minute hold, got ${holdMs}ms`);

  // A second attempt while the first is unpaid is refused rather than doubled.
  await expectError(startPluginSubscription({
    landlordId: "landlord-a", landlordEmail: "owusu@example.com",
    pluginId: "plugin_wifi", periodId: "period-1", origin: ORIGIN,
  }), "CONFLICT", 409);

  await activatePluginSubscription({ reference: subscriptionReference, amount: 24_000, source: "test" });
  const active = await getPluginSubscriptionByReference(subscriptionReference);
  assert.equal(active.status, "ACTIVE");
  const residentPlugins = await listResidentPlugins({ landlordId: "landlord-a", periodId: "period-1", propertyId: "property-a" });
  assert.equal(residentPlugins.length, 1);
  assert.equal(residentPlugins[0].residentPrice, 12_000);

  // An unpaid window can be abandoned and started again, which is what the
  // console's cancel button does for a checkout the landlord walked away from.
  const needsPayment = await startPluginSubscription({
    landlordId: "landlord-a", landlordEmail: "owusu@example.com",
    pluginId: "plugin_water", periodId: "period-1", origin: ORIGIN,
  });
  assert.equal(await cancelPluginSubscription(needsPayment.subscription.reference), true);
  assert.equal((await getPluginSubscriptionByReference(needsPayment.subscription.reference)).status, "CANCELLED");
  const restarted = await startPluginSubscription({
    landlordId: "landlord-a", landlordEmail: "owusu@example.com",
    pluginId: "plugin_water", periodId: "period-1", origin: ORIGIN,
  });
  assert.equal(restarted.subscription.status, "PENDING_PAYMENT");
  const abandoned = subscriptions.find((item) => item.reference === restarted.subscription.reference);
  abandoned.hold_expires_at = new Date(Date.now() - 60_000).toISOString();
  assert.ok((await releaseExpiredPluginHolds({ graceMinutes: 0 })) >= 1);
  assert.equal((await getPluginSubscriptionByReference(restarted.subscription.reference)).status, "EXPIRED");

  // One row per plugin per year per property: the abandoned water window was
  // reused rather than duplicated when the landlord started it again.
  const owned = await listLandlordPluginSubscriptions("landlord-a");
  assert.equal(owned.length, 2);
  assert.deepEqual(owned.map((item) => item.status).sort(), ["ACTIVE", "EXPIRED"]);
});

test("a service request flows from asked to done, and only the hostel's own services", async () => {
  const booking = paidBooking;

  // A resident's service opens only once the bed is paid for.
  spaces.push({ id: "space-g", room_id: "room-a", label: "Bed 7", status: "AVAILABLE" });
  listings.push({ id: "listing-g", space_id: "space-g", period_id: "period-1", price: 70_000, status: "APPROVED" });
  const unpaid = await holdBed("listing-g", { email: "kojo@st.umat.edu.gh", name: "Kojo Antwi", phone: "0240000006" });
  await expectError(requestHostelService({ booking: unpaid.booking, pluginId: "plugin_wifi" }), "INVALID_STATE", 409);

  // Neither can a service the hostel never switched on.
  await expectError(requestHostelService({ booking, pluginId: "plugin_laundry" }), "INVALID_STATE", 409);

  const asked = await requestHostelService({ booking, pluginId: "plugin_wifi", note: "Please install before I move in." });
  assert.equal(asked.status, "REQUESTED");
  assert.equal(asked.price, 12_000);
  assert.equal(asked.pluginName, "Fibre Wi-Fi");
  assert.equal(asked.studentName, student.name);
  await expectError(requestHostelService({ booking, pluginId: "plugin_wifi" }), "CONFLICT", 409);

  const approved = await decideHostelService({ landlordId: "landlord-a", requestId: asked.id, action: "APPROVE", actor: "owusu@example.com" });
  assert.equal(approved.status, "APPROVED");
  assert.equal(approved.decidedBy, "owusu@example.com");
  // Skipping a step is refused: the machine has one definition, in the engine.
  await expectError(decideHostelService({ landlordId: "landlord-a", requestId: asked.id, action: "COMPLETE", actor: "owusu@example.com" }), "INVALID_STATE", 409);

  assert.equal((await decideHostelService({ landlordId: "landlord-a", requestId: asked.id, action: "START", actor: "delegate@example.com" })).status, "ACTIVE");
  assert.equal((await decideHostelService({ landlordId: "landlord-a", requestId: asked.id, action: "COMPLETE", actor: "delegate@example.com" })).status, "COMPLETED");
  await expectError(decideHostelService({ landlordId: "landlord-a", requestId: asked.id, action: "CANCEL", actor: "owusu@example.com" }), "INVALID_STATE", 409);

  const requests = await listServiceRequestsForLandlord("landlord-a");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].status, "COMPLETED");
  assert.equal((await listServiceRequestsForBooking(booking.id)).length, 1);
  // Another landlord cannot decide a request that is not theirs.
  await expectError(decideHostelService({ landlordId: "landlord-b", requestId: asked.id, action: "CANCEL", actor: "someone@example.com" }), "NOT_FOUND", 404);
});

test("the thread is booking scoped and unread counts follow the reader", async () => {
  const booking = paidBooking;
  const sent = await sendHostelMessage({
    booking, senderType: "STUDENT", senderId: student.email, senderName: student.name,
    content: "Good evening, when can I collect the key?",
  });
  assert.equal(sent.system, false);
  assert.equal(sent.content, "Good evening, when can I collect the key?");
  assert.equal(await unreadHostelMessageCount(booking.id, "HOST"), 1);
  assert.equal((await unreadHostelMessageCounts([booking.id], "HOST")).get(booking.id), 1);

  // Opening a thread is what reading means: the counterpart's messages are
  // stamped read, and the system note is not counted as unread for the host.
  const asHost = await listHostelMessages(booking.id, "HOST");
  assert.equal(asHost.length, 2);
  assert.equal(asHost[0].senderType, "SYSTEM");
  assert.equal(asHost[1].senderType, "STUDENT");
  assert.notEqual(asHost[1].readAt, "");
  assert.equal(await unreadHostelMessageCount(booking.id, "HOST"), 0);
  assert.equal((await unreadHostelMessageCounts([booking.id], "HOST")).get(booking.id) ?? 0, 0);

  await sendHostelMessage({
    booking, senderType: "HOST", senderId: "owusu@example.com", senderName: "Mr. Owusu",
    content: "You can collect it at the office on Monday morning.",
  });
  assert.equal(await unreadHostelMessageCount(booking.id, "STUDENT"), 1);
  await expectError(sendHostelMessage({ booking, senderType: "STUDENT", senderId: student.email, senderName: student.name, content: "   " }), "VALIDATION_ERROR", 400);
  await expectError(sendHostelMessage({ booking, senderType: "STUDENT", senderId: student.email, senderName: student.name, content: "x".repeat(2001) }), "VALIDATION_ERROR", 400);

  const notices = await createHostelAnnouncement({
    landlordId: "landlord-a", propertyId: "property-a", authorEmail: "owusu@example.com", authorName: "Mr. Owusu",
    title: "Water tank cleaning", body: "Saturday morning: expect the taps to be dry until noon.",
  });
  assert.equal(notices.title, "Water tank cleaning");
  await createHostelAnnouncement({
    landlordId: "landlord-a", authorEmail: "owusu@example.com", authorName: "Mr. Owusu",
    title: "Rent receipts", body: "Collect yours from the hostel office.",
  });
  const forProperty = await listHostelAnnouncements({ landlordId: "landlord-a", propertyId: "property-a" });
  // The property's own notice and the one written to every property, newest first.
  assert.equal(forProperty.length, 2);
  assert.equal(forProperty[0].title, "Rent receipts");
  assert.equal(forProperty[1].propertyName, "Owusu Lodge");
  assert.equal((await createHostelAnnouncement({ landlordId: "landlord-a", propertyId: "property-zz", authorEmail: "owusu@example.com", title: "No", body: "No" }).catch(() => null)), null);
});

test("a manager runs the hostel, but only the owner appoints one", async () => {
  const owner = await resolveHostelHost({ email: "owusu@example.com", profileId: "landlord-a" });
  assert.equal(owner.isOwner, true);
  assert.equal(owner.landlordId, "landlord-a");
  assert.equal(assertHostelOwner(owner).isOwner, true);

  // A weak password is refused before any account is created.
  await expectError(inviteHostelManager({
    landlordId: "landlord-a", actorEmail: "owusu@example.com", name: "Kofi Delegate",
    email: "delegate@example.com", phone: "0200000000", password: "password",
  }), "VALIDATION_ERROR", 400);
  assert.equal(consoleAccounts.some((item) => item.email === "delegate@example.com"), false);

  const manager = await inviteHostelManager({
    landlordId: "landlord-a", actorEmail: "owusu@example.com", name: "Kofi Delegate",
    email: "delegate@example.com", phone: "0200000000", password: "Delegate#2026",
  });
  assert.equal(manager.status, "ACTIVE");
  assert.equal(managers.length, 1);
  assert.equal(consoleAccounts.find((item) => item.email === "delegate@example.com").profile_id, "landlord-a");

  const delegated = await resolveHostelHost({ email: "delegate@example.com", profileId: "landlord-a" });
  assert.equal(delegated.isOwner, false);
  assert.equal(delegated.landlordId, "landlord-a");
  assert.equal(delegated.managerId, manager.id);
  // The delegate may work; appointing another manager is the owner's alone.
  await expectError((async () => assertHostelOwner(delegated))(), "FORBIDDEN", 403);

  // An account pointing at this landlord without a manager row is refused, and
  // an account with no landlord profile is refused even earlier.
  await expectError(resolveHostelHost({ email: "stranger@example.com", profileId: "landlord-a" }), "FORBIDDEN", 403);
  await expectError(resolveHostelHost({ email: "owusu@example.com" }), "UNAUTHORIZED", 401);

  assert.equal((await listHostelManagers("landlord-a")).length, 1);
  const revoked = await revokeHostelManager({ landlordId: "landlord-a", managerId: manager.id, actorEmail: "owusu@example.com" });
  assert.equal(revoked.managerId, manager.id);
  assert.equal((await listHostelManagers("landlord-a"))[0].status, "REVOKED");
  assert.equal(consoleAccounts.find((item) => item.email === "delegate@example.com").status, "SUSPENDED");
  await expectError(resolveHostelHost({ email: "delegate@example.com", profileId: "landlord-a" }), "FORBIDDEN", 403);
});

test("the resident dashboard carries the bed, the host's number and the services", async () => {
  const dashboard = await residentDashboard(student.email);
  assert.equal(dashboard.residencies.length, 1);
  const residency = dashboard.residencies[0];
  assert.equal(residency.booking.reference, paidBooking.reference);
  assert.equal(residency.booking.landlordPhone, "0551234567");
  assert.equal(residency.booking.roomLabel, "A1");
  assert.equal(residency.plugins.length, 1);
  assert.equal(residency.plugins[0].pluginName, "Fibre Wi-Fi");
  assert.equal(residency.services.length, 1);
  assert.equal(residency.services[0].status, "COMPLETED");
  assert.ok(residency.unreadMessages >= 1);
  assert.equal(dashboard.announcements.length, 2);
});

test("a payout needs a verified landlord, a saved account and a released entry", async () => {
  const ledger = payouts.filter((item) => item.landlord_id === "landlord-a");
  assert.equal(ledger.length, 2);
  const mine = ledger.find((item) => item.booking_id === paidBooking.id);
  const other = ledger.find((item) => item.booking_id !== paidBooking.id);
  assert.ok(mine && other);
  // Both entries are held: one because its year is far away, the other only
  // until the release window opens a few lines below.
  mine.release_after = "2999-01-01";
  other.release_after = "2999-01-01";

  // KYC first: an unverified landlord is exactly who the money gate stops.
  await expectError(recordHostelPayoutBatch({ landlordId: "landlord-a", reference: "TRF-001", actor: "admin@umat.edu.gh" }), "INVALID_STATE", 409);
  landlords[0].kyc_status = "VERIFIED";

  // Then the destination: money with no address cannot be recorded as sent.
  await expectError(recordHostelPayoutBatch({ landlordId: "landlord-a", reference: "TRF-001", actor: "admin@umat.edu.gh" }), "INVALID_STATE", 409);
  await saveHostelPayoutAccount({
    landlordId: "landlord-a", method: "MOMO", accountName: "Mr. Owusu",
    accountNumber: "0244000111", bankCode: "MTN", actor: "owusu@example.com",
  });

  // Then the release window: an entry held until the year is close stays held.
  await expectError(recordHostelPayoutBatch({ landlordId: "landlord-a", reference: "TRF-001", actor: "admin@umat.edu.gh" }), "INVALID_STATE", 409);
  mine.release_after = "2000-01-01";

  const batch = await recordHostelPayoutBatch({ landlordId: "landlord-a", reference: "TRF-001", note: "First release", actor: "admin@umat.edu.gh" });
  assert.equal(batch.entryCount, 1);
  assert.equal(batch.totalAmount, 113_750);
  assert.equal(mine.status, "RELEASED");
  assert.equal(mine.transfer_reference, "TRF-001");
  assert.equal(mine.released_by, "admin@umat.edu.gh");
  // The other entry is untouched: a batch releases what the window opened.
  assert.equal(other.status, "ACCRUED");
  assert.equal(other.batch_id, undefined);
  assert.equal(payoutBatches.length, 1);
  assert.equal(Number(payoutBatches[0].total_amount), 113_750);
  assert.equal(Number(payoutBatches[0].entry_count), 1);

  // The landlord hears about it, once, and a second attempt finds nothing left.
  const mail = outbox.filter((item) => item.template === "hostel_payout_recorded" && item.reference === batch.id);
  assert.equal(mail.length, 1);
  assert.match(mail[0].message, /TRF-001/);
  await expectError(recordHostelPayoutBatch({ landlordId: "landlord-a", reference: "TRF-002", actor: "admin@umat.edu.gh" }), "INVALID_STATE", 409);
  assert.equal(payoutBatches.length, 1);

  const statement = await hostelPayoutStatement("landlord-a");
  assert.equal(statement.entries.length, 2);
  const paidEntry = statement.entries.find((entry) => entry.bookingId === paidBooking.id);
  assert.equal(paidEntry.status, "RELEASED");
  assert.equal(paidEntry.studentName, "Ama Mensah");
  assert.equal(paidEntry.propertyName, "Owusu Lodge");
  assert.equal(statement.totals.releasedAmount, 113_750);
  assert.equal(statement.totals.payableAmount, 0);
  assert.equal(statement.totals.accruedAmount, 113_750);
  assert.equal(statement.batches.length, 1);

  const { landlords: owed, totals } = await listHostelPayoutLandlords();
  assert.equal(owed.length, 1);
  assert.equal(owed[0].payableAmount, 0);
  assert.equal(owed[0].accruedAmount, 113_750);
  assert.equal(owed[0].releasedAmount, 113_750);
  assert.equal(owed[0].payoutReady, true);
  assert.equal(totals.releasedAmount, 113_750);
  const balance = await platformHostelPayoutBalance();
  assert.equal(balance.releasedAmount, 113_750);
  assert.equal(balance.accruedAmount, 113_750);
  assert.equal(balance.commissionAmount, 22_500);
});

test("a payout account is masked, sealed at rest, and only revealed on the record", async () => {
  const saved = await getHostelPayoutAccount("landlord-a");
  assert.equal(saved.ready, true);
  assert.equal(saved.last4, "0111");
  assert.equal(saved.accountMasked, "••••0111");
  assert.equal(saved.bankName, "MTN");
  // At rest the number is sealed, not stored as typed.
  assert.match(String(landlords[0].payout_account_number), /^v1:/);
  assert.equal(String(landlords[0].payout_account_number).includes("0244000111"), false);

  const revealed = await revealHostelPayoutAccount("landlord-a", "admin@umat.edu.gh");
  assert.equal(revealed.accountNumber, "0244000111");

  // A code nobody offers is refused, so a transfer cannot address a stranger.
  await expectError(saveHostelPayoutAccount({
    landlordId: "landlord-a", method: "MOMO", accountName: "Mr. Owusu",
    accountNumber: "0244000111", bankCode: "NOT-A-NETWORK", actor: "owusu@example.com",
  }), "VALIDATION_ERROR", 400);
});
