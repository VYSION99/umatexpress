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
 * Usage: node scripts/write-deploy-config.mjs <in.json> <out.json> <name> <console-domain> <role> <console-hosts> [intelligence-worker] [client-domain] [client-aliases]
 *   role: single | client | console
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function deployConfig(input, { name, role = "single", consoleDomain = "", consoleHosts = "", intelligenceWorker = "", clientDomain = "", clientAliases = "" } = {}) {
  const serverDir = path.dirname(path.resolve(input));
  const projectDir = path.dirname(path.dirname(serverDir));
  const config = JSON.parse(fs.readFileSync(input, "utf8"));
  config.name = name;
  config.topLevelName = name;
  config.keep_vars = true;
  config.main = path.join(serverDir, "index.js");
  config.assets = { directory: path.join(projectDir, "dist/client"), binding: "ASSETS", run_worker_first: true };
  if (intelligenceWorker) {
    config.services = [
      ...(config.services ?? []).filter((item) => item.binding !== "INTELLIGENCE"),
      { binding: "INTELLIGENCE", service: intelligenceWorker },
    ];
  }

  // The runtime boundary: on any host in this list the Worker serves console
  // surfaces only, and console-native paths 404 everywhere else.
  const hosts = [...new Set([consoleDomain, ...consoleHosts.split(",")].filter(Boolean).map(host => String(host).replace(/^https?:\/\//, "").replace(/\/.*$/, "")))].join(",");
  if (hosts) {
    config.vars = { ...(config.vars ?? {}), CONSOLE_HOSTS: hosts };
  }

  const aliases = clientAliases.split(",").map(host => host.trim()).filter(Boolean);
  const activeDomain = role === "console" ? consoleDomain : clientDomain;
  if (activeDomain) {
    config.workers_dev = false;
    config.preview_urls = false;
    config.vars = { ...(config.vars ?? {}), CANONICAL_HOST: activeDomain.replace(/^https?:\/\//, "").replace(/\/.*$/, ""), HOST_ALIASES: role === "console" ? "" : aliases.join(",") };
  }

  if (role === "console") {
    delete config.triggers;
    if (config.queues) delete config.queues.consumers;
  }

  // A redeploy must never drop the console domain, so the route is written into
  // the generated config instead of being added once in the dashboard. Only the
  // console Worker (or the single-Worker deployment) carries it.
  const hostname = domain => String(domain).replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const routeHosts = [
    ...(clientDomain && role !== "console" ? [hostname(clientDomain), ...aliases.map(hostname)] : []),
    ...(consoleDomain && role !== "client" ? [hostname(consoleDomain)] : []),
  ];
  const routeHost = routeHosts.join(", ");
  if (routeHosts.length) {
    config.routes = [...new Set(routeHosts)].map(pattern => ({ pattern, custom_domain: true }));
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
  const [input, output, name, consoleDomain, role, consoleHosts, intelligenceWorker, clientDomain, clientAliases] = process.argv.slice(2);
  if (!input || !output || !name) {
    console.error("usage: write-deploy-config.mjs <in.json> <out.json> <name> <console-domain> <role> <console-hosts> [intelligence-worker] [client-domain] [client-aliases]");
    process.exit(2);
  }
  const { config, routeHost } = deployConfig(input, { name, role, consoleDomain, consoleHosts, intelligenceWorker, clientDomain, clientAliases });
  summary(name, config, routeHost);
  fs.writeFileSync(output, JSON.stringify(config, null, 2));
}
