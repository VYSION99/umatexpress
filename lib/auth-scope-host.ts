import { CampusEngineError } from "./campus-engine/errors";
import { isLoopbackHost, parseConsoleHosts } from "./console-hosts";
import { envValue } from "./runtime-env";

/** Recovery codes and console sessions must stay on their own origin. */
export async function assertAuthScopeHost(request: Request, scope: "STUDENT" | "CONSOLE") {
  const hosts = parseConsoleHosts(await envValue("CONSOLE_HOSTS"));
  if (!hosts.length) return;
  const host = new URL(request.url).host.toLowerCase();
  if (isLoopbackHost(host)) return;
  const onConsole = hosts.includes(host);
  if (scope === "CONSOLE" && !onConsole) throw new CampusEngineError("FORBIDDEN", "Use the console sign-in page for this account.", 403);
  if (scope === "STUDENT" && onConsole) throw new CampusEngineError("FORBIDDEN", "Use the student account page for this account.", 403);
}
