import { CampusEngineError } from "@/lib/campus-engine/errors";
import { consoleAudit } from "@/lib/console-audit";
import { ensureHostelMessageTables } from "@/lib/hostel-engine/message-schema";
import type { HostelBooking } from "@/lib/hostel-engine/residency";
import { queueNotification } from "@/lib/notifications";
import { incrementMetric } from "@/lib/observability";
import { rowsToObjects, turso } from "@/lib/turso";

/**
 * Communication for the hostel side.
 *
 * One thread per paid booking, exactly as the chat integration doc scopes it:
 * a landlord cannot read a thread for a bed they do not own, and a student
 * cannot read one they did not book. Messages are durable in Turso, so the
 * resident page and the console poll the same history and an administrator can
 * read it when a dispute needs evidence. There is no third-party realtime
 * vendor: the counterpart is told about a new message through the same outbox
 * that carries booking mail, and each surface polls while it is open.
 *
 * Announcements are the one-to-many half: a landlord or manager writes once to
 * a property and every current resident sees it on the resident page.
 */

export const HOSTEL_MESSAGE_MAX_LENGTH = 2000;

export const HOSTEL_SENDER_TYPES = ["STUDENT", "HOST", "ADMIN", "SYSTEM"] as const;
export type HostelSenderType = (typeof HOSTEL_SENDER_TYPES)[number];

export type HostelMessage = {
  id: string;
  bookingId: string;
  senderType: HostelSenderType;
  senderId: string;
  senderName: string;
  content: string;
  system: boolean;
  readAt: string;
  createdAt: string;
};

function messageView(row: Record<string, unknown>): HostelMessage {
  return {
    id: String(row.id || ""),
    bookingId: String(row.booking_id || ""),
    senderType: String(row.sender_type || "SYSTEM") as HostelSenderType,
    senderId: String(row.sender_id || ""),
    senderName: String(row.sender_name || ""),
    content: String(row.content || ""),
    system: String(row.sender_type || "") === "SYSTEM",
    readAt: String(row.read_at || ""),
    createdAt: String(row.created_at || ""),
  };
}

export type HostelAnnouncement = {
  id: string;
  landlordId: string;
  propertyId: string;
  propertyName: string;
  authorName: string;
  title: string;
  body: string;
  createdAt: string;
};

function announcementView(row: Record<string, unknown>): HostelAnnouncement {
  return {
    id: String(row.id || ""),
    landlordId: String(row.landlord_id || ""),
    propertyId: String(row.property_id || ""),
    propertyName: String(row.property_name || ""),
    authorName: String(row.author_name || ""),
    title: String(row.title || ""),
    body: String(row.body || ""),
    createdAt: String(row.created_at || ""),
  };
}

function cleanContent(value: unknown) {
  const content = String(value ?? "").replace(/\r\n/g, "\n").trim();
  if (!content) throw new CampusEngineError("VALIDATION_ERROR", "Write a message first.", 400);
  if (content.length > HOSTEL_MESSAGE_MAX_LENGTH) {
    throw new CampusEngineError("VALIDATION_ERROR", `Keep the message under ${HOSTEL_MESSAGE_MAX_LENGTH} characters.`, 400);
  }
  return content;
}

/**
 * Reads one thread oldest-first and marks the counterpart's messages as read,
 * because opening the thread is exactly what reading means here.
 */
export async function listHostelMessages(bookingId: string, viewer: "STUDENT" | "HOST", options: { limit?: number } = {}) {
  await ensureHostelMessageTables();
  const limit = Math.min(Math.max(Number(options.limit || 200), 1), 500);
  const rows = rowsToObjects(await turso(
    `SELECT * FROM hostel_messages WHERE booking_id = ? ORDER BY created_at DESC LIMIT ${limit}`,
    [bookingId],
  ));
  const messages = rows.map(messageView).reverse();
  const counterpart: HostelSenderType[] = viewer === "STUDENT" ? ["HOST", "ADMIN"] : ["STUDENT"];
  const unread = messages.filter((message) => counterpart.includes(message.senderType) && !message.readAt).map((message) => message.id);
  if (unread.length) {
    const placeholders = unread.map(() => "?").join(",");
    await turso(
      `UPDATE hostel_messages SET read_by = ?, read_at = ? WHERE id IN (${placeholders}) AND read_at = ''`,
      [viewer, new Date().toISOString(), ...unread],
    ).catch(() => undefined);
  }
  return messages.map((message) => (unread.includes(message.id) ? { ...message, readAt: new Date().toISOString() } : message));
}

