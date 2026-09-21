/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { NOTIFICATION_SWEEP_CRON, PAYOUT_RECONCILE_CRON, PAYOUT_RELEASE_CRON } from "@/lib/campus-engine/crons";
import { runCampusReconcile, runNotificationSweep } from "@/lib/campus-engine/reconcile-job";
import { runCinemaCleanup } from "@/lib/cinema-engine/cleanup";
import { consoleBoundaryResponse } from "@/lib/console-hosts";
import { dispatchPendingNotifications, type NotificationQueueMessage } from "@/lib/notifications";
import { logEvent } from "@/lib/observability";
import { runPayoutReconcileJob, runPayoutReleaseJob } from "@/lib/organizer-payouts";
import { runHostelPayoutReconcileJob, runHostelPayoutReleaseJob } from "@/lib/hostel-engine/payouts";
import { runHostelRefundReconcile } from "@/lib/hostel-engine/refunds";

// Durable Object classes must be exported from the Worker entry point. The
// binding and its migration live in build/cloudflare-binding-plan.ts.
export { RateLimiter } from "./rate-limiter";
export { CinemaRoom } from "./cinema-room";

interface Env {
  ASSETS?: { fetch(request: Request): Promise<Response> };
  IMAGES?: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
  CONSOLE_HOSTS?: string;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

interface QueueMessage<T> {
  body: T;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

interface MessageBatch<T> {
  queue: string;
  messages: QueueMessage<T>[];
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // `vinext start` is a Node server and calls this handler without an env at
    // all, and every binding is optional in any case, so an absent env must
    // degrade to "no bindings" rather than throw.
    const bindings = env ?? ({} as Env);

    // The console is a separate origin. When CONSOLE_HOSTS is configured the
    // console origin serves console surfaces only, and console-native paths are
    // never reachable from the public host. Unconfigured means no boundary,
    // which is what local development and preview deployments rely on.
    const boundary = consoleBoundaryResponse(request, bindings.CONSOLE_HOSTS ?? process.env.CONSOLE_HOSTS);
    if (boundary) return boundary;

    if (url.pathname === "/_vinext/image") {
      if (!bindings.ASSETS || !bindings.IMAGES) return new Response("Image optimization is unavailable locally.", { status: 404 });
      const assets = bindings.ASSETS;
      const images = bindings.IMAGES;
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => assets.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await images.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return withSecurityHeaders(request, await handler.fetch(request, bindings, ctx));
  },

  /**
   * One trigger, one job. Payment reconciliation and notification delivery both
   * spend subrequests against Turso, and sharing an invocation starved the
   * outbox. The notification sweep is the queue's retry net, not its
   * replacement. See lib/campus-engine/crons.ts.
   */
  async scheduled(controller: { cron?: string }, _env: Env, ctx: ExecutionContext): Promise<void> {
    if (controller?.cron === NOTIFICATION_SWEEP_CRON) {
      // Ten at a time: each row costs a claim, a send and a status write, and
      // one invocation has fifty subrequests to spend.
      ctx.waitUntil(runNotificationSweep({ limit: 10 }));
      return;
    }
    if (controller?.cron === PAYOUT_RELEASE_CRON) {
      // Four at a time: each candidate costs a recipient lookup, a claim, a
      // transfer and two writes, and one invocation has fifty subrequests.
      // The hostel release is opt-in (`HOSTEL_PAYOUT_AUTO_ENABLED`) and adds
      // at most two transfers, so a deployment with both products still fits.
      ctx.waitUntil(Promise.all([runPayoutReleaseJob(), runHostelPayoutReleaseJob({ limit: 2 })]));
      return;
    }
    if (controller?.cron === PAYOUT_RECONCILE_CRON) {
      // Refunds ride the same reconciliation trigger: a refund is money
      // moving, and an approved refund whose webhook never arrived is exactly
      // the kind of row this cron exists to notice.
      ctx.waitUntil(Promise.all([
        runPayoutReconcileJob(),
        runHostelPayoutReconcileJob({ limit: 4 }),
        runHostelRefundReconcile({ limit: 4 }),
      ]));
      return;
    }
    // Cinema cleanup rides the five-minute reconcile: bounded to four rooms
    // per run, so the payment sweep and the deletion job together stay inside
    // one invocation's subrequest budget. It never throws; a bad run is logged
    // and the next tick retries.
    ctx.waitUntil(Promise.all([runCampusReconcile(), runCinemaCleanup({ limit: 4 })]));
  },

  /**
   * Notification delivery.
   *
   * The queue carries only row ids, so this handler is a nudge to the outbox
   * dispatcher rather than a second delivery path. A batch that cannot be
   * dispatched is retried, and the five-minute cron sweep delivers anything the
   * queue gives up on, so a passenger never loses a message to a queue outage.
   */
  async queue(batch: MessageBatch<NotificationQueueMessage>): Promise<void> {
    const ids = batch.messages.map((message) => String(message.body?.id || "").trim()).filter(Boolean);
    if (!ids.length) {
      for (const message of batch.messages) message.ack();
      return;
    }
    try {
      const result = await dispatchPendingNotifications({ ids });
      for (const message of batch.messages) message.ack();
      logEvent("info", "notification_queue_consumed", {
        queued: ids.length,
        considered: result.considered,
        sent: result.sent,
        failed: result.failed,
        configured: result.configured,
      });
    } catch (error) {
      for (const message of batch.messages) message.retry();
      logEvent("warn", "notification_queue_retry", {
        queued: ids.length,
        reason: error instanceof Error ? error.message : "unknown",
      });
    }
  },
};

/**
 * Security headers every response carries.
 *
 * A Content-Security-Policy is deliberately absent: the student map runs
 * MapLibre with blob workers and the console ships Next's inline bootstrap, so
 * a policy that does not break them has to be written and tested against both
 * origins first. These five are the ones that are safe unconditionally.
 */
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(self), payment=(self)",
  "Cross-Origin-Opener-Policy": "same-origin",
};

/** 101/204/304 responses may not carry a body, so they are rebuilt without one. */
function bodyless(status: number) {
  return status === 101 || status === 204 || status === 304;
}

function withSecurityHeaders(request: Request, response: Response) {
  // A 101 carries the upgraded socket, not a body: rebuilding it here would
  // drop the `webSocket` property and turn every room connection into a
  // handshake that closes immediately.
  if (response.status === 101) return response;
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    // A route may set its own (stricter) value; the deployment default never
    // overwrites a decision made closer to the data.
    if (!headers.has(name)) headers.set(name, value);
  }
  if (new URL(request.url).protocol === "https:" && !headers.has("Strict-Transport-Security")) {
    headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  return new Response(bodyless(response.status) ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default worker;
