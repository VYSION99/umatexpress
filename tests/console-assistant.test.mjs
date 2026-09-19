import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import {
  consoleAssistantToolByName,
  consoleAssistantTools,
  consoleAssistantToolsForRole,
} from "../lib/console-assistant-catalog.ts";

// The console assistant is the one place a model can reach console data and
// propose console changes, so the rules are pinned here: the catalogue decides
// what exists per role, and a proposal is only executable by the role that
// could perform it by hand.

const CONSOLE_ROLES = ["ADMIN", "MODERATOR", "ORGANIZER", "DRIVER"];

process.env.CONSOLE_SESSION_SECRET = "test-console-assistant-secret-32-chars-long";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true } });
after(async () => vite.close());
const { signAssistantAction, verifyAssistantAction, executeConsoleAssistantAction, describeAssistantAction, consoleAssistantReply, consoleBriefFor } = await vite.ssrLoadModule("/lib/console-assistant.ts");

const adminAccount = { id: "admin_acct", email: "admin@umatexpress.example", name: "Admin", phone: "", role: "ADMIN", status: "ACTIVE", profileId: "" };
const organizerAccount = { id: "org_acct", email: "organiser@example.com", name: "Organiser", phone: "", role: "ORGANIZER", status: "ACTIVE", profileId: "org_1" };
const moderatorAccount = { id: "mod_acct", email: "moderator@umatexpress.example", name: "Moderator", phone: "", role: "MODERATOR", status: "ACTIVE", profileId: "" };
const driverAccount = { id: "drv_acct", email: "driver@umatexpress.example", name: "Driver", phone: "", role: "DRIVER", status: "ACTIVE", profileId: "drv_1" };
const request = new Request("https://console.example/api/console/assistant");

test("every tool is well formed", () => {
  const names = consoleAssistantTools.map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length, "a tool name is used twice");
  for (const tool of consoleAssistantTools) {
    assert.match(tool.name, /^[a-z][a-z0-9_]*$/, `${tool.name} must be a model-safe function name`);
    assert.ok(tool.title.trim() && tool.description.trim().length > 30, `${tool.name} must describe itself fully`);
    assert.ok(tool.kind === "read" || tool.kind === "action", `${tool.name} has an unknown kind`);
    assert.ok(tool.roles.length, `${tool.name} is offered to nobody`);
    for (const role of tool.roles) assert.ok(CONSOLE_ROLES.includes(role), `${tool.name} names an unknown role: ${role}`);
    const keys = tool.parameters.map((parameter) => parameter.key);
    assert.equal(new Set(keys).size, keys.length, `${tool.name} has a duplicate parameter`);
    for (const parameter of tool.parameters) {
      assert.ok(parameter.description.trim(), `${tool.name}.${parameter.key} is undocumented`);
      if (parameter.enum) assert.ok(parameter.enum.length && parameter.enum.every((value) => value === value.toUpperCase()), `${tool.name}.${parameter.key} has a loose enum`);
      if (parameter.required) assert.ok(parameter.label.trim(), `${tool.name}.${parameter.key} needs a label for the confirmation card`);
    }
  }
});

