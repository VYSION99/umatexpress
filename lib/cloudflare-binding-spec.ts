/**
 * The single description of every Cloudflare binding this project can use.
 *
 * The Vite config, the deploy script, the Worker entry and the bindings report
 * all read these names, so a binding can never be declared under one name and
 * looked up under another. This module is deliberately dependency-free: it runs
 * in the build tool, in workerd and in plain Node tests.
 */

/** Default binding names. A deployment may rename them through the *_BINDING vars. */
export const BINDING_NAMES = {
  ai: "AI",
  images: "IMAGES",
  privateBucket: "PRIVATE_BUCKET",
  queue: "NOTIFICATION_QUEUE",
  rateLimiter: "RATE_LIMITER",
} as const;

/**
 * Binding names are configurable, so the Worker learns the effective names from
 * `vars` that the build writes back into the deployed config. An unset value
 * means "use the default"; an empty value means "this binding is disabled".
 */
export const BINDING_VARS = {
  ai: "CLOUDFLARE_AI_BINDING",
  images: "CLOUDFLARE_IMAGES_BINDING",
  privateBucket: "CLOUDFLARE_R2_BINDING",
  queue: "CLOUDFLARE_QUEUE_BINDING",
  rateLimiter: "CLOUDFLARE_RATE_LIMITER_BINDING",
} as const;

/** Account-side resource names, used when the deployment has not picked one. */
export const RESOURCE_DEFAULTS = {
  privateBucket: "umatexpress-private",
  notificationQueue: "umatexpress-notifications",
} as const;

export const RESOURCE_VARS = {
  privateBucket: "CLOUDFLARE_R2_BUCKET",
  notificationQueue: "CLOUDFLARE_QUEUE",
} as const;

/** `BINDING=value` lists for bindings that point at another Cloudflare object. */
export const SERVICE_BINDINGS_VAR = "CLOUDFLARE_SERVICE_BINDINGS";
export const MTLS_CERTIFICATES_VAR = "CLOUDFLARE_MTLS_CERTIFICATES";

/** Name of the mTLS certificate binding the MTN MoMo client uses. */
export const MOMO_MTLS_BINDING = "MTN_MOMO_CERT";

/**
 * Resolves one configurable binding name: unset keeps the default, an empty
 * string disables the binding, anything else is used verbatim.
 */
export function bindingName(value: unknown, fallback: string) {
  if (value === undefined || value === null) return fallback;
  return String(value).trim();
}

/** Resolves an account-side resource name, keeping the default when unset. */
export function resourceName(value: unknown, fallback: string) {
  if (value === undefined || value === null) return fallback;
  const trimmed = String(value).trim();
  return trimmed;
}

const BINDING_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

export function isBindingName(value: string) {
  return BINDING_NAME_PATTERN.test(value);
}

/**
 * Parses `BINDING=value,BINDING2=value2` lists used for service bindings and
 * mTLS certificates. Malformed entries are dropped rather than silently
 * producing a half-configured deployment.
 */
export function parseBindingPairs(value: unknown): Array<{ binding: string; value: string }> {
  const pairs: Array<{ binding: string; value: string }> = [];
  const seen = new Set<string>();
  for (const entry of String(value ?? "").split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    const binding = trimmed.slice(0, separator).trim();
    const target = trimmed.slice(separator + 1).trim();
    if (!binding || !target || !isBindingName(binding) || seen.has(binding)) continue;
    seen.add(binding);
    pairs.push({ binding, value: target });
  }
  return pairs;
}
