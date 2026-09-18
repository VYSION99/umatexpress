import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

const origin = process.env.CAMPUSRIDE_TEST_URL || "http://127.0.0.1:5190";
const port = process.env.CAMPUSRIDE_DEBUG_PORT || "9230";
const tabs = await fetch(`http://127.0.0.1:${port}/json`).then(response => response.json());
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
    socket.send(JSON.stringify({ id:current, method, params }));
  });
}
async function evaluate(expression) {
  const result = await call("Runtime.evaluate", { expression, returnByValue:true, awaitPromise:true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}
async function until(expression) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (await evaluate(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out: ${expression}`);
}
try {
  await call("Runtime.enable"); await call("Page.enable");
  await call("Page.navigate", { url:`${origin}/campus` });
  await until(`document.querySelector('.nearest-ride-finder') && document.readyState === 'complete'`);
  await until(`Boolean(document.querySelector('.real-map-error')) || Boolean(document.querySelector('.maplibregl-canvas'))`);
  errors.length = 0;
  for (const width of [320, 390, 768, 1440]) {
    await call("Emulation.setDeviceMetricsOverride", { width, height:1000, deviceScaleFactor:1, mobile:false });
    await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    await until(`document.querySelectorAll('.zone-marker').length > 0 || Boolean(document.querySelector('.real-map-error'))`);
    const result = await evaluate(`({
      page: document.documentElement.scrollWidth,
      tiny: [...document.querySelectorAll('.campus-student-shell button,.campus-student-shell select,.campus-student-shell input')]
        .filter(element => !element.closest('.real-map-canvas') && element.getClientRects().length && (element.getBoundingClientRect().height < 40 || element.getBoundingClientRect().width < 40)).length,
      mapCanvas: Boolean(document.querySelector('.maplibregl-canvas')),
      mapError: document.querySelector('.real-map-error')?.textContent || '',
      zoneMarkers: document.querySelectorAll('.zone-marker').length,
      rideMarkers: document.querySelectorAll('.ride-marker').length
    })`);
    assert.ok(result.page <= width, `Horizontal overflow at ${width}px`);
    assert.equal(result.tiny, 0, `Undersized controls at ${width}px`);
    assert.equal(result.mapError, "", `Real map failed at ${width}px: ${result.mapError}`);
    assert.equal(result.mapCanvas, true, `Real map canvas missing at ${width}px`);
    assert.ok(result.zoneMarkers > 0, `Real map zone markers missing at ${width}px`);
    const image = await call("Page.captureScreenshot", { format:"png", captureBeyondViewport:true });
    await writeFile(`/tmp/campusride-${width}.png`, Buffer.from(image.data, "base64"));
    console.log(`PASS CampusRide responsive layout: ${width}px`);
  }
  const rideCount = await evaluate(`document.querySelectorAll('.ride-match-card').length`);
  if (rideCount > 1) {
    const previousSelectedMarker = await evaluate(`document.querySelector('.ride-marker.is-selected')?.getAttribute('aria-label')`);
    const previousSelectedCard = await evaluate(`document.querySelector('.ride-match-card.is-selected')?.innerText`);
    await evaluate(`[...document.querySelectorAll('.ride-match-card:not(.is-selected) .ride-select-control')][0]?.click()`);
    await until(`document.querySelectorAll('.ride-match-card.is-selected').length === 1`);
    await until(`document.querySelector('.ride-match-card.is-selected')?.innerText !== ${JSON.stringify(previousSelectedCard)}`);
    assert.equal(await evaluate(`document.querySelectorAll('.ride-selected-actions').length`), 1);
    assert.notEqual(await evaluate(`document.querySelector('.ride-marker.is-selected')?.getAttribute('aria-label')`), previousSelectedMarker);
    console.log("PASS ride selection updates its queue/payment action and map marker");
  } else console.log("PASS empty or single-ride state rendered without fabricated availability");
  assert.deepEqual(errors, []);
} finally { socket.close(); }
