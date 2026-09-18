import vinext from "vinext";
import { defineConfig, loadEnv } from "vite";
import hostingConfig from "./.openai/hosting.json";
import { bindingPlan, bindingPlanSummary, wranglerBindingConfig } from "./build/cloudflare-binding-plan";
import { sites } from "./build/sites-vite-plugin";
import { WORKER_CRONS } from "./lib/campus-engine/crons";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const { d1, r2 } = hostingConfig as { d1?: string; r2?: string };

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

export default defineConfig(async ({ mode }) => {
  const localEnv = loadEnv(mode, process.cwd(), "");

  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";
  // Assigning an undefined value to process.env stores the *string* "undefined",
  // which is truthy and silently defeats every `|| fallback` downstream.
  if (localEnv.NEXT_PUBLIC_MAP_STYLE_URL) process.env.NEXT_PUBLIC_MAP_STYLE_URL = localEnv.NEXT_PUBLIC_MAP_STYLE_URL;

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  // Every Cloudflare binding is described in one place. The plan is generated
  // from the environment so a deployment can rename or drop a binding without
  // touching this file, and the effective names are written back into `vars` so
  // the Worker resolves exactly what was built.
  const plan = bindingPlan(localEnv);
  const bindings = wranglerBindingConfig(plan);
  for (const line of bindingPlanSummary(plan)) console.log(`[bindings] ${line}`);

  const localBindingConfig = {
    main: "./worker/index.ts",
    compatibility_flags: ["nodejs_compat"],
    // One trigger per job: see lib/campus-engine/crons.ts for why.
    triggers: { crons: WORKER_CRONS },
    ...bindings,
    // A bucket declared by the hosting template is additive: it never replaces
    // the application's own R2 binding.
    r2_buckets: [
      ...bindings.r2_buckets,
      ...(r2 ? [{ binding: r2, bucket_name: "site-creator-r2" }] : []),
    ],
    d1_databases: d1
      ? [
          {
            binding: d1,
            database_name: "site-creator-d1",
            database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
          },
        ]
      : [],
  };

  return {
    server: {
      host: "0.0.0.0",
      allowedHosts: ["terminal.local"],
      ...(isCodexSeatbeltSandbox
        ? { watch: { useFsEvents: false, usePolling: true } }
        : {}),
    },
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        inspectorPort: false,
        config: localBindingConfig,
      }),
    ],
  };
});