export async function unreadHostelMessageCount(bookingId: string, viewer: "STUDENT" | "HOST") {
  await ensureHostelMessageTables();
  const counterpart = viewer === "STUDENT" ? "('HOST','ADMIN')" : "('STUDENT')";
  const row = rowsToObjects(await turso(
    `SELECT COUNT(*) AS c FROM hostel_messages WHERE booking_id = ? AND sender_type IN ${counterpart} AND read_at = ''`,
    [bookingId],
  ))[0];
  return Number(row?.c || 0);
}

/**
 * The same count for a whole page of bookings in one query. The console lists
 * every resident at once, and asking the database once per row would turn one
 * screen into a hundred round trips.
 */
export async function unreadHostelMessageCounts(bookingIds: string[], viewer: "STUDENT" | "HOST") {
  await ensureHostelMessageTables();
  const ids = bookingIds.map((id) => String(id || "")).filter(Boolean);
  if (!ids.length) return new Map<string, number>();
  const placeholders = ids.map(() => "?").join(",");
  const counterpart = viewer === "STUDENT" ? "('HOST','ADMIN')" : "('STUDENT')";
  const rows = rowsToObjects(await turso(
    `SELECT booking_id,COUNT(*) AS c FROM hostel_messages
     WHERE booking_id IN (${placeholders}) AND sender_type IN ${counterpart} AND read_at = ''
     GROUP BY booking_id`,
    ids,
  ));
  return new Map(rows.map((row) => [String(row.booking_id || ""), Number(row.c || 0)]));
}

