import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { sqliteTurso } from "./helpers/sqlite-turso.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => vite.close());
const { curiosityCatalog } = await vite.ssrLoadModule("/lib/curiosity/catalog.ts");
const { decideCuriosity, curiosityCandidateIds } = await vite.ssrLoadModule("/lib/curiosity/policy.ts");
const route = await vite.ssrLoadModule("/app/api/curiosity/decision/route.ts");
const feedbackRoute = await vite.ssrLoadModule("/app/api/curiosity/feedback/route.ts");
const { validCuriosityFeedback, curiosityFeedbackSummary, curiosityFeedbackHealthAlerts, pruneCuriosityFeedback } = await vite.ssrLoadModule("/lib/curiosity/feedback.ts");
const { curiosityReadiness, clearCuriosityReadinessCache } = await vite.ssrLoadModule("/lib/curiosity/readiness.ts");
const { interpretCuriosityGoal } = await vite.ssrLoadModule("/lib/curiosity/interpreter.ts");
const { runCuriosityShadow } = await vite.ssrLoadModule("/lib/curiosity/shadow.ts");
const shadowRoute = await vite.ssrLoadModule("/app/api/console/curiosity/shadow/route.ts");
const catalog = curiosityCatalog();
const ready = catalog.map(({ id }) => ({ serviceId: id, eligible: true, reasonCode: "READY", checkedAt: new Date().toISOString() }));

test("the real launcher state excludes unlaunched and external services", () => {
  assert.equal(catalog.find((item) => item.id === "print-copy").launched, false);
  assert.equal(catalog.find((item) => item.id === "food").launched, false);
  assert.equal(catalog.some((item) => item.id === "research" || item.id === "clipad"), false);
  assert.deepEqual(curiosityCandidateIds({ intent: "travel" }), ["campus", "vacation"]);
  assert.deepEqual(curiosityCandidateIds({ intent: "housing" }), ["hostels"]);
});

test("readiness, launch and hide gates cannot be bypassed by intent", () => {
  assert.equal(decideCuriosity({ intent: "print" }, catalog, ready).kind, "ABSTAIN");
  assert.equal(decideCuriosity({ intent: "food" }, catalog, ready).kind, "ABSTAIN");
  assert.equal(decideCuriosity({ intent: "housing", hiddenServiceIds: ["hostels"] }, catalog, ready).kind, "ABSTAIN");
  const unavailable = ready.map((item) => item.serviceId === "hostels" ? { ...item, eligible: false } : item);
  assert.equal(decideCuriosity({ intent: "housing" }, catalog, unavailable).kind, "ABSTAIN");
  assert.equal(decideCuriosity({ intent: "housing" }, catalog, []).kind, "ABSTAIN");
});

test("travel asks once, then recommends only the chosen eligible service", () => {
  const question = decideCuriosity({ intent: "travel" }, catalog, ready);
  assert.equal(question.kind, "ASK");
  assert.equal(question.questionId, "TRAVEL_KIND");
  assert.equal(decideCuriosity({ intent: "travel", questionsAsked: 1 }, catalog, ready).reasonCode, "QUESTION_SKIPPED");
  const home = decideCuriosity({ intent: "travel", travelChoice: "home", questionsAsked: 1 }, catalog, ready);
  assert.equal(home.kind, "SUGGEST");
  assert.equal(home.service.id, "vacation");
  assert.equal(home.service.href, "/vacation");
  assert.match(home.explanation, /check the current fare and seats/i);
  const noHome = ready.map((item) => item.serviceId === "vacation" ? { ...item, eligible: false } : item);
  assert.equal(decideCuriosity({ intent: "travel", travelChoice: "home" }, catalog, noHome).kind, "ABSTAIN");
});

test("sensitive and unknown intents produce no service recommendation", () => {
  assert.equal(decideCuriosity({ intent: "health" }, catalog, ready).reasonCode, "SENSITIVE_INTENT");
  assert.equal(decideCuriosity({ intent: "counselling" }, catalog, ready).kind, "ABSTAIN");
  assert.equal(decideCuriosity({ intent: "unknown" }, catalog, ready).reasonCode, "NO_GOAL");
  assert.equal(decideCuriosity({ intent: "research" }, catalog, ready).kind, "ABSTAIN");
});

