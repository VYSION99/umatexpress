import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

const origin = process.env.INTERFACE_TEST_URL || "http://127.0.0.1:5173";
const port = process.env.INTERFACE_DEBUG_PORT || "9231";
const routes = ["/", "/vacation", "/campus", "/console/login", "/admin/reset-password", "/payment/callback", "/campus/ticket"];
const tabs = await fetch(`http://127.0.0.1:${port}/json`).then(response => response.json());
const socket = new WebSocket(tabs.find(tab => tab.type === "page").webSocketDebuggerUrl);
await new Promise(resolve => socket.addEventListener("open", resolve, { once:true }));
let id = 0;
const pending = new Map();
const errors = [];
let route = "";
socket.addEventListener("message", ({ data }) => {
  const message = JSON.parse(data);
  if (message.method === "Runtime.exceptionThrown") errors.push(`${route}: ${message.params.exceptionDetails.text}`);
  if (message.id) { const callback = pending.get(message.id); pending.delete(message.id); callback?.(message); }
});
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const current = ++id;
    pending.set(current, message => message.error ? reject(message.error) : resolve(message.result));
    socket.send(JSON.stringify({ id:current, method, params }));
  });
}
async function evaluate(expression) {
  const result = await call("Runtime.evaluate", { expression, returnByValue:true, awaitPromise:true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}
async function until(expression) {
  for (let attempt = 0; attempt < 180; attempt++) {
    if (await evaluate(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out at ${route}`);
}
try {
  await call("Runtime.enable"); await call("Page.enable");
  for (route of routes) {
    await call("Emulation.setDeviceMetricsOverride", { width:390, height:1000, deviceScaleFactor:1, mobile:false });
    await call("Page.navigate", { url:`${origin}${route}` });
    await new Promise(resolve => setTimeout(resolve, 500));
    await until(`location.pathname === ${JSON.stringify(route)} && document.readyState === 'complete' && document.body.innerText.length > 20`);
    const mobile = await evaluate(`({page:document.documentElement.scrollWidth,viewport:innerWidth,fields:[...document.querySelectorAll('input,select,textarea')].filter(element=>element.getClientRects().length&&element.getBoundingClientRect().height<40).length})`);
    assert.ok(mobile.page <= mobile.viewport, `${route} overflows at 390px: ${mobile.page}px`);
    assert.equal(mobile.fields, 0, `${route} has undersized form fields`);
    if (route === "/vacation") {
      assert.ok(await evaluate(`document.querySelector(".search-ai input") !== null`), "vacation must offer the AI trip search");
      assert.equal(await evaluate(`document.querySelector(".search-ai form button")?.textContent.trim()`), "Find with AI");
      assert.equal(await evaluate(`document.querySelectorAll(".search-card select").length`), 3, "vacation route pickers are select, not typed-in text");
      assert.equal(await evaluate(`document.querySelectorAll(".search-card input").length`), 0, "no hidden typed-in location fields remain");
    }
    const image = await call("Page.captureScreenshot", { format:"png", captureBeyondViewport:true });
    const name = route === "/" ? "home" : route.slice(1).replaceAll("/", "-");
    await writeFile(`/tmp/umx-${name}-390.png`, Buffer.from(image.data, "base64"));
    await call("Emulation.setDeviceMetricsOverride", { width:1440, height:1000, deviceScaleFactor:1, mobile:false });
    await evaluate(`new Promise(resolve => requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    const desktopWidth = await evaluate(`document.documentElement.scrollWidth`);
    assert.ok(desktopWidth <= 1440, `${route} overflows at 1440px: ${desktopWidth}px`);
    console.log(`PASS ${route} mobile and desktop interface`);
  }
  assert.deepEqual(errors, []);
} finally { socket.close(); }
