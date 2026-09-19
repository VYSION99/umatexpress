/**
 * Writes the deployable Wrangler config from the build output.
 *
 * The build emits one config for one Worker. The UMaTeXPRESS deployment can be
 * two: the public client, and a console-only Worker on its own hostname, both
 * derived from that one config so they cannot drift.
 *
 * The console copy deliberately drops the cron triggers and the notification
 * queue consumer. Those belong to exactly one Worker: a second consumer would
 * send every message twice, and a second set of cron triggers would run every
 * settlement, expiry and reminder job twice.
 *
 * Usage: node scripts/write-deploy-config.mjs <in.json> <out.json> <name> <console-domain> <role> <console-hosts>
 *   role: single | client | console
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function deployConfig(input, { name, role = "single", consoleDomain = "", consoleHosts = "" } = {}) {
  const serverDir = path.dirname(input);
  const projectDir = path.dirname(path.dirname(serverDir));
  const config = JSON.parse(fs.readFileSync(input, "utf8"));
  config.name = name;
  config.topLevelName = name;
  config.main = path.join(serverDir, "index.js");
  config.assets = { directory: path.join(projectDir, "dist/client") };

  // The runtime boundary: on any host in this list the Worker serves console
  // surfaces only, and console-native paths 404 everywhere else.
  if (consoleHosts) {
    config.vars = { ...(config.vars ?? {}), CONSOLE_HOSTS: consoleHosts };
  }

  if (role === "console") {
    delete config.triggers;
    if (config.queues) delete config.queues.consumers;
  }

  // A redeploy must never drop the console domain, so the route is written into
  // the generated config instead of being added once in the dashboard. Only the
  // console Worker (or the single-Worker deployment) carries it.
  const routeHost = consoleDomain ? String(consoleDomain).replace(/^https?:\/\//, "").replace(/\/.*$/, "") : "";
  if (routeHost && role !== "client") {
    config.routes = [{ pattern: `${routeHost}/*`, custom_domain: true }];
  } else {
    delete config.routes;
  }

  return { config, routeHost };
}

function summary(name, config, routeHost) {
  const bindings = [
    config.ai?.binding ? `Workers AI=${config.ai.binding}` : "",
    config.images?.binding ? `Images=${config.images.binding}` : "",
    ...(config.r2_buckets ?? []).map((item) => `R2=${item.binding}:${item.bucket_name}`),
    ...(config.queues?.producers ?? []).map((item) => `Queue=${item.binding}:${item.queue}`),
    ...(config.queues?.consumers ?? []).map((item) => `Queue consumer=${item.queue}`),
    ...(config.durable_objects?.bindings ?? []).map((item) => `DurableObject=${item.name}:${item.class_name}`),
    ...(config.services ?? []).map((item) => `Service=${item.binding}:${item.service}`),
    ...(config.mtls_certificates ?? []).map((item) => `mTLS=${item.binding}:${item.certificate_id}`),
  ].filter(Boolean);
  console.log(`[${name}] bindings: ${bindings.length ? bindings.join(", ") : "none"}`);
  console.log(`[${name}] crons: ${(config.triggers?.crons ?? []).length}`);
  if (routeHost) console.log(`[${name}] custom domain: ${routeHost}`);
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) {
  const [input, output, name, consoleDomain, role, consoleHosts] = process.argv.slice(2);
  if (!input || !output || !name) {
    console.error("usage: write-deploy-config.mjs <in.json> <out.json> <name> <console-domain> <role> <console-hosts>");
    process.exit(2);
  }
  const { config, routeHost } = deployConfig(input, { name, role, consoleDomain, consoleHosts });
  summary(name, config, routeHost);
  fs.writeFileSync(output, JSON.stringify(config, null, 2));
}
