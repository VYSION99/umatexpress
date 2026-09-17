// Run with a local dev server and Chrome --headless --remote-debugging-port=9228.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

const origin = process.env.LAUNCHER_TEST_URL || "http://127.0.0.1:5190";
const tabs = await fetch("http://127.0.0.1:9228/json").then(response => response.json());
const socket = new WebSocket(tabs.find(tab => tab.type === "page").webSocketDebuggerUrl);
await new Promise(resolve => socket.addEventListener("open", resolve, { once: true }));
let id = 0;
const pending = new Map();
const errors = [];
socket.addEventListener("message", ({ data }) => {
  const message = JSON.parse(data);
  if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.text);
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
  await call("Page.navigate", { url: origin });
  await until(`document.querySelector('.launch-grid')?.getAttribute('aria-busy') === 'false'`);
  await evaluate(`localStorage.removeItem('umatexpress.launcher.v1')`);
  await call("Page.reload");
  await until(`document.querySelector('.launch-grid')?.getAttribute('aria-busy') === 'false'`);
  for (const width of [320, 390, 768, 1440]) {
    await call("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: false });
    await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    const geometry = await evaluate(`({ viewport: innerWidth, page: document.documentElement.scrollWidth, widgets: [...document.querySelectorAll('.launch-widget')].map(e => ({x:e.getBoundingClientRect().x,width:e.getBoundingClientRect().width})), tiny: [...document.querySelectorAll('.launcher button, .launch-action')].filter(e => e.getClientRects().length && (e.getBoundingClientRect().height < 44 || e.getBoundingClientRect().width < 44)).length })`);
    assert.ok(geometry.page <= width, `Overflow at ${width}: ${geometry.page}`);
    assert.equal(geometry.widgets.length, 5);
    assert.equal(geometry.tiny, 0, `Small controls at ${width}`);
    const screenshot = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    await writeFile(`/tmp/umatexpress-launcher-${width}.png`, Buffer.from(screenshot.data, "base64"));
    console.log(`PASS responsive layout and touch targets: ${width}px`);
  }
  await click(`[...document.querySelectorAll('button')].find(e=>e.textContent.includes('Customise'))`);
  await until(`document.querySelector('dialog').open`);
  await click(`document.querySelector('.launch-customise article button[aria-pressed]:last-child')`);
  await until(`document.querySelectorAll('.launch-widget').length === 4`);
  await click(`document.querySelector('button[aria-label="Pin cinema"]')`);
  await until(`document.querySelector('.launch-widget').textContent.includes('OnlineCinema')`);
  await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await until(`!document.querySelector('dialog').open`);
  await call("Page.reload");
  await until(`document.querySelector('.launch-grid')?.getAttribute('aria-busy') === 'false'`);
  assert.equal(await evaluate(`document.querySelectorAll('.launch-widget').length`), 4);
  assert.ok(await evaluate(`document.querySelector('.launch-widget').textContent.includes('OnlineCinema')`));
  console.log("PASS hiding, pinning, Escape dismissal, persistence after reload");
  await click(`[...document.querySelectorAll('button')].find(e=>e.textContent.includes('All services'))`);
  await until(`document.querySelector('dialog').open`);
  await click(`document.querySelector('button[aria-label="Show CampusRide"]')`);
  await until(`document.querySelectorAll('.launch-widget').length === 5`);
  await evaluate(`const input = document.querySelector('input[aria-label="Filter all services"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Vacation'); input.dispatchEvent(new Event('input',{bubbles:true}));`);
  await until(`document.querySelectorAll('.launch-directory article').length === 1`);
  assert.equal(await evaluate(`document.querySelector('.launch-directory a').getAttribute('href')`), "/vacation");
  await evaluate(`document.querySelector('button[aria-label="Close"]').focus()`);
  await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  assert.ok(await evaluate(`document.querySelector('dialog').contains(document.activeElement)`));
  await click(`document.querySelector('button[aria-label="Close"]')`);
  await click(`[...document.querySelectorAll('button')].find(e=>e.textContent.includes('Customise'))`);
  await until(`document.querySelector('dialog').open`);
  await click(`document.querySelector('.launch-reset')`);
  await click(`document.querySelector('button[aria-label="Move campus later"]')`);
  await until(`document.querySelector('.launch-widget').textContent.includes('VacationRide')`);
  await click(`document.querySelector('.launch-reset')`);
  console.log("PASS restoring hidden services, search, keyboard focus containment, ordering and reset");
  assert.deepEqual(errors, [], "Browser runtime exceptions");
} finally { socket.close(); }