export async function sendHostelMessage(input: {
  booking: Pick<HostelBooking, "id" | "reference" | "studentEmail" | "studentName" | "landlordId" | "landlordEmail" | "landlordName" | "propertyName">;
  senderType: HostelSenderType;
  senderId: string;
  senderName: string;
  content: unknown;
  metadata?: Record<string, unknown>;
}) {
  await ensureHostelMessageTables();
  const content = cleanContent(input.content);
  const id = crypto.randomUUID();
  const stamp = new Date().toISOString();
  await turso(
    `INSERT INTO hostel_messages (id,booking_id,sender_type,sender_id,sender_name,content,metadata,created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [id, input.booking.id, input.senderType, String(input.senderId || ""), String(input.senderName || "").slice(0, 100), content, JSON.stringify(input.metadata || {}), stamp],
  );
  await incrementMetric("hostel_message_sent");
  await notifyCounterpart(input.booking, input.senderType, content).catch(() => undefined);
  return messageView({ id, booking_id: input.booking.id, sender_type: input.senderType, sender_id: input.senderId, sender_name: input.senderName, content, created_at: stamp });
}

/** Booking events land in the thread so the history explains itself. */
export async function postSystemHostelMessage(booking: Pick<HostelBooking, "id" | "reference">, content: string) {
  await ensureHostelMessageTables();
  await turso(
    `INSERT INTO hostel_messages (id,booking_id,sender_type,sender_id,sender_name,content,metadata,read_at,created_at)
     VALUES (?,?,'SYSTEM','','UMaTeXPRESS',?,'',?,?)`,
    [crypto.randomUUID(), booking.id, cleanContent(content), new Date().toISOString(), new Date().toISOString()],
  ).catch(() => undefined);
}

async function notifyCounterpart(
  booking: Pick<HostelBooking, "reference" | "studentEmail" | "studentName" | "landlordEmail" | "landlordName" | "propertyName">,
  senderType: HostelSenderType,
  content: string,
) {
  const preview = content.length > 140 ? `${content.slice(0, 137)}...` : content;
  const nowIso = new Date().toISOString();
  if (senderType === "STUDENT" && booking.landlordEmail) {
    await queueNotification(turso, {
      recipient: booking.landlordEmail,
      template: "hostel_message_received",
      subject: `New message about ${booking.propertyName || "your hostel"}`,
      message: `${booking.studentName || booking.studentEmail} wrote: "${preview}". Reply from the console under Bookings.`,
      reference: `${booking.reference}:msg:${crypto.randomUUID()}`,
      nowIso,
    });
  }
  if ((senderType === "HOST" || senderType === "ADMIN") && booking.studentEmail) {
    await queueNotification(turso, {
      recipient: booking.studentEmail,
      template: "hostel_message_received",
      subject: `New message about your hostel bed`,
      message: `${booking.landlordName || "Your hostel"} wrote: "${preview}". Open your resident page to reply.`,
      reference: `${booking.reference}:msg:${crypto.randomUUID()}`,
      nowIso,
    });
  }
}

export async function listHostelAnnouncements(input: { landlordId: string; propertyId?: string; limit?: number }) {
  await ensureHostelMessageTables();
  const limit = Math.min(Math.max(Number(input.limit || 20), 1), 100);
  const rows = rowsToObjects(await turso(
    `SELECT a.*,COALESCE(p.name,'') AS property_name
     FROM hostel_announcements a
     LEFT JOIN hostel_properties p ON p.id = a.property_id
     WHERE a.landlord_id = ? AND a.status = 'PUBLISHED' AND (a.property_id = '' OR a.property_id = ?)
     ORDER BY a.created_at DESC LIMIT ${limit}`,
    [input.landlordId, String(input.propertyId || "")],
  ));
  return rows.map(announcementView);
}

export async function createHostelAnnouncement(input: {
  landlordId: string; propertyId?: string; authorEmail: string; authorName?: string; title: unknown; body: unknown;
}) {
  await ensureHostelMessageTables();
  const title = String(input.title ?? "").trim().slice(0, 120);
  const body = String(input.body ?? "").trim().slice(0, 2000);
  if (!title || !body) throw new CampusEngineError("VALIDATION_ERROR", "Give the announcement a title and a message.", 400);
  const propertyId = String(input.propertyId || "").trim();
  if (propertyId) {
    const owned = rowsToObjects(await turso("SELECT id FROM hostel_properties WHERE id = ? AND landlord_id = ? LIMIT 1", [propertyId, input.landlordId]))[0];
    if (!owned) throw new CampusEngineError("NOT_FOUND", "That property does not belong to your account.", 404);
  }
  const id = crypto.randomUUID();
  const stamp = new Date().toISOString();
  await turso(
    `INSERT INTO hostel_announcements (id,landlord_id,property_id,author_email,author_name,title,body,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,'PUBLISHED',?,?)`,
    [id, input.landlordId, propertyId, input.authorEmail, String(input.authorName || "").slice(0, 100), title, body, stamp, stamp],
  );
  await consoleAudit({
    actor: input.authorEmail, action: "HOSTEL_ANNOUNCEMENT_PUBLISHED", targetType: "hostel_announcement", targetReference: id,
    details: { propertyId, title },
  }).catch(() => undefined);
  const rows = rowsToObjects(await turso(
    `SELECT a.*,COALESCE(p.name,'') AS property_name FROM hostel_announcements a LEFT JOIN hostel_properties p ON p.id = a.property_id WHERE a.id = ? LIMIT 1`,
    [id],
  ));
  return rows[0] ? announcementView(rows[0]) : null;
}

export async function listHostelAnnouncementsForLandlord(landlordId: string) {
  await ensureHostelMessageTables();
  const rows = rowsToObjects(await turso(
    `SELECT a.*,COALESCE(p.name,'') AS property_name
     FROM hostel_announcements a LEFT JOIN hostel_properties p ON p.id = a.property_id
     WHERE a.landlord_id = ? ORDER BY a.created_at DESC LIMIT 100`,
    [landlordId],
  ));
  return rows.map(announcementView);
}
