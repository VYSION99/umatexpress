import assert from "node:assert/strict";
import test, { after } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => vite.close());

function sqliteExecutor(db) {
  return async (sql, values = []) => {
    const statement = db.prepare(sql);
    const returnsRows = /^\s*(SELECT|PRAGMA)/i.test(sql) || /RETURNING/i.test(sql);
    if (returnsRows) {
      const records = statement.all(...values);
      const names = records.length ? Object.keys(records[0]) : [];
      return { cols: names.map((name) => ({ name })), rows: records.map((record) => names.map((name) => ({ value: record[name] }))), affected_row_count: records.length };
    }
    const info = statement.run(...values);
    return { affected_row_count: Number(info.changes || 0) };
  };
}

function newDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE notification_outbox (
      id TEXT PRIMARY KEY, channel TEXT NOT NULL, recipient TEXT NOT NULL, template TEXT NOT NULL,
      subject TEXT NOT NULL DEFAULT '', message TEXT NOT NULL, reference TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '',
      available_at TEXT NOT NULL, created_at TEXT NOT NULL, sent_at TEXT, read_at TEXT
    );
    CREATE UNIQUE INDEX idx_notification_dedupe ON notification_outbox(reference, template);
  `);
  return db;
}

test("a repeated transition never queues the same message twice", async () => {
  const { queueNotification } = await vite.ssrLoadModule("/lib/notifications.ts");
  const db = newDatabase();
  const exec = sqliteExecutor(db);
  const input = { recipient: "ama@st.umat.edu.gh", template: "driver_accepted", subject: "Driver accepted", message: "Driver accepted", reference: "CR-1", nowIso: "2026-01-01T00:00:00.000Z" };

  assert.equal(await queueNotification(exec, input), true);
  assert.equal(await queueNotification(exec, input), false);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM notification_outbox").get().c, 1);

  // A different template for the same ride is a genuinely new message.
  assert.equal(await queueNotification(exec, { ...input, template: "driver_arrived", subject: "Driver arrived", message: "Driver arrived" }), true);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM notification_outbox").get().c, 2);
});

test("a passenger without a recipient is skipped", async () => {
  const { queueNotification } = await vite.ssrLoadModule("/lib/notifications.ts");
  const db = newDatabase();
  const exec = sqliteExecutor(db);
  assert.equal(await queueNotification(exec, { recipient: "   ", template: "trip_completed", subject: "Trip completed", message: "Done", reference: "CR-2", nowIso: "2026-01-01T00:00:00.000Z" }), false);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM notification_outbox").get().c, 0);
});

test("claiming a message is exclusive, so two workers cannot both send it", async () => {
  const { queueNotification, claimNotification } = await vite.ssrLoadModule("/lib/notifications.ts");
  const db = newDatabase();
  const exec = sqliteExecutor(db);
  await queueNotification(exec, { recipient: "ama@st.umat.edu.gh", template: "driver_accepted", subject: "Driver accepted", message: "Accepted", reference: "CR-3", nowIso: "2026-01-01T00:00:00.000Z" });
  const id = db.prepare("SELECT id FROM notification_outbox LIMIT 1").get().id;

  assert.equal(await claimNotification(exec, { id, leaseUntil: "2026-01-01T00:10:00.000Z" }), true);
  assert.equal(await claimNotification(exec, { id, leaseUntil: "2026-01-01T00:10:00.000Z" }), false);
  assert.equal(db.prepare("SELECT status, attempts FROM notification_outbox WHERE id = ?").get(id).attempts, 1);
});

test("an abandoned lease is reclaimed but a live one is left alone", async () => {
  const { reclaimStaleNotifications } = await vite.ssrLoadModule("/lib/notifications.ts");
  const db = newDatabase();
  const exec = sqliteExecutor(db);
  db.exec(`
    INSERT INTO notification_outbox (id,channel,recipient,template,message,reference,status,attempts,last_error,available_at,created_at)
    VALUES ('stale','sms','054','t','m','CR-4','SENDING',1,'','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'),
           ('live','sms','054','t','m','CR-5','SENDING',1,'','2026-01-01T01:00:00.000Z','2026-01-01T00:00:00.000Z')
  `);
  assert.equal(await reclaimStaleNotifications(exec, { nowIso: "2026-01-01T00:30:00.000Z" }), 1);
  assert.equal(db.prepare("SELECT status FROM notification_outbox WHERE id = 'stale'").get().status, "PENDING");
  assert.equal(db.prepare("SELECT status FROM notification_outbox WHERE id = 'live'").get().status, "SENDING");
});

test("retention pruning drops stale rows and keeps fresh ones", async () => {
  const { pruneNotifications, notificationBackoffMs } = await vite.ssrLoadModule("/lib/notifications.ts");
  assert.ok(notificationBackoffMs(1) > 0);
  const db = newDatabase();
  const exec = sqliteExecutor(db);
  const now = Date.UTC(2026, 6, 1);
  const insert = db.prepare("INSERT INTO notification_outbox (id,channel,recipient,template,message,reference,status,attempts,last_error,available_at,created_at) VALUES (?,?,?,?,?,?,?,0,'',?,?)");
  const old = new Date(now - 40 * 86_400_000).toISOString();
  const recent = new Date(now - 60_000).toISOString();
  insert.run("old-pending", "sms", "054", "t", "m", "CR-6", "PENDING", old, old);
  insert.run("old-sent", "sms", "054", "t", "m", "CR-7", "SENT", old, old);
  insert.run("new-pending", "sms", "054", "t", "m", "CR-8", "PENDING", recent, recent);

  assert.equal(await pruneNotifications(exec, { now }), 2);
  assert.deepEqual(db.prepare("SELECT id FROM notification_outbox ORDER BY id").all().map((row) => row.id), ["new-pending"]);
});


test("retry backoff grows then caps at an hour", async () => {
  const { notificationBackoffMs } = await vite.ssrLoadModule("/lib/notifications.ts");
  assert.equal(notificationBackoffMs(1), 30_000);
  assert.equal(notificationBackoffMs(2), 120_000);
  assert.equal(notificationBackoffMs(3), 270_000);
  assert.equal(notificationBackoffMs(99), 3_600_000);
  assert.equal(notificationBackoffMs(0), 30_000);
});

test("passenger messages are readable and never contain a boarding PIN", async () => {
  const { campusNotification, CAMPUS_NOTIFY_BY_STATUS } = await vite.ssrLoadModule("/lib/campus-engine/notify-templates.ts");
  const context = { driverName: "Campus Driver 1", queuePosition: 3 };

  const accepted = campusNotification("driver_accepted", context);
  assert.match(accepted.message, /Campus Driver 1/);
  assert.match(accepted.message, /queue #3/);
  assert.equal(accepted.message.includes("PIN"), false);

  const arrived = campusNotification("driver_arrived", context);
  assert.match(arrived.message, /arrived/);

  const cancelled = campusNotification("driver_cancelled", context);
  assert.match(cancelled.message, /cancelled/);

  // The message is what the in-app feed shows, so it carries no URL of its own:
  // the sender adds the ticket link only when it builds the email.
  assert.equal(arrived.message.includes("http"), false);
  const { ticketUrl, CAMPUS_NOTIFY_SUBJECTS } = await vite.ssrLoadModule("/lib/campus-engine/notify-templates.ts");
  assert.equal(ticketUrl("CR-9", "https://rides.example.com/"), "https://rides.example.com/campus/ticket?reference=CR-9");
  assert.equal(ticketUrl("CR-9", ""), "", "no configured origin means no link");
  assert.equal(ticketUrl("", "https://rides.example.com"), "");
  assert.match(CAMPUS_NOTIFY_SUBJECTS.driver_arrived, /arrived/i);

  assert.deepEqual(Object.keys(CAMPUS_NOTIFY_BY_STATUS).sort(), ["ACCEPTED_BY_DRIVER", "CANCELLED_BY_DRIVER", "COMPLETED", "DRIVER_ARRIVED"]);
});

test("only the email carries the ticket link", async () => {
  const { emailBody } = await vite.ssrLoadModule("/lib/notifications.ts");
  const { ticketUrl } = await vite.ssrLoadModule("/lib/campus-engine/notify-templates.ts");

  // The feed stores the bare message, so the link is composed per send.
  assert.equal(emailBody("Driver arrived.", ""), "Driver arrived.");
  assert.equal(
    emailBody("Driver arrived.", ticketUrl("CR-9", "https://rides.example.com")),
    "Driver arrived.\n\nTrack your ride: https://rides.example.com/campus/ticket?reference=CR-9",
  );
});

test("a vacation template links to the vacation ticket, a campus one to the queue ticket", async () => {
  const { emailBody } = await vite.ssrLoadModule("/lib/notifications.ts");
  const { ticketKindForTemplate, ticketLinkForTemplate, ticketUrl } = await vite.ssrLoadModule("/lib/campus-engine/notify-templates.ts");

  // The in-app feed picks the ticket page from the same prefix rule, so a
  // vacation message never opens the campus queue ticket (and vice versa).
  assert.equal(ticketKindForTemplate("vacation_booking_confirmed"), "vacation");
  assert.equal(ticketKindForTemplate("driver_accepted"), "campus");
  assert.equal(ticketKindForTemplate(""), "campus");

  const vacation = ticketLinkForTemplate("vacation_booking_confirmed");
  assert.equal(vacation.path, "/payment/callback");
  assert.equal(vacation.cta, "View your ticket");
  assert.equal(
    emailBody("Ticket confirmed.", ticketUrl("UMX-1", "https://rides.example.com/", vacation.path), vacation.cta),
    "Ticket confirmed.\n\nView your ticket: https://rides.example.com/payment/callback?reference=UMX-1",
  );

  const campus = ticketLinkForTemplate("driver_accepted");
  assert.equal(campus.path, "/campus/ticket");
  assert.equal(campus.cta, "Track your ride");
});

test("a vacation message names what the booking holds and invents nothing", async () => {
  const { vacationCancelledMessage, vacationConfirmedMessage, humanTravelDate, moneyLabel } = await vite.ssrLoadModule("/lib/vacation-notify.ts");

  const row = { reference: "UMX-VAC1", email: "esi@st.umat.edu.gh", seat: 8, travel_date: "2026-10-03", departure_time: "06:30", amount: 18360, booking_status: "CONFIRMED", route_from: "UMaT", route_to: "Accra" };
  const confirmed = vacationConfirmedMessage(row);
  assert.equal(confirmed.subject, "Your UMaTeXPRESS ticket UMX-VAC1 is confirmed");
  assert.match(confirmed.message, /seat 8/);
  assert.match(confirmed.message, /UMaT → Accra/);
  assert.match(confirmed.message, /3 Oct 2026 at 06:30/);
  assert.match(confirmed.message, /GHS 183\.60/);

  // A booking with nothing but a reference still reads as a sentence, and no
  // amount is invented for a fare we were not given.
  const bare = vacationConfirmedMessage({ ...row, seat: "", travel_date: "", departure_time: "", amount: 0, route_from: "", route_to: "" });
  assert.equal(bare.message.includes("GHS"), false);
  assert.equal(bare.message.includes("undefined"), false);
  assert.match(bare.message, /UMX-VAC1/);

  const cancelled = vacationCancelledMessage(row);
  assert.match(cancelled.subject, /cancelled/);
  assert.match(cancelled.message, /UMX-VAC1/);
  assert.equal(cancelled.message.includes("refund"), false, "a message must not promise money the decision has not made");

  assert.equal(humanTravelDate("2026-10-03"), "3 Oct 2026");
  assert.equal(humanTravelDate("not-a-date"), "not-a-date");
  assert.equal(moneyLabel(0), "");
});
