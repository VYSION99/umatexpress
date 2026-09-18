// Browser check for the console origin: the session gate, the role-scoped
// service list and the responsive layout. Console sign-in itself is covered by
// the server tests; this checks what a person actually sees.
import assert from "node:assert/strict";

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

  // 2. A driver sees only the driver portal and account security.
  await call("Page.navigate", { url: `${origin}/console?role=DRIVER` });
  await until(`document.querySelectorAll(".console-card").length > 0`, "the driver console");
  const driver = await evaluate(`[...document.querySelectorAll(".console-card h2")].map(node => node.textContent)`);
  assert.deepEqual(driver, ["Driver portal", "Account security"], "a driver must not be offered admin services");
  assert.equal(await evaluate(`document.querySelectorAll(".console-account button").length`), 1, "the console must offer sign-out");

  // 3. An organizer gets their own workspace, not the admin surfaces.
  await call("Page.navigate", { url: `${origin}/console?role=ORGANIZER` });
  await until(`document.querySelectorAll(".console-card").length > 0`, "the organizer console");
  const organizer = await evaluate(`[...document.querySelectorAll(".console-card h2")].map(node => node.textContent)`);
  assert.deepEqual(organizer, ["Organizer workspace", "Account security"]);

  // 4. An administrator sees every service card.
  await call("Page.navigate", { url: `${origin}/console?role=ADMIN` });
  await until(`document.querySelectorAll(".console-card").length > 0`, "the admin console");
  const admin = await evaluate(`[...document.querySelectorAll(".console-card h2")].map(node => node.textContent)`);
  assert.ok(admin.includes("CampusRide") && admin.includes("VacationRide"), `admin cards were ${admin.join(", ")}`);

  // 5. No sideways scroll at any supported width, and no runtime errors.
  for (const width of [320, 390, 768, 1440]) {
    await call("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width < 700 });
    await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    const geometry = await evaluate(`({ page: document.documentElement.scrollWidth, view: window.innerWidth })`);
    assert.ok(geometry.page <= geometry.view + 1, `the console overflows at ${width}px (${geometry.page} > ${geometry.view})`);
  }

  assert.deepEqual(runtimeErrors, [], "the console raised runtime errors");
  console.log("console origin check passed");
} finally {
  socket.close();
}
