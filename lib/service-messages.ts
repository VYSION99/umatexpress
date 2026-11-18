import { CampusEngineError } from "@/lib/campus-engine/errors";
import { requireDriver } from "@/lib/campus-engine/driver-auth";
import { consoleAccountFromRequest } from "@/lib/console-auth";
import { getPrintCopyQuoteSettings } from "@/lib/print-copy/directory";
import { queueNotification } from "@/lib/notifications";
import { rateLimitSubject } from "@/lib/rate-limit";
import { studentAccountFromRequest, studentOwnsEmail } from "@/lib/student-auth";
import { rowsToObjects, runSchemaPass, turso } from "@/lib/turso";

export type ServiceMessageType = "campus" | "print-copy";
export type ServiceSenderRole = "STUDENT" | "DRIVER" | "STAFF";

export type ServiceMessage = {
  id: string;
  service: ServiceMessageType;
  reference: string;
  senderRole: ServiceSenderRole;
  senderId: string;
  senderName: string;
  content: string;
  readAt: string;
  createdAt: string;
};

export const CAMPUS_RIDE_STUDENT_CHIPS = [
  "I am at the pickup zone",
  "On my way (2 mins)",
  "Waiting by the signpost",
] as const;

export const CAMPUS_RIDE_DRIVER_CHIPS = [
  "Arriving in 2 minutes",
  "Waiting at the pickup zone",
  "Please have your boarding PIN ready",
] as const;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS service_messages (
    id TEXT PRIMARY KEY,
    service TEXT NOT NULL,
    reference TEXT NOT NULL,
    sender_role TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    sender_name TEXT NOT NULL,
    content TEXT NOT NULL,
    read_at TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_service_messages_thread
    ON service_messages(service, reference, created_at ASC)`,
];

let schemaReady: Promise<void> | null = null;
export function ensureServiceMessagesTable() {
  schemaReady ??= runSchemaPass({
    id: "service-messages-v1",
    version: "1",
    statements: SCHEMA,
  }).catch((error: unknown) => {
    schemaReady = null;
    throw error;
  });
  return schemaReady;
}

export type MessageParticipant = {
  actor: { role: ServiceSenderRole; id: string; name: string; email: string };
  counterpartEmail: string;
  counterpartName: string;
  status: string;
  canSend: boolean;
  chips: readonly string[];
};

export async function resolveServiceParticipant(
  request: Request,
  service: ServiceMessageType,
  reference: string,
): Promise<MessageParticipant> {
  const ref = String(reference || "").trim();
  if (!ref) throw new CampusEngineError("VALIDATION_ERROR", "Reference is required.", 400);

  if (service === "campus") {
    const queueRows = rowsToObjects(await turso(
      `SELECT q.id, q.reference, q.passenger_name, q.phone, q.email, q.queue_status,
              r.id AS ride_id, r.driver_id, d.name AS driver_name, d.email AS driver_email
       FROM campus_queue_entries q
       LEFT JOIN campus_rides r ON r.id = q.ride_id
       LEFT JOIN campus_drivers d ON d.id = r.driver_id
       WHERE q.reference = ? LIMIT 1`,
      [ref],
    ));
    const q = queueRows[0];
    if (!q) throw new CampusEngineError("NOT_FOUND", "Ride queue entry not found.", 404);

    const status = String(q.queue_status || "");
    const canSend = ["ACCEPTED_BY_DRIVER", "DRIVER_ARRIVED", "BOARDED"].includes(status);

    // Check if caller is driver
    try {
      const driver = await requireDriver(request);
      if (driver && driver.id && q.driver_id && driver.id === q.driver_id) {
        return {
          actor: { role: "DRIVER", id: driver.id, name: driver.name || "Driver", email: driver.email || "" },
          counterpartEmail: String(q.email || ""),
          counterpartName: String(q.passenger_name || "Passenger"),
          status,
          canSend,
          chips: CAMPUS_RIDE_DRIVER_CHIPS,
        };
      }
    } catch {
      // Driver check did not match
    }

    // Check if caller is student
    const student = await studentAccountFromRequest(request);
    if (student) {
      const owns = await studentOwnsEmail(request, q.email);
      if (owns) {
        return {
          actor: { role: "STUDENT", id: student.id, name: student.name || String(q.passenger_name || "Passenger"), email: student.email },
          counterpartEmail: String(q.driver_email || ""),
          counterpartName: String(q.driver_name || "Driver"),
          status,
          canSend,
          chips: CAMPUS_RIDE_STUDENT_CHIPS,
        };
      }
    }

    throw new CampusEngineError("FORBIDDEN", "You are not an active participant in this ride.", 403);
  }

  if (service === "print-copy") {
    const quoteRows = rowsToObjects(await turso(
      `SELECT q.id, q.reference, q.student_id, q.student_name, q.student_email, q.status, q.expires_at, p.name AS provider_name
       FROM print_copy_quotes q
       JOIN print_copy_providers p ON p.id = q.provider_id
       WHERE q.reference = ? LIMIT 1`,
      [ref],
    ));
    const quote = quoteRows[0];
    if (!quote) throw new CampusEngineError("NOT_FOUND", "Print & Copy quote not found.", 404);

    const status = String(quote.status || "");
    const isExpired = Boolean(quote.expires_at && String(quote.expires_at) <= new Date().toISOString());
    const canSend = ["NEW", "IN_PROGRESS"].includes(status) && !isExpired;

    // Check if caller is console staff
    const consoleAccount = await consoleAccountFromRequest(request);
    if (consoleAccount && !consoleAccount.mustChangePassword && ["ADMIN", "MODERATOR"].includes(consoleAccount.role)) {
      return {
        actor: { role: "STAFF", id: consoleAccount.id, name: consoleAccount.name || "Print & Copy Staff", email: consoleAccount.email },
        counterpartEmail: String(quote.student_email || ""),
        counterpartName: String(quote.student_name || "Student"),
        status,
        canSend,
        chips: [],
      };
    }

    // Check if caller is student
    const student = await studentAccountFromRequest(request);
    if (student) {
      const owns = (student.id && student.id === quote.student_id) || (await studentOwnsEmail(request, quote.student_email));
      if (owns) {
        const settings = await getPrintCopyQuoteSettings().catch(() => ({ supportOwner: "" }));
        return {
          actor: { role: "STUDENT", id: student.id, name: student.name || String(quote.student_name || "Student"), email: student.email },
          counterpartEmail: settings.supportOwner,
          counterpartName: "Print & Copy Staff",
          status,
          canSend,
          chips: [],
        };
      }
    }

    throw new CampusEngineError("FORBIDDEN", "You are not authorized to access messages for this quote.", 403);
  }

  throw new CampusEngineError("VALIDATION_ERROR", "Unsupported service type.", 400);
}

export async function listServiceMessages(service: ServiceMessageType, reference: string): Promise<ServiceMessage[]> {
  await ensureServiceMessagesTable();
  const rows = rowsToObjects(await turso(
    `SELECT id, service, reference, sender_role, sender_id, sender_name, content, read_at, created_at
     FROM service_messages
     WHERE service = ? AND reference = ?
     ORDER BY created_at ASC
     LIMIT 100`,
    [service, reference],
  ));

  return rows.map((r) => ({
    id: String(r.id || ""),
    service: r.service as ServiceMessageType,
    reference: String(r.reference || ""),
    senderRole: r.sender_role as ServiceSenderRole,
    senderId: String(r.sender_id || ""),
    senderName: String(r.sender_name || ""),
    content: String(r.content || ""),
    readAt: String(r.read_at || ""),
    createdAt: String(r.created_at || ""),
  }));
}

export async function sendServiceMessage(input: {
  service: ServiceMessageType;
  reference: string;
  participant: MessageParticipant;
  content: string;
}) {
  const { service, reference, participant } = input;
  const content = String(input.content || "").trim();

  if (!content || content.length > 500) {
    throw new CampusEngineError("VALIDATION_ERROR", "Message must be between 1 and 500 characters.", 400);
  }

  if (!participant.canSend) {
    throw new CampusEngineError("INVALID_STATE", "This conversation is closed and no longer accepting messages.", 409);
  }

  // Anti-spam rate limiting: 20 messages per minute per participant
  const limit = await rateLimitSubject("service_message", participant.actor.id, { limit: 20, windowMs: 60_000 });
  if (!limit.ok) {
    throw new CampusEngineError("RATE_LIMITED", "Too many messages sent. Please wait a moment.", 429);
  }

  await ensureServiceMessagesTable();
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();

  await turso(
    `INSERT INTO service_messages (id, service, reference, sender_role, sender_id, sender_name, content, read_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, '', ?)`,
    [id, service, reference, participant.actor.role, participant.actor.id, participant.actor.name, content, createdAt],
  );

  // 5-minute bucket coalesced notification outbox alert
  if (participant.counterpartEmail) {
    const bucket = Math.floor(Date.now() / 300_000);
    const notifRef = `msg:${service}:${reference}:${bucket}`;
    const template = service === "campus" ? "service_message_campus" : "service_message_print_copy";
    const preview = content.length > 80 ? `${content.slice(0, 77)}…` : content;
    const subject = service === "campus"
      ? (participant.actor.role === "DRIVER" ? `Message from driver ${participant.actor.name}` : `Message from rider ${participant.actor.name}`)
      : (participant.actor.role === "STAFF" ? `Update on Print & Copy quote ${reference}` : `Student message on quote ${reference}`);
    const message = `${participant.actor.name}: "${preview}"`;

    try {
      await queueNotification(turso, {
        recipient: participant.counterpartEmail,
        template,
        subject,
        message,
        reference: notifRef,
        nowIso: createdAt,
      });
    } catch {
      // Coalesced delivery queuing shouldn't fail message insertion
    }
  }

  return {
    id,
    service,
    reference,
    senderRole: participant.actor.role,
    senderId: participant.actor.id,
    senderName: participant.actor.name,
    content,
    readAt: "",
    createdAt,
  };
}

export async function markServiceMessagesRead(
  service: ServiceMessageType,
  reference: string,
  readerRole: ServiceSenderRole,
) {
  await ensureServiceMessagesTable();
  const nowIso = new Date().toISOString();
  const result = await turso(
    `UPDATE service_messages
     SET read_at = ?
     WHERE service = ? AND reference = ? AND sender_role != ? AND (read_at IS NULL OR read_at = '')`,
    [nowIso, service, reference, readerRole],
  );
  return Number(result?.affected_row_count || 0);
}
