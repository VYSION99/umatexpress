type RuntimeEnv = Record<string, unknown>;

let cachedCloudflareEnv: RuntimeEnv | null | undefined;

async function cloudflareEnv() {
  if (cachedCloudflareEnv !== undefined) return cachedCloudflareEnv;
  try {
    const importer = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;
    const mod = await importer("cloudflare:workers");
    cachedCloudflareEnv = (mod as { env?: RuntimeEnv }).env || null;
  } catch {
    cachedCloudflareEnv = null;
  }
  return cachedCloudflareEnv;
}

export async function envValue(name: string, aliases: string[] = []) {
  const keys = [name, ...aliases];
  const cfEnv = await cloudflareEnv();
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
