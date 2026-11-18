import { assertSameOrigin, fail, ok } from "@/lib/campus-engine/responses";
import { CampusEngineError } from "@/lib/campus-engine/errors";
import {
  listServiceMessages,
  markServiceMessagesRead,
  resolveServiceParticipant,
  sendServiceMessage,
  type ServiceMessageType,
} from "@/lib/service-messages";

/**
 * Transaction-scoped messaging API for CampusRide and Print & Copy.
 *
 * GET: Fetches thread messages, resolves participant info & quick chips,
 *      and marks counterpart messages as read.
 * POST: Sends a message within an active transaction and queues a coalesced alert.
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const service = searchParams.get("service") as ServiceMessageType | null;
    const reference = searchParams.get("reference") || "";

    if (!service || !["campus", "print-copy"].includes(service)) {
      throw new CampusEngineError("VALIDATION_ERROR", "A valid service type is required ('campus' or 'print-copy').", 400);
    }
    if (!reference) {
      throw new CampusEngineError("VALIDATION_ERROR", "A transaction reference is required.", 400);
    }

    const participant = await resolveServiceParticipant(request, service, reference);
    const messages = await listServiceMessages(service, reference);

    // Auto-mark counterpart messages as read for the active viewer
    await markServiceMessagesRead(service, reference, participant.actor.role);

    return ok(
      {
        messages,
        participant: {
          role: participant.actor.role,
          name: participant.actor.name,
          counterpartName: participant.counterpartName,
          status: participant.status,
          canSend: participant.canSend,
        },
        chips: participant.chips,
      },
      { headers: { "Cache-Control": "no-store" } },
      request,
    );
  } catch (error) {
    return fail(error, request);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const body = (await request.json().catch(() => ({}))) as {
      service?: ServiceMessageType;
      reference?: string;
      content?: string;
    };

    const service = body.service;
    const reference = String(body.reference || "").trim();
    const content = String(body.content || "").trim();

    if (!service || !["campus", "print-copy"].includes(service)) {
      throw new CampusEngineError("VALIDATION_ERROR", "A valid service type is required ('campus' or 'print-copy').", 400);
    }
    if (!reference) {
      throw new CampusEngineError("VALIDATION_ERROR", "A transaction reference is required.", 400);
    }
    if (!content) {
      throw new CampusEngineError("VALIDATION_ERROR", "Message content cannot be empty.", 400);
    }

    const participant = await resolveServiceParticipant(request, service, reference);
    const message = await sendServiceMessage({ service, reference, participant, content });

    return ok({ message }, { headers: { "Cache-Control": "no-store" } }, request);
  } catch (error) {
    return fail(error, request);
  }
}