test("a role only holds the tools it could use by hand", () => {
  for (const role of CONSOLE_ROLES) {
    const tools = consoleAssistantToolsForRole(role);
    assert.ok(tools.some((tool) => tool.name === "console_guide"), `${role} must always be able to ask where things are`);
    for (const tool of tools) assert.ok(tool.roles.includes(role));
  }
  assert.equal(consoleAssistantToolsForRole("SOMETHING").length, 0, "an unknown role gets nothing");
  // An administrator holds every platform tool; the ones that are personal to
  // another role (a driver's shift, an organizer's own trips and notice) stay
  // personal even for staff.
  const personal = ["driver_shift", "driver_queue", "my_trips", "my_notice", "my_earnings", "notice_update"];
  const admin = consoleAssistantToolsForRole("ADMIN").map((tool) => tool.name);
  for (const tool of consoleAssistantTools.filter((entry) => !personal.includes(entry.name))) {
    assert.ok(admin.includes(tool.name), `an administrator must hold ${tool.name}`);
  }

  const driver = consoleAssistantToolsForRole("DRIVER").map((tool) => tool.name).sort();
  assert.deepEqual(driver, ["console_guide", "daily_brief", "driver_queue", "driver_shift"], "a driver only reaches their own shift");
  const organizer = consoleAssistantToolsForRole("ORGANIZER");
  assert.deepEqual(organizer.filter((tool) => tool.kind === "action").map((tool) => tool.name), ["notice_update"], "an organizer's only action is their own notice");
  const moderator = consoleAssistantToolsForRole("MODERATOR").map((tool) => tool.name);
  assert.ok(!moderator.includes("payouts_balances") && !moderator.includes("campus_overview"), "a moderator has no money or campus operations tools");
  for (const tool of consoleAssistantTools.filter((entry) => entry.kind === "action")) {
    assert.ok(tool.parameters.length, `${tool.name} must declare what it acts on`);
    for (const parameter of tool.parameters.filter((entry) => entry.key.endsWith("Id"))) {
      assert.ok(parameter.required, `${tool.name}.${parameter.key} must be required, never guessed`);
    }
  }
});

test("a proposal is signed, personal and tamper-evident", async () => {
  const token = await signAssistantAction({ name: "organizers_review", args: { organizerId: "org_1", action: "APPROVE" }, accountId: "acct_1" });
  const payload = await verifyAssistantAction(token, "acct_1");
  assert.equal(payload?.name, "organizers_review");
  assert.deepEqual(payload?.args, { organizerId: "org_1", action: "APPROVE" });
  assert.equal(await verifyAssistantAction(token, "acct_2"), null, "a token must not work for another account");
  assert.equal(await verifyAssistantAction(`${token}x`, "acct_1"), null, "a tampered token must not verify");
  assert.equal(await verifyAssistantAction("not-a-token", "acct_1"), null);
});

test("a proposal cannot be executed by a role that does not hold the tool", async () => {
  const token = await signAssistantAction({ name: "organizers_review", args: { organizerId: "org_1", action: "APPROVE" }, accountId: "driver_acct" });
  await assert.rejects(
    () => executeConsoleAssistantAction({
      request: new Request("https://console.example/api/console/assistant/confirm"),
      account: { id: "driver_acct", email: "driver@example.com", name: "Driver", phone: "", role: "DRIVER", status: "ACTIVE", profileId: "drv_1" },
      token,
    }),
    /cannot perform this action/,
  );
});

test("the confirmation card names what will happen", () => {
  const tool = consoleAssistantToolByName("trips_review");
  const summary = describeAssistantAction(tool, { tripId: "trip_9", action: "APPROVE" });
  assert.match(summary, /Trip id: trip_9/);
  assert.match(summary, /Decision: APPROVE/);
  assert.equal(consoleAssistantToolByName("nope"), null);
});

