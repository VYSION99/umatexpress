import { waitForHostelMessages } from "@/lib/hostel-engine/messages";

/**
 * One hostel thread as a server-sent event stream.
 *
 * A connection is bounded — a handful of ten-second waits, then it closes and
 * the browser's EventSource reconnects on its own. That keeps every Worker
 * invocation short and every reconnect cheap, while a reply still appears
 * within a couple of seconds instead of waiting for the next page refresh.
 * The client is told only that the thread changed; it re-reads through the
 * ordinary thread endpoint, which is also what marks the message read.
 */
const ROUNDS = 6;
const ROUND_MS = 10_000;
const POLL_MS = 2_000;

export function hostelMessageStream(input: { bookingId: string; viewer: "STUDENT" | "HOST"; after?: string }) {
  const encoder = new TextEncoder();
  let cancelled = false;
  let after = String(input.after || "");

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: Record<string, unknown>) => {
        if (!cancelled) controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };
      // The browser waits two seconds before reconnecting, so a settled thread
      // costs two connections a minute rather than a busy loop.
      controller.enqueue(encoder.encode("retry: 2000\n\n"));
      try {
        for (let round = 0; round < ROUNDS && !cancelled; round += 1) {
          const result = await waitForHostelMessages(input.bookingId, { after, waitMs: ROUND_MS, pollMs: POLL_MS });
          if (cancelled) break;
          if (result.latestId) after = result.latestId;
          if (result.changed) send({ changed: true, latestId: result.latestId });
        }
      } catch {
        // A stream that cannot read the thread just ends; the client falls
        // back to its next reconnect and the page keeps working.
      } finally {
        if (!cancelled) {
          try {
            controller.close();
          } catch {
            // The client may have closed first; that is not an error.
          }
        }
      }
    },
    cancel() {
      cancelled = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
