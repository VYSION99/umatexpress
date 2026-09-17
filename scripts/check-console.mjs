// Visual interaction check for the console UI. Admin auth logic is covered by the server tests.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

const origin = process.env.CONSOLE_TEST_URL || "http://127.0.0.1:5190";
const debugPort = process.env.CONSOLE_DEBUG_PORT || "9228";
const tabs = await fetch(`http://127.0.0.1:${debugPort}/json`).then(response => response.json());
const socket = new WebSocket(tabs.find(tab => tab.type === "page").webSocketDebuggerUrl);
await new Promise(resolve => socket.addEventListener("open", resolve, { once: true }));
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
    pending.set(current, message => message.error ? reject(message.error) : resolve(message.result));
    socket.send(JSON.stringify({ id: current, method, params }));
  });
}
async function evaluate(expression) {
  const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}
async function until(expression) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await evaluate(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out: ${expression}`);
}
const click = expression => evaluate(`(${expression}).click()`);
try {
  await call("Runtime.enable");
  await call("Page.enable");
  // The browser check exercises the protected page UI without reading development credentials.
  await call("Page.addScriptToEvaluateOnNewDocument", { source: `
    const realFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url === '/api/admin/auth' && (!init || !init.method || init.method === 'GET')) return Promise.resolve(new Response(JSON.stringify({authenticated:true,email:'console-test@example.com',mustChangePassword:false}),{status:200,headers:{'Content-Type':'application/json'}}));
      return realFetch(input, init);
    };
  ` });
  await call("Page.navigate", { url: `${origin}/admin` });
  await until(`document.querySelector('.console-grid')?.getAttribute('aria-busy') === 'false'`);
  await evaluate(`localStorage.removeItem('umatexpress.console.v1')`);
  await call("Page.reload");
  await new Promise(resolve => setTimeout(resolve, 700));
  await until(`document.querySelector('.console-grid')?.getAttribute('aria-busy') === 'false'`);
  for (const width of [320, 390, 768, 1440]) {
    await call("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: false });
    await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    const geometry = await evaluate(`({ page:document.documentElement.scrollWidth, widgets:document.querySelectorAll('.console-grid .launch-widget').length, tiny:[...document.querySelectorAll('.console-launcher button,.console-launcher .launch-action')].filter(e=>e.getClientRects().length&&(e.getBoundingClientRect().height<44||e.getBoundingClientRect().width<44)).length })`);
    assert.ok(geometry.page <= width, `Overflow at ${width}px`);
    assert.equal(geometry.widgets, 4);
    assert.equal(geometry.tiny, 0, `Small controls at ${width}px`);
    const screenshot = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    await writeFile(`/tmp/umatexpress-console-${width}.png`, Buffer.from(screenshot.data, "base64"));
    console.log(`PASS console layout and touch targets: ${width}px`);
  }
  await click(`[...document.querySelectorAll('button')].find(element=>element.textContent.includes('Customise'))`);
  await until(`document.querySelector('dialog').open`);
  await click(`document.querySelector('button[aria-label="Pin vacation"]')`);
  await click(`document.querySelector('.launch-customise article button[aria-pressed]:last-child')`);
  await until(`document.querySelectorAll('.console-grid .launch-widget').length === 3`);
  await call("Input.dispatchKeyEvent", { type:"keyDown", key:"Escape", code:"Escape", windowsVirtualKeyCode:27 });
  await call("Page.reload");
  await new Promise(resolve => setTimeout(resolve, 700));
  await until(`document.querySelector('.console-grid')?.getAttribute('aria-busy') === 'false'`);
  assert.equal(await evaluate(`document.querySelectorAll('.console-grid .launch-widget').length`), 3);
  assert.ok(await evaluate(`document.querySelector('.console-grid .launch-widget').textContent.includes('VacationRide')`));
  await click(`[...document.querySelectorAll('button')].find(element=>element.textContent.includes('All services'))`);
  await until(`document.querySelector('dialog').open`);
  await click(`document.querySelector('button[aria-label="Show CampusRide"]')`);
  await until(`document.querySelectorAll('.console-grid .launch-widget').length === 4`);
  await evaluate(`const input=document.querySelector('input[aria-label="Filter management services"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'security');input.dispatchEvent(new Event('input',{bubbles:true}));`);
  await until(`document.querySelectorAll('.launch-directory article').length === 1`);
  assert.equal(await evaluate(`document.querySelector('.launch-directory a').getAttribute('href')`), "/admin/change-password");
  await evaluate(`document.querySelector('button[aria-label="Close"]').focus()`);
  await call("Input.dispatchKeyEvent", { type:"keyDown", key:"Tab", code:"Tab", windowsVirtualKeyCode:9 });
  assert.ok(await evaluate(`document.querySelector('dialog').contains(document.activeElement)`));
  console.log("PASS console search, hide/restore, pinning, persistence and keyboard controls");
  assert.deepEqual(runtimeErrors, []);
} finally { socket.close(); }
