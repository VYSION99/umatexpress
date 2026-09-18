type RuntimeEnv = Record<string, unknown>;

let cachedCloudflareEnv: RuntimeEnv | null | undefined;

/**
 * The Cloudflare bindings and vars for the current isolate, or null when the
 * code is not running inside workerd (unit tests, plain Node builds).
 */
export async function runtimeEnv(): Promise<RuntimeEnv | null> {
  if (cachedCloudflareEnv !== undefined) return cachedCloudflareEnv;
  try {
    cachedCloudflareEnv = readEnv(await import(/* @vite-ignore */ "cloudflare:workers"));
    return cachedCloudflareEnv;
  } catch {
    // Bundlers that reject the bare specifier fall back to an import the
    // bundler cannot see, which still resolves inside workerd.
  }
  try {
    const importer = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;
    const mod = await importer("cloudflare:workers");
    cachedCloudflareEnv = readEnv(mod);
  } catch {
    cachedCloudflareEnv = null;
  }
  return cachedCloudflareEnv;
}

function readEnv(mod: unknown): RuntimeEnv | null {
  return (mod as { env?: RuntimeEnv }).env || null;
}

export async function envValue(name: string, aliases: string[] = []) {
  const keys = [name, ...aliases];
  const cfEnv = await runtimeEnv();
  for (const key of keys) {
    const value = cfEnv?.[key] ?? process.env[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim().replace(/^["']|["']$/g, "");
    }
  }
  return "";
}

export async function envList(name: string) {
  return (await envValue(name)).toLowerCase().split(",").map((item) => item.trim()).filter(Boolean);
}
