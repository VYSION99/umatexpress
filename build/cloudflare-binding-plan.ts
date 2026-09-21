/**
 * Turns the deployment environment into the Cloudflare binding block that
 * Wrangler, Miniflare and the deploy script all read.
 *
 * The plan is pure so the rules can be unit-tested, and it is the only place
 * that decides which bindings exist. Every binding is optional: an empty value
 * removes it from the generated config instead of leaving a reference that
 * would fail at deploy time. The effective binding names are written back into
 * `vars`, so the Worker resolves exactly what was deployed.
 */
import {
  BINDING_NAMES,
  BINDING_VARS,
  MTLS_CERTIFICATES_VAR,
  RESOURCE_DEFAULTS,
  RESOURCE_VARS,
  SERVICE_BINDINGS_VAR,
  SUBREQUEST_LIMIT_VAR,
  DEFAULT_SUBREQUEST_LIMIT,
  bindingName,
  parseBindingPairs,
  resourceName,
} from "../lib/cloudflare-binding-spec";

export { MTLS_CERTIFICATES_VAR, SERVICE_BINDINGS_VAR };

export type BindingPlan = {
  ai: string;
  images: string;
  privateBucketBinding: string;
  privateBucket: string;
  queueBinding: string;
  queue: string;
  deadLetterQueue: string;
  rateLimiterBinding: string;
  cinemaRoomBinding: string;
  subrequestLimit: number;
  services: Array<{ binding: string; service: string }>;
  mtlsCertificates: Array<{ binding: string; certificate_id: string }>;
  vars: Record<string, string>;
};

export function bindingPlan(env: Record<string, unknown>): BindingPlan {
  const ai = bindingName(env[BINDING_VARS.ai], BINDING_NAMES.ai);
  const images = bindingName(env[BINDING_VARS.images], BINDING_NAMES.images);
  const privateBucketBinding = bindingName(env[BINDING_VARS.privateBucket], BINDING_NAMES.privateBucket);
  const privateBucket = privateBucketBinding ? resourceName(env[RESOURCE_VARS.privateBucket], RESOURCE_DEFAULTS.privateBucket) : "";
  const queueBinding = bindingName(env[BINDING_VARS.queue], BINDING_NAMES.queue);
  const queue = queueBinding ? resourceName(env[RESOURCE_VARS.notificationQueue], RESOURCE_DEFAULTS.notificationQueue) : "";
  const rateLimiterBinding = bindingName(env[BINDING_VARS.rateLimiter], BINDING_NAMES.rateLimiter);
  const cinemaRoomBinding = bindingName(env[BINDING_VARS.cinemaRoom], BINDING_NAMES.cinemaRoom);
  const subrequestLimit = (() => {
    const raw = env[SUBREQUEST_LIMIT_VAR];
    if (raw === undefined || raw === null) return DEFAULT_SUBREQUEST_LIMIT;
    const trimmed = String(raw).trim();
    if (!trimmed) return 0;
    const value = Math.round(Number(trimmed));
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_SUBREQUEST_LIMIT;
  })();

  const services = parseBindingPairs(env[SERVICE_BINDINGS_VAR])
    .map(({ binding, value }) => ({ binding, service: value }));
  const mtlsCertificates = parseBindingPairs(env[MTLS_CERTIFICATES_VAR])
    .map(({ binding, value }) => ({ binding, certificate_id: value }));

  return {
    ai,
    images,
    privateBucketBinding,
    privateBucket,
    queueBinding,
    queue,
    deadLetterQueue: queue ? `${queue}-dlq` : "",
    rateLimiterBinding,
    cinemaRoomBinding,
    subrequestLimit,
    services,
    mtlsCertificates,
    vars: {
      [BINDING_VARS.ai]: ai,
      [BINDING_VARS.images]: images,
      [BINDING_VARS.privateBucket]: privateBucketBinding,
      [BINDING_VARS.queue]: queueBinding,
      [BINDING_VARS.rateLimiter]: rateLimiterBinding,
      [BINDING_VARS.cinemaRoom]: cinemaRoomBinding,
      [RESOURCE_VARS.privateBucket]: privateBucket,
      [RESOURCE_VARS.notificationQueue]: queue,
      [SUBREQUEST_LIMIT_VAR]: subrequestLimit ? String(subrequestLimit) : "",
      [MTLS_CERTIFICATES_VAR]: mtlsCertificates.map((item) => `${item.binding}=${item.certificate_id}`).join(","),
      [SERVICE_BINDINGS_VAR]: services.map((item) => `${item.binding}=${item.service}`).join(","),
    },
  };
}

