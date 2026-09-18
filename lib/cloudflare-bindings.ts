/**
 * Typed access to Cloudflare bindings.
 *
 * Every accessor is safe to call anywhere: outside workerd (unit tests, plain
 * Node) the runtime environment is absent and the accessor returns undefined,
 * so callers branch on "is the binding here" instead of crashing. Binding names
 * come from the same spec the build uses, so a deployment that renames a
 * binding still resolves it.
 */
import { BINDING_NAMES, BINDING_VARS, RESOURCE_DEFAULTS, RESOURCE_VARS, SERVICE_BINDINGS_VAR, MTLS_CERTIFICATES_VAR, bindingName, parseBindingPairs } from "@/lib/cloudflare-binding-spec";
import { envValue, runtimeEnv } from "@/lib/runtime-env";

export type AiBinding = {
  run(model: string, input: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
};

export type ImagesBinding = {
  input(stream: ReadableStream): {
    transform(options: Record<string, unknown>): {
      output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
    };
  };
};

export type QueueProducer = {
  send(message: unknown, options?: { contentType?: "json" | "text" | "bytes" | "v8"; delaySeconds?: number }): Promise<void>;
};

export type R2Bucket = {
  put(key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob, options?: Record<string, unknown>): Promise<unknown>;
  get(key: string, options?: Record<string, unknown>): Promise<unknown>;
  head(key: string): Promise<unknown>;
  delete(key: string | string[]): Promise<void>;
};

export type DurableObjectNamespace = {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
};

export type Fetcher = {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
};

/** Reads one raw binding by name. Absent bindings resolve to undefined. */
export async function binding<T>(name: string): Promise<T | undefined> {
  if (!name) return undefined;
  const env = await runtimeEnv();
  const value = env?.[name];
  return value === undefined || value === null ? undefined : (value as T);
}

async function resolveName(varName: string, fallback: string) {
  return bindingName(await envValue(varName), fallback);
}

export async function aiBinding() {
  return binding<AiBinding>(await resolveName(BINDING_VARS.ai, BINDING_NAMES.ai));
}

export async function imagesBinding() {
  return binding<ImagesBinding>(await resolveName(BINDING_VARS.images, BINDING_NAMES.images));
}

export async function privateBucket() {
  return binding<R2Bucket>(await resolveName(BINDING_VARS.privateBucket, BINDING_NAMES.privateBucket));
}

export async function notificationQueue() {
  return binding<QueueProducer>(await resolveName(BINDING_VARS.queue, BINDING_NAMES.queue));
}

export async function rateLimiterNamespace() {
  return binding<DurableObjectNamespace>(await resolveName(BINDING_VARS.rateLimiter, BINDING_NAMES.rateLimiter));
}

export async function serviceBinding(name: string) {
  return binding<Fetcher>(name);
}

/**
 * Resolves an mTLS certificate binding by name. Callers that need one always
 * fall back to the global fetch, so an unbound certificate degrades to a plain
 * request instead of a crash.
 */
export async function mtlsFetcher(bindingName: string) {
  return binding<Fetcher>(bindingName);
}

export type BindingKind = "ai" | "images" | "r2" | "queue" | "durable-object" | "service" | "mtls";

export type BindingReport = {
  kind: BindingKind;
  binding: string;
  present: boolean;
  resource: string;
  note: string;
};

/**
 * What this deployment actually has, for the console bindings screen and for
 * post-deploy verification. Reports only binding names and account-side
 * resource names, never credentials.
 */
export async function cloudflareBindingReports(): Promise<{ runtime: "workerd" | "node"; bindings: BindingReport[] }> {
  const env = await runtimeEnv();
  const entries: Array<{ kind: BindingKind; binding: string; resource: string; note: string }> = [
    {
      kind: "ai",
      binding: await resolveName(BINDING_VARS.ai, BINDING_NAMES.ai),
      resource: "",
      note: "Workers AI runs without an API token when this binding is present.",
    },
    {
      kind: "images",
      binding: await resolveName(BINDING_VARS.images, BINDING_NAMES.images),
      resource: "",
      note: "Serves /_vinext/image. Without it the optimizer returns 404 and images are served as-is.",
    },
    {
      kind: "r2",
      binding: await resolveName(BINDING_VARS.privateBucket, BINDING_NAMES.privateBucket),
      // The build writes the resource name into `vars`; a runtime that predates
      // that falls back to the default rather than reporting nothing.
      resource: (await envValue(RESOURCE_VARS.privateBucket)) || RESOURCE_DEFAULTS.privateBucket,
      note: "Private object storage. Nothing public is served from this bucket.",
    },
    {
      kind: "queue",
      binding: await resolveName(BINDING_VARS.queue, BINDING_NAMES.queue),
      resource: (await envValue(RESOURCE_VARS.notificationQueue)) || RESOURCE_DEFAULTS.notificationQueue,
      note: "Wakes the notification outbox immediately; the cron stays as the retry sweep.",
    },
    {
      kind: "durable-object",
      binding: await resolveName(BINDING_VARS.rateLimiter, BINDING_NAMES.rateLimiter),
      resource: "",
      note: "Per-subject rate limiter. Without it limits fall back to Turso, then to memory.",
    },
  ];

  for (const { binding: name, value } of parseBindingPairs(await envValue(SERVICE_BINDINGS_VAR))) {
    entries.push({ kind: "service", binding: name, resource: value, note: "Worker-to-Worker service binding." });
  }
  for (const { binding: name, value } of parseBindingPairs(await envValue(MTLS_CERTIFICATES_VAR))) {
    entries.push({ kind: "mtls", binding: name, resource: value, note: "Outbound requests through this binding carry the client certificate." });
  }

  const bindings = await Promise.all(entries.map(async (entry) => ({
    ...entry,
    present: Boolean(await binding(entry.binding)),
  })));

  return { runtime: env ? "workerd" : "node", bindings };
}