test("synthetic shadow scenarios audit the live catalog without student data", async () => {
  const report = await runCuriosityShadow({ catalog, readiness: ready });
  assert.equal(report.summary.failed, 0);
  assert.equal(report.summary.readinessHolds, 0);
  assert.equal(report.summary.checked, report.scenarios.length);
  assert.ok(report.scenarios.some((item) => item.id === "travel-choice" && item.kind === "ASK"));
  assert.ok(report.scenarios.some((item) => item.id === "hidden-campus" && item.kind === "ABSTAIN"));
  assert.ok(report.scenarios.some((item) => item.id === "sensitive-health" && item.kind === "ABSTAIN"));
  assert.ok(report.scenarios.some((item) => item.id === "printing" && item.kind === "ABSTAIN"));
  assert.equal(JSON.stringify(report).includes("student_email"), false);
  const offline = await runCuriosityShadow({ catalog, readiness: [] });
  assert.equal(offline.summary.failed, 0);
  assert.ok(offline.summary.readinessHolds > 0);
  assert.ok(offline.scenarios.every((item) => item.kind === "ABSTAIN"));
});

test("shadow diagnostics require a console session", async () => {
  const response = await shadowRoute.GET(new Request("https://console.example/api/console/curiosity/shadow"));
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
});

test("the pilot API is off by default and refuses cross-origin requests", async () => {
  const old = process.env.CURIOSITY_PILOT_ENABLED;
  delete process.env.CURIOSITY_PILOT_ENABLED;
  try {
    const availability = await route.GET(new Request("https://campus.example/api/curiosity/decision"));
    assert.equal((await availability.json()).enabled, false);
    assert.equal(availability.headers.get("set-cookie"), null);
    const decision = await route.POST(new Request("https://campus.example/api/curiosity/decision", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ intent: "travel" }) }));
    assert.equal(decision.status, 404);
    const crossOrigin = await route.POST(new Request("https://campus.example/api/curiosity/decision", { method: "POST", headers: { origin: "https://other.example", "content-type": "application/json" }, body: JSON.stringify({ intent: "travel" }) }));
    assert.equal(crossOrigin.status, 403);
    const feedback = await feedbackRoute.POST(new Request("https://campus.example/api/curiosity/feedback", { method: "POST", body: JSON.stringify({ serviceId: "cinema", policyVersion: "curiosity-m1-1", outcome: "HELPFUL" }) }));
    assert.equal(feedback.status, 404);
  } finally {
    if (old === undefined) delete process.env.CURIOSITY_PILOT_ENABLED;
    else process.env.CURIOSITY_PILOT_ENABLED = old;
  }
});

test("feedback accepts only fixed, launched service outcomes", () => {
  const example = { serviceId: "cinema", policyVersion: "curiosity-m1-1", outcome: "HELPFUL", feedbackToken: "token" };
  assert.equal(validCuriosityFeedback(example), true);
  assert.equal(validCuriosityFeedback({ ...example, serviceId: "print-copy" }), false);
  assert.equal(validCuriosityFeedback({ ...example, studentId: "x" }), false);
  assert.equal(validCuriosityFeedback({ ...example, policyVersion: "old" }), false);
  assert.equal(validCuriosityFeedback({ ...example, feedbackToken: "x".repeat(201) }), false);
});

