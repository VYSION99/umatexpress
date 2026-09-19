import assert from "node:assert/strict";
import test, { after } from "node:test";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import {
  consoleApplicationById,
  consoleApplications,
  consoleInvitedAccess,
  implementedConsoleApplicationIds,
  openConsoleApplications,
} from "../lib/console-applications.ts";
import { consoleServices } from "../components/admin/console-services.ts";

// The console is one account for every service, but not one door for every
// role. This test pins the rules that keep the door from being a way to promote
// yourself: only services declare public applications, and a role with
// operational power is always set up by the team that runs it.

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true } });
after(async () => vite.close());
const { CONSOLE_ROLES } = await vite.ssrLoadModule("/lib/console-auth.ts");

test("every application programme is complete", () => {
  const ids = consoleApplications.map((application) => application.id);
  assert.equal(new Set(ids).size, ids.length, "an application id is used twice");
  for (const application of consoleApplications) {
    assert.match(application.id, /^[a-z]+$/);
    assert.ok(application.title.trim() && application.short.trim() && application.blurb.trim(), `${application.id} is missing display copy`);
    assert.ok(application.detail.trim() && application.applyLabel.trim(), `${application.id} is missing what the form promises`);
    assert.match(application.endpoint, /^\/api\/console\//, `${application.id} must post to a console endpoint`);
    assert.ok(consoleServices.some((service) => service.id === application.reviewService), `${application.id} is reviewed by an unknown service: ${application.reviewService}`);
    assert.ok(application.activation === "REVIEW" || application.activation === "DIRECT", `${application.id} has an unknown activation policy`);
    if (application.status === "COMING_SOON") {
      assert.equal(application.role, null, `${application.id} is not built yet, so it cannot mint a role`);
    }
    const keys = application.fields.map((field) => field.key);
    assert.equal(new Set(keys).size, keys.length, `${application.id} has a duplicate field`);
  }
});

test("an open application collects enough to create the account it promises", () => {
  const open = openConsoleApplications();
  assert.ok(open.length, "at least one service must be open for applications");
  for (const application of open) {
    assert.ok(CONSOLE_ROLES.includes(application.role), `${application.id} opens an unknown role: ${application.role}`);
    const fields = new Map(application.fields.map((field) => [field.key, field]));
    assert.ok(fields.get("email")?.required, `${application.id} must ask for an email address`);
    assert.ok(fields.get("password")?.required, `${application.id} must let the applicant choose a password`);
  }
});

test("a programme is only open when the server can process it", () => {
  for (const id of implementedConsoleApplicationIds) {
    assert.ok(consoleApplicationById(id), `the server implements an undeclared programme: ${id}`);
  }
  for (const application of openConsoleApplications()) {
    assert.ok(implementedConsoleApplicationIds.includes(application.id), `${application.id} is open but has no server handler`);
  }
});

test("every console role has a declared way in", () => {
  const ways = new Set([
    ...consoleApplications.map((application) => application.role).filter(Boolean),
    ...consoleInvitedAccess.flatMap((entry) => entry.roles),
  ]);
  for (const role of CONSOLE_ROLES) assert.ok(ways.has(role), `${role} has no declared way into the console`);
});

test("an operational role is never self-service", () => {
  const invited = new Set(consoleInvitedAccess.flatMap((entry) => entry.roles));
  assert.ok(invited.has("DRIVER") && invited.has("MODERATOR") && invited.has("ADMIN"), "drivers and staff are set up by the team, not by the form");
  for (const application of openConsoleApplications()) {
    assert.ok(!invited.has(application.role), `${application.id} would hand out an operational role through a public form`);
  }
  for (const entry of consoleInvitedAccess) {
    for (const role of entry.roles) assert.ok(CONSOLE_ROLES.includes(role), `${entry.id} lists an unknown role: ${role}`);
    assert.ok(entry.title.trim() && entry.detail.trim() && entry.contact.trim(), `${entry.id} is missing copy`);
  }
});

test("the page every open application is filled in on exists", async () => {
  await access(new URL("../app/console/register/[programme]/page.tsx", import.meta.url));
  await access(new URL("../app/api/console/applications/[programme]/route.ts", import.meta.url));
});