export type WranglerBindingConfig = {
  vars: Record<string, string>;
  ai?: { binding: string };
  images?: { binding: string };
  r2_buckets: Array<{ binding: string; bucket_name: string }>;
  queues: {
    producers: Array<{ binding: string; queue: string }>;
    consumers: Array<{ queue: string; max_batch_size: number; max_batch_timeout: number; max_retries: number; dead_letter_queue: string }>;
  };
  durable_objects: { bindings: Array<{ name: string; class_name: string }> };
  migrations: Array<{ tag: string; new_sqlite_classes: string[] }>;
  limits: { subrequests: number } | Record<string, never>;
  services: Array<{ binding: string; service: string }>;
  mtls_certificates: Array<{ binding: string; certificate_id: string }>;
};

/** The wrangler.json shape for one plan. Empty arrays are always emitted. */
export function wranglerBindingConfig(plan: BindingPlan): WranglerBindingConfig {
  return {
    vars: plan.vars,
    ...(plan.ai ? { ai: { binding: plan.ai } } : {}),
    ...(plan.images ? { images: { binding: plan.images } } : {}),
    r2_buckets: plan.privateBucket ? [{ binding: plan.privateBucketBinding, bucket_name: plan.privateBucket }] : [],
    queues: plan.queue
      ? {
          producers: [{ binding: plan.queueBinding, queue: plan.queue }],
          consumers: [
            {
              queue: plan.queue,
              // Ten messages is about thirty Turso statements once each row is
              // claimed and marked, which stays inside the free plan's
              // fifty-subrequest budget for a single consumer invocation.
              max_batch_size: 10,
              max_batch_timeout: 5,
              max_retries: 5,
              dead_letter_queue: plan.deadLetterQueue,
            },
          ],
        }
      : { producers: [], consumers: [] },
    durable_objects: {
      bindings: [
        ...(plan.rateLimiterBinding ? [{ name: plan.rateLimiterBinding, class_name: "RateLimiter" }] : []),
        ...(plan.cinemaRoomBinding ? [{ name: plan.cinemaRoomBinding, class_name: "CinemaRoom" }] : []),
      ],
    },
    // Tags are append-only: v1 already ran on deployments that use the rate
    // limiter, so Cinema's class is introduced by v2 and never renumbered.
    migrations: [
      ...(plan.rateLimiterBinding ? [{ tag: "v1", new_sqlite_classes: ["RateLimiter"] }] : []),
      ...(plan.cinemaRoomBinding ? [{ tag: "v2", new_sqlite_classes: ["CinemaRoom"] }] : []),
    ],
    limits: plan.subrequestLimit ? { subrequests: plan.subrequestLimit } : {},
    services: plan.services,
    mtls_certificates: plan.mtlsCertificates,
  };
}

/** One line per binding for build and deploy logs. Never prints a secret. */
export function bindingPlanSummary(plan: BindingPlan) {
  const lines = [
    plan.ai ? `Workers AI -> ${plan.ai}` : "Workers AI -> disabled",
    plan.images ? `Images -> ${plan.images}` : "Images -> disabled",
    plan.privateBucket ? `R2 -> ${plan.privateBucketBinding} (${plan.privateBucket})` : "R2 -> disabled",
    plan.queue ? `Queue -> ${plan.queueBinding} (${plan.queue}, dlq ${plan.deadLetterQueue})` : "Queue -> disabled",
    plan.rateLimiterBinding ? `Durable Object -> ${plan.rateLimiterBinding} (RateLimiter)` : "Durable Object -> disabled",
    plan.cinemaRoomBinding ? `Durable Object -> ${plan.cinemaRoomBinding} (CinemaRoom)` : "Cinema room Durable Object -> disabled",
    plan.subrequestLimit ? `Subrequest limit -> ${plan.subrequestLimit}` : "Subrequest limit -> plan default",
    plan.services.length ? `Service bindings -> ${plan.services.map((item) => `${item.binding}=${item.service}`).join(", ")}` : "Service bindings -> none",
    plan.mtlsCertificates.length
      ? `mTLS certificates -> ${plan.mtlsCertificates.map((item) => `${item.binding}=${item.certificate_id}`).join(", ")}`
      : "mTLS certificates -> none",
  ];
  return lines;
}