test("an enabled pilot still applies live readiness and local hide controls", async () => {
  const saved = { flag: process.env.CURIOSITY_PILOT_ENABLED, url: process.env.TURSO_DATABASE_URL, token: process.env.TURSO_AUTH_TOKEN, excluded: process.env.CURIOSITY_EXCLUDED_SERVICES, secret: process.env.CURIOSITY_PILOT_SIGNING_KEY, percent: process.env.CURIOSITY_PILOT_PERCENT, fetch: globalThis.fetch };
  const sql = sqliteTurso();
  process.env.CURIOSITY_PILOT_ENABLED = "true";
  process.env.CURIOSITY_PILOT_SIGNING_KEY = "test-curiosity-signing-key-with-32-bytes-minimum";
  process.env.CURIOSITY_PILOT_PERCENT = "100";
  process.env.TURSO_DATABASE_URL = "https://curiosity-test.turso.io";
  process.env.TURSO_AUTH_TOKEN = "test";
  delete process.env.CURIOSITY_EXCLUDED_SERVICES;
  globalThis.fetch = sql.fetch;
  try {
    delete process.env.CURIOSITY_PILOT_SIGNING_KEY;
    assert.equal((await (await route.GET(new Request("https://campus.example/api/curiosity/decision"))).json()).enabled, false);
    process.env.CURIOSITY_PILOT_SIGNING_KEY = "test-curiosity-signing-key-with-32-bytes-minimum";
    process.env.CURIOSITY_PILOT_PERCENT = "0";
    assert.equal((await (await route.GET(new Request("https://campus.example/api/curiosity/decision"))).json()).enabled, false);
    process.env.CURIOSITY_PILOT_PERCENT = "100";
    const noCohort = await route.POST(new Request("https://campus.example/api/curiosity/decision", { method: "POST", body: JSON.stringify({ intent: "social" }) }));
    assert.equal(noCohort.status, 404);
    const invitation = await route.GET(new Request("https://campus.example/api/curiosity/decision"));
    assert.equal((await invitation.json()).enabled, true);
    const cookie = invitation.headers.get("set-cookie").split(";")[0];
    assert.match(invitation.headers.get("set-cookie"), /HttpOnly/);
    const repeat = await route.GET(new Request("https://campus.example/api/curiosity/decision", { headers: { cookie } }));
    assert.equal(repeat.headers.get("set-cookie"), null);
    assert.equal((await repeat.json()).enabled, true);
    const request = (body, headerCookie = cookie) => new Request("https://campus.example/api/curiosity/decision", { method: "POST", headers: { "content-type": "application/json", cookie: headerCookie }, body: JSON.stringify(body) });
    assert.equal((await route.POST(request({ intent: "social" }, `${cookie}x`))).status, 404);
    const allowed = await (await route.POST(request({ intent: "social" }))).json();
    assert.equal(allowed.decision.kind, "SUGGEST");
    assert.equal(allowed.decision.service.id, "cinema");
    assert.match(allowed.feedbackToken, /^v1\./);
    assert.equal((await (await route.POST(request({ intent: "print" }))).json()).decision.kind, "ABSTAIN");
    assert.equal((await (await route.POST(request({ intent: "housing" }))).json()).decision.kind, "ABSTAIN");
    assert.equal((await (await route.POST(request({ intent: "social", hiddenServiceIds: ["cinema"] }))).json()).decision.kind, "ABSTAIN");
    process.env.CURIOSITY_EXCLUDED_SERVICES = "cinema";
    assert.equal((await (await route.POST(request({ intent: "social" }))).json()).decision.kind, "ABSTAIN");
    const rating = { serviceId: "cinema", policyVersion: "curiosity-m1-1", outcome: "HELPFUL", feedbackToken: allowed.feedbackToken };
    const feedbackRequest = (body, origin, headerCookie = cookie) => new Request("https://campus.example/api/curiosity/feedback", { method: "POST", headers: { "content-type": "application/json", cookie: headerCookie, ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });
    assert.equal((await feedbackRoute.POST(feedbackRequest(rating, "https://other.example"))).status, 403);
    assert.equal((await feedbackRoute.POST(feedbackRequest({ ...rating, outcome: "maybe" }))).status, 400);
    assert.equal((await feedbackRoute.POST(feedbackRequest({ ...rating, feedbackToken: "v1.bad" }))).status, 403);
    assert.equal((await feedbackRoute.POST(feedbackRequest(rating, undefined, ""))).status, 404);
    const otherInvitation = await route.GET(new Request("https://campus.example/api/curiosity/decision"));
    const otherCookie = otherInvitation.headers.get("set-cookie").split(";")[0];
    assert.equal((await feedbackRoute.POST(feedbackRequest(rating, undefined, otherCookie))).status, 403);
    const response = await feedbackRoute.POST(feedbackRequest(rating));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).recorded, true);
    const replay = await feedbackRoute.POST(feedbackRequest(rating));
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).recorded, false);
    process.env.CURIOSITY_EXCLUDED_SERVICES = "none";
    const secondSuggestion = await (await route.POST(request({ intent: "social" }))).json();
    assert.notEqual(secondSuggestion.feedbackToken, allowed.feedbackToken);
    const secondRating = await feedbackRoute.POST(feedbackRequest({ ...rating, feedbackToken: secondSuggestion.feedbackToken, outcome: "NOT_HELPFUL" }));
    assert.equal((await secondRating.json()).recorded, false);
    sql.db.prepare("INSERT INTO curiosity_feedback_daily (day,policy_version,service_id,outcome,count) VALUES ('2020-01-01','curiosity-m1-1','cinema','NOT_HELPFUL',10)").run();
    assert.deepEqual(await curiosityFeedbackSummary(), [{ policyVersion: "curiosity-m1-1", serviceId: "cinema", outcome: "HELPFUL", count: 1 }]);
    assert.deepEqual(sql.db.prepare("PRAGMA table_info(curiosity_feedback_claims)").all().map((row) => row.name), ["dedupe_hash", "expires_at"]);
    assert.equal(sql.db.prepare("SELECT COUNT(*) AS count FROM curiosity_feedback_daily WHERE day = '2020-01-01'").get().count, 1, "summary read does not delete rows as a side-effect");
    await pruneCuriosityFeedback();
    assert.equal(sql.db.prepare("SELECT COUNT(*) AS count FROM curiosity_feedback_daily WHERE day = '2020-01-01'").get().count, 0);
    assert.deepEqual(sql.db.prepare("PRAGMA table_info(curiosity_feedback_daily)").all().map((row) => row.name), ["day", "policy_version", "service_id", "outcome", "count"]);
  } finally {
    clearCuriosityReadinessCache();
    globalThis.fetch = saved.fetch;
    sql.db.close();
    for (const [key, value] of [["CURIOSITY_PILOT_ENABLED", saved.flag], ["TURSO_DATABASE_URL", saved.url], ["TURSO_AUTH_TOKEN", saved.token], ["CURIOSITY_EXCLUDED_SERVICES", saved.excluded], ["CURIOSITY_PILOT_SIGNING_KEY", saved.secret], ["CURIOSITY_PILOT_PERCENT", saved.percent]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("single-branch travel resolves directly without asking a dead question", () => {
  const onlyCampus = decideCuriosity({ intent: "travel", hiddenServiceIds: ["vacation"] }, catalog, ready);
  assert.equal(onlyCampus.kind, "SUGGEST");
  assert.equal(onlyCampus.service.id, "campus");

  const onlyVacation = decideCuriosity({ intent: "travel", suppressedServiceIds: ["campus"] }, catalog, ready);
  assert.equal(onlyVacation.kind, "SUGGEST");
  assert.equal(onlyVacation.service.id, "vacation");

  const bothSuppressed = decideCuriosity({ intent: "travel", hiddenServiceIds: ["campus"], suppressedServiceIds: ["vacation"] }, catalog, ready);
  assert.equal(bothSuppressed.kind, "ABSTAIN");
  assert.equal(bothSuppressed.reasonCode, "NO_ELIGIBLE_SERVICE");
});

test("multi-step path orchestration orders steps topologically and drops unavailable steps safely", () => {
  // Social (cinema, stage 3) + Travel campus (campus, stage 2) -> ordered as campus -> cinema.
  const pathDecision = decideCuriosity(
    { intents: ["social", "travel"], travelChoice: "campus", questionsAsked: 1 },
    catalog,
    ready,
  );
  assert.equal(pathDecision.kind, "SUGGEST_PATH");
  assert.equal(pathDecision.reasonCode, "PATH_MATCH");
  assert.deepEqual(pathDecision.steps.map((s) => s.service.id), ["campus", "cinema"]);
  assert.ok(pathDecision.steps.every((s) => s.uncertaintyNote.length > 10));

  // Unlaunched step (print-copy) drops while ready step (cinema) is suggested with partialDropReason.
  const partial = decideCuriosity({ intents: ["print", "social"] }, catalog, ready);
  assert.equal(partial.kind, "SUGGEST");
  assert.equal(partial.service.id, "cinema");
  assert.match(partial.partialDropReason, /Print & Copy is unavailable right now/);

  // Sensitive intent anywhere in a multi-step list forces ABSTAIN.
  const sensitiveMulti = decideCuriosity({ intents: ["social", "health"] }, catalog, ready);
  assert.equal(sensitiveMulti.kind, "ABSTAIN");
  assert.equal(sensitiveMulti.reasonCode, "SENSITIVE_INTENT");

  // Multi-intent with unresolved travel asks once when both travel branches are ready.
  const askFirst = decideCuriosity({ intents: ["travel", "social"], questionsAsked: 0 }, catalog, ready);
  assert.equal(askFirst.kind, "ASK");
  assert.equal(askFirst.questionId, "TRAVEL_KIND");
});

test("parallel readiness isolates slow adapters, caches fresh checks, and flags feedback holds", async () => {
  const saved = { flag: process.env.CURIOSITY_PILOT_ENABLED, url: process.env.TURSO_DATABASE_URL, token: process.env.TURSO_AUTH_TOKEN, secret: process.env.CURIOSITY_PILOT_SIGNING_KEY, percent: process.env.CURIOSITY_PILOT_PERCENT, fetch: globalThis.fetch };
  const sql = sqliteTurso();
  process.env.CURIOSITY_PILOT_ENABLED = "true";
  process.env.CURIOSITY_PILOT_SIGNING_KEY = "test-curiosity-signing-key-with-32-bytes-minimum";
  process.env.CURIOSITY_PILOT_PERCENT = "100";
  process.env.TURSO_DATABASE_URL = "https://curiosity-orchestration-test.turso.io";
  process.env.TURSO_AUTH_TOKEN = "test";
  globalThis.fetch = sql.fetch;
  clearCuriosityReadinessCache();
  try {
    // 1. Timeout isolation: hostels times out, cinema stays READY.
    const subset = catalog.filter((c) => c.id === "hostels" || c.id === "cinema");
    const readinessResult = await curiosityReadiness(subset, {
      timeoutMs: 30,
      adapterOverrides: {
        hostels: () => new Promise((resolve) => setTimeout(() => resolve(true), 200)),
        cinema: async () => true,
      },
    });
    assert.equal(readinessResult.find((r) => r.serviceId === "hostels").reasonCode, "READINESS_CHECK_FAILED");
    assert.equal(readinessResult.find((r) => r.serviceId === "cinema").reasonCode, "READY");

    // 2. Multi-step decision route mints per-step feedback tokens.
    const invitation = await route.GET(new Request("https://campus.example/api/curiosity/decision"));
    const cookie = invitation.headers.get("set-cookie").split(";")[0];
    const res = await route.POST(new Request("https://campus.example/api/curiosity/decision", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ intents: ["social", "travel"], travelChoice: "campus", questionsAsked: 1 }),
    }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.decision.kind, "SUGGEST_PATH");
    assert.equal(body.decision.steps.length, 2);
    assert.match(body.decision.steps[0].feedbackToken, /^v1\./);
    assert.match(body.decision.steps[1].feedbackToken, /^v1\./);

    // 3. Feedback health alert triggers when >= 20 ratings in 7d have > 60% NOT_HELPFUL.
    const today = new Date().toISOString().slice(0, 10);
    await curiosityFeedbackSummary();
    sql.db.prepare("INSERT INTO curiosity_feedback_daily (day,policy_version,service_id,outcome,count) VALUES (?,?,?, 'HELPFUL', 5)").run(today, "curiosity-m1-1", "campus");
    sql.db.prepare("INSERT INTO curiosity_feedback_daily (day,policy_version,service_id,outcome,count) VALUES (?,?,?, 'NOT_HELPFUL', 18)").run(today, "curiosity-m1-1", "campus");
    const alerts = await curiosityFeedbackHealthAlerts();
    const campusAlert = alerts.find((a) => a.serviceId === "campus");
    assert.equal(campusAlert.holdRecommended, true);
    assert.equal(campusAlert.total, 23);
  } finally {
    clearCuriosityReadinessCache();
    globalThis.fetch = saved.fetch;
    sql.db.close();
    for (const [key, value] of [["CURIOSITY_PILOT_ENABLED", saved.flag], ["TURSO_DATABASE_URL", saved.url], ["TURSO_AUTH_TOKEN", saved.token], ["CURIOSITY_PILOT_SIGNING_KEY", saved.secret], ["CURIOSITY_PILOT_PERCENT", saved.percent]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("deterministic goal interpreter extracts ordered intents and blocks sensitive phrases", () => {
  assert.deepEqual(interpretCuriosityGoal("I need to print my thesis and travel home"), {
    intents: ["print", "travel"],
    travelChoice: "home",
    sensitive: false,
  });
  assert.deepEqual(interpretCuriosityGoal("Ride around campus then watch a movie"), {
    intents: ["travel", "social"],
    travelChoice: "campus",
    sensitive: false,
  });
  assert.deepEqual(interpretCuriosityGoal("I feel unwell and need the clinic"), {
    intents: ["health"],
    sensitive: true,
  });
  assert.deepEqual(interpretCuriosityGoal("Quantum mechanics homework"), {
    intents: ["unknown"],
    sensitive: false,
  });
});