test("the loop runs a read tool and answers from its result", async () => {
  const seen = [];
  const run = async (model, payload) => {
    seen.push(payload.messages);
    if (seen.length === 1) return { tool_calls: [{ id: "call_1", function: { name: "console_guide", arguments: JSON.stringify({ topic: "trips" }) } }] };
    return { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Organizer trips live in the Organizer workspace." } }] };
  };
  const result = await consoleAssistantReply({ request, account: adminAccount, message: "Where do I manage trips?", run });
  assert.equal(result.reply, "Organizer trips live in the Organizer workspace.");
  assert.deepEqual(result.toolRuns, ["Console guide"]);
  assert.equal(result.pendingAction, undefined);
  const toolMessage = seen[1].find((message) => message.role === "tool");
  assert.ok(toolMessage, "the tool result must be handed back to the model");
  assert.match(toolMessage.content, /Organizer workspaces?"?:|Organizer workspace/i);
});

test("the daily brief is role-shaped and survives a service it cannot read", async () => {
  const expectations = [
    { account: adminAccount, hrefs: ["/console/organizers", "/console/disputes", "/console/payouts", "/console/campus"] },
    { account: moderatorAccount, hrefs: ["/console/organizers", "/console/disputes"] },
    { account: organizerAccount, hrefs: ["/console/trips", "/console/earnings", "/console/disputes"] },
    { account: driverAccount, hrefs: ["/console/driver", "/console/change-password"] },
  ];
  for (const { account, hrefs } of expectations) {
    const brief = await consoleBriefFor({ request, account });
    assert.equal(brief.role, account.role);
    assert.ok(brief.headline.trim(), `${account.role} needs a greeting`);
    assert.ok(brief.summary.trim(), `${account.role} needs a one-line summary`);
    assert.ok(!Number.isNaN(Date.parse(brief.generatedAt)), `${account.role} needs a readable timestamp`);
    assert.ok(Array.isArray(brief.items), `${account.role} needs an item list`);
    for (const item of brief.items) {
      assert.ok(item.key && item.label && item.value, `${account.role} brief items must be readable`);
      assert.ok(["action", "info", "good"].includes(item.tone), `${account.role} brief item has an unknown tone`);
      if (item.href) {
        assert.ok(item.href.startsWith("/console/"), `${item.href} must stay inside the console`);
        assert.ok(hrefs.includes(item.href), `${account.role} must not be pointed at ${item.href}`);
      }
    }
    // A service that cannot be read is reported, never hidden: either the
    // section appears or the note says it is missing. Silence is the bug.
    assert.ok(brief.items.length || brief.note.trim(), `${account.role} brief must say when it read nothing`);
  }
});

test("the loop runs the daily brief and answers from its result", async () => {
  const seen = [];
  const run = async (model, payload) => {
    seen.push(payload.messages);
    if (seen.length === 1) return { tool_calls: [{ id: "call_1", function: { name: "daily_brief", arguments: "{}" } }] };
    return { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Start with the review queue, then the disputes." } }] };
  };
  const result = await consoleAssistantReply({ request, account: adminAccount, message: "What needs my attention today?", run });
  assert.equal(result.reply, "Start with the review queue, then the disputes.");
  assert.deepEqual(result.toolRuns, ["Daily brief"]);
  assert.equal(result.pendingAction, undefined);
  const toolMessage = seen[1].find((message) => message.role === "tool");
  assert.ok(toolMessage, "the brief must be handed back to the model");
  assert.match(toolMessage.content, /"summary"/);
});

test("an action tool is proposed, never executed", async () => {
  const run = async () => ({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "organizers_review", arguments: JSON.stringify({ organizerId: "org_1", action: "APPROVE" }) } }],
      },
    }],
  });
  const result = await consoleAssistantReply({ request, account: adminAccount, message: "Approve org_1.", run });
  assert.equal(result.pendingAction?.title, "Review an organizer application");
  assert.match(result.pendingAction?.summary || "", /org_1/);
  assert.match(result.reply, /confirm/i);
  // The handler would have hit the database; reaching this line proves it did not run.
});

test("a tool the role does not hold is refused and reported to the model", async () => {
  const seen = [];
  const run = async (model, payload) => {
    seen.push(payload.messages);
    if (seen.length === 1) return { tool_calls: [{ id: "call_1", function: { name: "organizers_list", arguments: "{}" } }] };
    return { response: "That is staff-only; your Organizer workspace shows your own trips." };
  };
  const result = await consoleAssistantReply({ request, account: organizerAccount, message: "Show every organizer application.", run });
  const refusal = seen[1].find((message) => message.role === "tool");
  assert.match(refusal.content, /not available to this role/);
  assert.match(result.reply, /staff-only/);
});
