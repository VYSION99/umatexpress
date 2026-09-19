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
  // The endpoint is stubbed so the browser check never needs development
  // credentials: ?role=DRIVER answers with a driver session, no role at all
  // answers 401 and must land on the sign-in screen.
  await call("Page.addScriptToEvaluateOnNewDocument", { source: `
    const realFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      const method = (init && init.method) || "GET";
      if (url.startsWith("/api/console/session") && method === "GET") {
        const role = new URL(location.href).searchParams.get("role");
        if (!role) return Promise.resolve(new Response(JSON.stringify({authenticated:false}),{status:401,headers:{"Content-Type":"application/json"}}));
        return Promise.resolve(new Response(JSON.stringify({
          authenticated: true,
          account: { id: "check-account", email: "check@example.com", name: "Console Check", role, status: "ACTIVE", profileId: "" },
          mustChangePassword: false,
        }), { status: 200, headers: { "Content-Type": "application/json" } }));
      }
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

  // 4. A service page opens the service's own sub-navigation in the rail, and
  //    the rail marks the page the person is actually on.
  await visit("/console/trips?role=ORGANIZER", `document.querySelector(".console-subnav") !== null`);
  assert.ok(await evaluate(`document.querySelector(".console-breadcrumb").textContent.includes("Organizer workspace")`), "the breadcrumb must name the open service");
  const subnav = await evaluate(`[...document.querySelectorAll(".console-subnav a")].map(node => node.textContent)`);
  assert.deepEqual(subnav, ["My trips", "Business profile", "Earnings"], "the open service must offer its own navigation");
  assert.equal(await evaluate(`document.querySelector(".console-subnav a[aria-current]").textContent`), "My trips", "the current page must be marked inside the sub-navigation");
  assert.equal(await evaluate(`document.querySelector(".console-service a[aria-current]").textContent`), "Organizer workspace", "the rail must mark the open service");
  console.log("PASS service pages open their own sub-navigation");

  // 5. An administrator sees every service, including the ones that are not
  //    ready: those are named and marked, never linkable.
  await visit("/console?role=ADMIN", `document.querySelectorAll(".console-card").length > 0`);
  const admin = await evaluate(`[...document.querySelectorAll(".console-card h2")].map(node => node.textContent)`);
  assert.ok(admin.includes("CampusRide") && admin.includes("VacationRide"), `admin cards were ${admin.join(", ")}`);
  const soon = await evaluate(`[...document.querySelectorAll(".console-service-soon small")].map(node => node.textContent)`);
  assert.deepEqual(soon, ["Soon", "Soon", "Soon"], "the services that are not ready must be marked in the rail");
  assert.equal(await evaluate(`document.querySelectorAll(".console-service-soon a").length`), 0, "a coming-soon service must not be linkable");

  // 6. The service finder opens over any page and filters the directory.
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

  // 7. No sideways scroll at any supported width, the rail is replaced by the
  //    mobile bar on a phone, and every control keeps its touch target.
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
