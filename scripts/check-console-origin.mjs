// Browser check for the console origin: the session gate, the one shell every
// service is framed by, the role-scoped service directory and the responsive
// layout. Console sign-in itself is covered by the server tests; this checks
// what a person actually sees.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

const origin = process.env.CONSOLE_ORIGIN_TEST_URL || "http://127.0.0.1:5190";
const debugPort = process.env.CONSOLE_ORIGIN_DEBUG_PORT || "9231";
const tabs = await fetch(`http://127.0.0.1:${debugPort}/json`).then((response) => response.json());
const socket = new WebSocket(tabs.find((tab) => tab.type === "page").webSocketDebuggerUrl);
await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));

let id = 0;
const pending = new Map();
const runtimeErrors = [];
socket.addEventListener("message", ({ data }) => {
  const message = JSON.parse(data);
  if (message.method === "Runtime.exceptionThrown") runtimeErrors.push(message.params.exceptionDetails.text);
  if (message.id) { const callback = pending.get(message.id); pending.delete(message.id); callback?.(message); }
});
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const current = ++id;
    pending.set(current, (message) => (message.error ? reject(message.error) : resolve(message.result)));
    socket.send(JSON.stringify({ id: current, method, params }));
  });
}
async function evaluate(expression) {
  const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}
async function until(expression, label) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (await evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${label || expression}`);
}
async function visit(path, ready) {
  await call("Page.navigate", { url: `${origin}${path}` });
  await until(ready, `${path} to render`);
}
const click = (expression) => evaluate(`(() => { const node = ${expression}; node.click(); return Boolean(node); })()`);

try {
  await call("Runtime.enable");
  await call("Page.enable");
  // The endpoints are stubbed so the browser check never needs development
  // credentials: ?role=DRIVER answers with a driver session, no role at all
  // answers 401 and must land on the sign-in screen, and the empty service
  // payloads let CampusRide, VacationRide and the driver portal render their
  // real screens instead of their error banners.
  await call("Page.addScriptToEvaluateOnNewDocument", { source: `
    const realFetch = window.fetch.bind(window);
    const json = (body) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
    window.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      const method = (init && init.method) || "GET";
      if (url.startsWith("/api/console/session") && method === "GET") {
        const role = new URL(location.href).searchParams.get("role");
        if (!role) return Promise.resolve(new Response(JSON.stringify({authenticated:false}),{status:401,headers:{"Content-Type":"application/json"}}));
        return json({
          authenticated: true,
          account: { id: "check-account", email: "check@example.com", name: "Console Check", role, status: "ACTIVE", profileId: "check-driver" },
          mustChangePassword: false,
        });
      }
      if (url.startsWith("/api/admin/campus/overview")) return json({ zones: [], corridors: [], vehicles: [], drivers: [], rides: [] });
      if (url.startsWith("/api/admin/bookings")) return json({ bookings: [] });
      if (url.startsWith("/api/trips/display")) return json({ mode: "BOTH", morningDeparture: "06:30", morningArrival: "11:30", eveningDeparture: "13:00", eveningArrival: "18:00", flyerPromo: null });
      if (url.startsWith("/api/trips/schedule")) return json({ trips: [] });
      if (url.startsWith("/api/driver/me")) return json({ driver: { id: "check-driver", name: "Check Driver", active: true, vehicleId: "", currentZoneId: "", mustChangePassword: false }, ride: null, zones: [], corridors: [], vehicles: [] });
      if (url.startsWith("/api/driver/queue")) return json({ queue: [] });
      if (url.startsWith("/api/driver/summary")) return json({ day: "Today", completed: 0, boarded: 0, grossFares: 0, activeQueue: 0, nextPickup: null });
      if (url.startsWith("/api/console/assistant/brief") && method === "GET") return json({ ok: true, role: "ORGANIZER", headline: "Good morning, Console", summary: "One thing needs your attention today.", generatedAt: new Date().toISOString(), items: [{ key: "trips-fix", label: "Trips needing a fix", value: "1", detail: "Reason: coach photo missing.", href: "/console/trips", tone: "action" }, { key: "next-departure", label: "Next departure", value: "2026-10-04", detail: "Accra → Kumasi · 12 of 45 seats confirmed.", href: "/console/trips", tone: "info" }], note: "" });
      if (url.startsWith("/api/console/assistant/confirm") && method === "POST") return json({ ok: true, tool: "trips_review", title: "Review an organizer trip", result: { done: true } });
      if (url.startsWith("/api/console/assistant") && method === "POST") return json({ ok: true, reply: "Three organizer applications are waiting for review.", toolRuns: ["Organizer applications"], pendingAction: { token: "stub-token", title: "Review an organizer application", summary: "Organizer id: org_1 · Decision: APPROVE" } });
      return realFetch(input, init);
    };
  ` });

  // 1. Signed out: the gate must send the visitor to the sign-in screen.
  await call("Page.navigate", { url: `${origin}/console` });
  await until(`location.pathname === "/console/login"`, "the sign-in redirect");
  await until(`document.querySelector(".console-auth-card") !== null`, "the sign-in form");
  await evaluate(`document.querySelector(".console-auth-card input").focus()`);
  console.log("PASS signed-out visitors land on the console sign-in screen");

  // 2. Every signed-in page is framed by the one shell: the rail names the
  //    service, the top bar names the role, and the mobile bar exists.
  await visit("/console?role=DRIVER", `document.querySelectorAll(".console-card").length > 0`);
  assert.equal(await evaluate(`document.querySelectorAll(".console-sidebar").length`), 1, "the console must be framed by the shell");
  assert.equal(await evaluate(`document.querySelectorAll(".console-signout").length`), 1, "the shell must carry exactly one sign-out");
  assert.ok(await evaluate(`document.querySelector(".console-breadcrumb").textContent.startsWith("Console")`), "the top bar must carry the breadcrumb");
  const driver = await evaluate(`[...document.querySelectorAll(".console-card h2")].map(node => node.textContent)`);
  assert.deepEqual(driver, ["Driver portal", "Account security"], "a driver must not be offered admin services");
  const driverRail = await evaluate(`[...document.querySelectorAll(".console-service a, .console-service-soon")].map(node => node.textContent)`);
  assert.deepEqual(driverRail, ["Driver portal", "Account security"], "a driver's rail must only list what the role may use");
  console.log("PASS the shell frames the page and scopes the rail to the role");

  // 3. The home page is a grouped directory, the way a cloud console groups
  //    its products, and the groups follow the declared order.
  await visit("/console?role=ORGANIZER", `document.querySelectorAll(".console-card").length > 0`);
  const organizer = await evaluate(`[...document.querySelectorAll(".console-card h2")].map(node => node.textContent)`);
  assert.deepEqual(organizer, ["Organizer workspace", "Business profile", "Earnings", "Disputes", "Account security"]);
  const groups = await evaluate(`[...document.querySelectorAll(".console-group-heading")].map(node => node.textContent)`);
  assert.deepEqual(groups, ["Self-service trips", "Money", "Trust & safety", "Account"], "the directory must group services in the declared order");
  console.log("PASS the home page is a grouped service directory");
  await until(`document.querySelector(".console-brief-strip") !== null`, "the daily brief strip on the home page");
  assert.match(await evaluate(`document.querySelector(".console-brief-strip").textContent`), /One thing needs your attention/, "the home strip must carry the brief summary");
  const stripLinks = await evaluate(`[...document.querySelectorAll(".console-brief-strip li a")].map(node => node.getAttribute("href"))`);
  assert.ok(stripLinks.length > 0 && stripLinks.every((href) => href.startsWith("/console/")), "every brief chip must stay inside the console");
  assert.equal(await evaluate(`document.querySelectorAll(".console-brief-strip li.tone-action").length > 0`), true, "the strip must mark what needs attention");
  await click(`document.querySelector(".console-brief-ask")`);
  await until(`document.querySelector(".console-assistant-panel") !== null`, "the strip to open the assistant panel");
  await click(`document.querySelector(".console-assistant-toggle")`);
  await until(`document.querySelector(".console-assistant-panel") === null`, "the assistant panel to close again");
  console.log("PASS the console home opens with the daily brief");

  // 4. A service page opens the service's own sub-navigation in the rail, and
  //    the rail marks the page the person is actually on.
  await visit("/console/trips?role=ORGANIZER", `document.querySelector(".console-subnav") !== null`);
  assert.ok(await evaluate(`document.querySelector(".console-breadcrumb").textContent.includes("Organizer workspace")`), "the breadcrumb must name the open service");
  const subnav = await evaluate(`[...document.querySelectorAll(".console-subnav a")].map(node => node.textContent)`);
  assert.deepEqual(subnav, ["My trips", "Business profile", "Earnings"], "the open service must offer its own navigation");
  assert.equal(await evaluate(`document.querySelector(".console-subnav a[aria-current]").textContent`), "My trips", "the current page must be marked inside the sub-navigation");
  assert.equal(await evaluate(`document.querySelector(".console-service a[aria-current]").textContent`), "Organizer workspace", "the rail must mark the open service");
  console.log("PASS service pages open their own sub-navigation");

  // 5. The services the console absorbed render inside the same shell:
  //    CampusRide operations, the VacationRide trip console and the driver
  //    portal, each behind the role that may use it.
  await visit("/console/campus?role=ADMIN", `document.querySelector(".console-hero h1")?.textContent === "CampusRide control center"`);
  assert.ok(await evaluate(`document.querySelector(".console-body .campus-status-banner") !== null`), "CampusRide operations must render inside the console");
  assert.equal(await evaluate(`document.querySelector(".console-service a[aria-current]").textContent`), "CampusRide", "the rail must mark CampusRide while it is open");
  await visit("/console/vacation?role=ADMIN", `document.querySelector(".console-hero h1")?.textContent === "Booking overview"`);
  assert.ok(await evaluate(`document.querySelector(".console-body .trip-scheduler-card") !== null`), "the trip scheduler must render inside the console");
  await visit("/console/driver?role=DRIVER", `document.querySelector(".console-hero h1")?.textContent === "Campus driver dashboard"`);
  await until(`document.querySelector(".console-body .campus-widget-card h2")?.textContent === "Check Driver"`, "the driver workspace to load");
  assert.equal(await evaluate(`document.querySelector(".console-body .campus-widget-card h2")?.textContent`), "Check Driver", "the driver workspace must render inside the console");
  await visit("/console/vacation?role=DRIVER", `document.querySelector(".console-hero h1")?.textContent === "Not available"`);
  assert.ok(await evaluate(`document.querySelector(".console-body") === null`), "a refused service must not render its body");
  console.log("PASS CampusRide, VacationRide and the driver portal render inside the shell");

  // 6. The addresses the console used to answer on now land on the console,
  //    query string and all, wherever they are opened from.
  await call("Page.navigate", { url: `${origin}/admin` });
  await until(`location.pathname === "/console/login"`, "the legacy console entry to redirect");
  await call("Page.navigate", { url: `${origin}/admin/campus?role=ADMIN` });
  await until(`location.pathname === "/console/campus" && location.search === "?role=ADMIN"`, "the legacy campus path to redirect with its query");
  await call("Page.navigate", { url: `${origin}/driver?role=DRIVER` });
  await until(`location.pathname === "/console/driver" && location.search === "?role=DRIVER"`, "the legacy driver path to redirect with its query");
  await until(`document.querySelector(".console-hero h1")?.textContent === "Campus driver dashboard"`, "the console driver portal to render after the redirect");
  assert.ok(await evaluate(`document.querySelector(".console-body .campus-widget-card h2")?.textContent === "Check Driver"`), "the legacy driver portal must land on the console driver portal");
  await call("Page.navigate", { url: `${origin}/driver/login` });
  await until(`location.pathname === "/console/login"`, "the legacy driver sign-in to redirect");
  console.log("PASS legacy admin and driver addresses redirect into the console");

  // 7. An administrator sees every service, including the ones that are not
  //    ready: those are named and marked, never linkable.
  await visit("/console?role=ADMIN", `document.querySelectorAll(".console-card").length > 0`);
  const admin = await evaluate(`[...document.querySelectorAll(".console-card h2")].map(node => node.textContent)`);
  assert.ok(admin.includes("CampusRide") && admin.includes("VacationRide"), `admin cards were ${admin.join(", ")}`);
  const soon = await evaluate(`[...document.querySelectorAll(".console-service-soon small")].map(node => node.textContent)`);
  // Food and OnlineCinema are the two still waiting; Hostel Finder opened with its landlord workspace.
  assert.deepEqual(soon, ["Soon", "Soon"], "the services that are not ready must be marked in the rail");
  assert.equal(await evaluate(`document.querySelectorAll(".console-service-soon a").length`), 0, "a coming-soon service must not be linkable");

  // 8. The service finder opens over any page and filters the directory.
  await click(`document.querySelector('.console-sidebar button')`);
  await until(`document.querySelector("dialog").open`, "the service finder to open");
  assert.ok(await evaluate(`document.querySelectorAll(".launch-directory article").length > 5`), "the finder must list the directory");
  await evaluate(`(() => {
    const input = document.querySelector("dialog input");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, "payout");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await until(`document.querySelectorAll(".launch-directory article").length === 3`, "the finder to filter");
  const found = await evaluate(`[...document.querySelectorAll(".launch-directory h3")].map(node => node.firstChild.textContent)`);
  assert.deepEqual(found, ["Business profile", "Earnings", "Organizer payouts"], "the finder must match on what a service does");
  await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await until(`!document.querySelector("dialog").open`, "the finder to close");
  console.log("PASS the service finder searches every service");

  // 9. Getting access is one page for every service: the services that take
  //    applications, the ones that are still coming, and the roles that are
  //    only ever set up by the team that runs them.
  await visit("/console/register", `document.querySelectorAll(".console-apply-grid .console-card").length > 0`);
  await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 1000, deviceScaleFactor: 1, mobile: true });
  await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  const accessShot = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  await writeFile("/tmp/umatexpress-console-access-390.png", Buffer.from(accessShot.data, "base64"));
  const applications = await evaluate(`[...document.querySelectorAll(".console-apply-grid .console-card")].map(node => ({ title: node.querySelector("h2").textContent, label: node.querySelector(".console-card-label").textContent }))`);
  assert.deepEqual(applications.map((application) => application.title), ["Trip organizer", "Hostel landlord", "Food vendor", "Cinema partner"], "the picker must cover every service");
  assert.equal(applications[0].label, "OPEN FOR APPLICATIONS", "the service that takes applications must say so");
  assert.deepEqual(applications.slice(1).map((application) => application.label), ["OPEN FOR APPLICATIONS", "COMING SOON", "COMING SOON"], "a service accepts applications only once its workspace exists");
  const invited = await evaluate(`[...document.querySelectorAll(".console-apply-invited article strong")].map(node => node.textContent)`);
  assert.deepEqual(invited, ["CampusRide driver", "Platform staff"], "the roles that are set up by the team must be named");
  await visit("/console/register/organizer", `document.querySelector(".console-auth-card h1")?.textContent === "Organise your coach"`);
  const formShot = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  await writeFile("/tmp/umatexpress-console-apply-organizer-390.png", Buffer.from(formShot.data, "base64"));
  const applicationFields = await evaluate(`[...document.querySelectorAll(".console-auth-card input")].map(node => node.type)`);
  assert.deepEqual(applicationFields, ["text", "text", "tel", "email", "password"], "the organizer form must collect the agreed fields");
  await visit("/console/register/landlord", `document.querySelector(".console-auth-card h1")?.textContent === "List your hostel"`);
  const landlordFields = await evaluate(`[...document.querySelectorAll(".console-auth-card input")].map(node => node.type)`);
  assert.deepEqual(landlordFields, ["text", "text", "tel", "email", "password"], "the landlord form must collect the agreed fields");
  await visit("/console/register/nonsense", `document.querySelector(".console-auth-card h1")?.textContent === "Application not found"`);
  console.log("PASS access applications cover every service");

  // 10. The assistant sits on every page: it answers with the tools the role
  //     holds, and an action it proposes only runs after the person confirms.
  await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 900, deviceScaleFactor: 1, mobile: true });
  await visit("/console?role=ORGANIZER", `document.querySelector(".console-assistant-toggle") !== null`);
  await until(`document.querySelector(".console-assistant-badge")?.textContent === "1"`, "the brief badge on the console home");
  await click(`document.querySelector(".console-assistant-toggle")`);
  await until(`document.querySelector(".console-assistant-panel") !== null`, "the assistant panel to open");
  await until(`document.querySelector(".console-assistant-brief") !== null`, "the daily brief card");
  assert.match(await evaluate(`document.querySelector(".console-assistant-brief").textContent`), /Trips needing a fix/, "the brief must name what needs attention");
  assert.match(await evaluate(`document.querySelector(".console-assistant-brief").textContent`), /One thing needs your attention/, "the brief must summarise the day");
  const briefShot = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  await writeFile("/tmp/umatexpress-console-assistant-390.png", Buffer.from(briefShot.data, "base64"));
  await click(`document.querySelector(".console-assistant-suggestions button")`);
  await until(`document.querySelector(".console-assistant-assistant")?.textContent.includes("Three organizer applications")`, "the assistant reply");
  const proposed = await evaluate(`document.querySelector(".console-assistant-confirm strong")?.textContent`);
  assert.equal(proposed, "Review an organizer application", "a proposed action must be shown for confirmation");
  const confirmed = await click(`[...document.querySelectorAll(".console-assistant-confirm button")].find(node => node.textContent === "Confirm")`);
  assert.ok(confirmed, "the confirmation card must offer a confirm button");
  await until(`document.querySelector(".console-assistant-log").textContent.includes("Done: Review an organizer trip.")`, "the confirmed action to report back");
  await click(`document.querySelector(".console-assistant-toggle")`);
  await until(`document.querySelector(".console-assistant-panel") === null`, "the assistant panel to close");
  console.log("PASS the assistant answers in the shell and waits for confirmation");

  // 11. No sideways scroll at any supported width, the rail is replaced by the
  //    mobile bar on a phone, and every control keeps its touch target.
  await visit("/console?role=ADMIN", `document.querySelector(".console-sidebar") !== null`);
  for (const width of [320, 390, 768, 1440]) {
    await call("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width < 700 });
    await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    const geometry = await evaluate(`({
      page: document.documentElement.scrollWidth,
      view: window.innerWidth,
      rail: getComputedStyle(document.querySelector(".console-sidebar")).display,
      mobileBar: getComputedStyle(document.querySelector(".launch-mobile-nav")).display,
      tiny: [...document.querySelectorAll(".console-workspace a, .console-workspace button, .launch-mobile-nav a, .launch-mobile-nav button")].filter(e => e.getClientRects().length && (e.getBoundingClientRect().height < 44 || e.getBoundingClientRect().width < 44)).map(e => e.tagName.toLowerCase() + "." + e.className + ":" + Math.round(e.getBoundingClientRect().width) + "x" + Math.round(e.getBoundingClientRect().height)),
    })`);
    assert.ok(geometry.page <= geometry.view + 1, `the console overflows at ${width}px (${geometry.page} > ${geometry.view})`);
    assert.deepEqual(geometry.tiny, [], `a control is smaller than a touch target at ${width}px`);
    assert.equal(geometry.rail === "none", width <= 800, `the rail must ${width <= 800 ? "step aside" : "stay"} at ${width}px`);
    assert.equal(geometry.mobileBar === "none", width > 800, `the mobile bar must ${width > 800 ? "step aside" : "stay"} at ${width}px`);
    const screenshot = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    await writeFile(`/tmp/umatexpress-console-${width}.png`, Buffer.from(screenshot.data, "base64"));
    console.log(`PASS responsive layout and touch targets: ${width}px`);
  }

  assert.deepEqual(runtimeErrors, [], "the console raised runtime errors");
  console.log("console origin check passed");
} finally {
  socket.close();
}
