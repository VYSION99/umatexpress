/** Local browser integration: synthetic devices, two isolated tabs, real WebRTC. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import ts from "typescript";

const root = fileURLToPath(new URL("..", import.meta.url));
const profile = await mkdtemp(resolve(tmpdir(), "cinema-media-browser-"));
const html = `<!doctype html><title>Cinema media integration</title><script type="module">
import { CinemaMeshAdapter } from '/lib/cinema-engine/mesh-media';
import { CinemaMediaController } from '/lib/cinema-engine/media-controller';
window.outbox=[]; window.errors=[]; window.snapshot={};
window.start = id => {
 const adapter = new CinemaMeshAdapter({ selfId:id, policy:{voice:true,camera:true,iceServers:[]},
 send:message=>outbox.push(message), onChange:state=>window.snapshot=state,
 onDevice:(kind,active)=>controller.syncDevice(kind,active) });
 const controller = new CinemaMediaController(adapter,error=>errors.push(String(error)));
 window.adapter=adapter; window.controller=controller; adapter.setMembers(['a','b']);
};
window.metrics = async () => {
 const stats = [];
 for (const peer of adapter.peers.values()) {
  const reports=await peer.pc.getStats(); const inbound=[];
  reports.forEach(r=>{if(r.type==='inbound-rtp')inbound.push({kind:r.kind,bytes:r.bytesReceived||0});});
  stats.push({generation:peer.id,state:peer.pc.connectionState,inbound});
 }
 return {stats,errors,devices:snapshot.devices,mic:snapshot.micOn,camera:snapshot.cameraOn,
 remote:Object.values(snapshot.remote).map(s=>s.getTracks().map(t=>t.kind))};
};
window.ready=true;
</script>`;
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, "http://localhost").pathname;
    if (path === "/") { response.setHeader("content-type", "text/html"); response.end(html); return; }
    if (!["/lib/cinema-engine/mesh-media", "/lib/cinema-engine/media-controller"].includes(path)) { response.writeHead(404).end(); return; }
    const source = await readFile(resolve(root, `.${path}.ts`), "utf8");
    response.setHeader("content-type", "text/javascript");
    response.end(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
  } catch (error) { response.writeHead(500).end(String(error)); }
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const chrome = spawn(process.env.CHROME_BIN || "google-chrome", [
  "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
  "--autoplay-policy=no-user-gesture-required", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });
const clients = [];
let startupTimer;
try {
  const endpoint = await new Promise((done, reject) => {
    let stderr = "";
    startupTimer = setTimeout(() => reject(new Error(`Chrome did not start: ${stderr.slice(-1000)}`)), 15000);
    chrome.on("error", reject);
    chrome.stderr.on("data", data => {
      stderr += data;
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(startupTimer); done(match[1]); }
    });
    chrome.on("exit", code => reject(new Error(`Chrome exited ${code}: ${stderr.slice(-1000)}`)));
  });
  async function connect(url) {
    const socket = new WebSocket(url), pending = new Map(); let seq = 0;
    await new Promise((done, reject) => { socket.addEventListener("open", done, { once: true }); socket.addEventListener("error", reject, { once: true }); });
    socket.addEventListener("message", event => {
      const message = JSON.parse(event.data), call = pending.get(message.id);
      if (!call) return;
      pending.delete(message.id); clearTimeout(call.timer);
      if (message.error) call.reject(new Error(JSON.stringify(message.error))); else call.resolve(message.result);
    });
    const client = {
      call(method, params = {}) { return new Promise((resolve, reject) => {
        const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)); }, 12000);
        pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
      }); },
      close() { for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error("Browser closing")); } pending.clear(); socket.close(); },
    };
    clients.push(client); return client;
  }
  const browser = await connect(endpoint);
  const port = new URL(endpoint).port;
  async function tab() {
    const { targetId } = await browser.call("Target.createTarget", { url: origin });
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    return connect(targets.find(target => target.id === targetId).webSocketDebuggerUrl);
  }
  const tabs = [await tab(), await tab()];
  async function evaluate(tab, expression) {
    const result = await tab.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async function relay() {
    for (let i = 0; i < 2; i++) {
      const messages = await evaluate(tabs[i], "outbox.splice(0)");
      for (const message of messages) if (message.type === "signal") await evaluate(tabs[1 - i], `adapter.receive(${JSON.stringify(i ? "b" : "a")},${JSON.stringify(message.payload)})`);
    }
  }
  async function until(check, label, pump = true) {
    const end = Date.now() + 18000;
    let last;
    while (Date.now() < end) {
      if (pump) await relay();
      last = await check(); if (last) return;
      await new Promise(done => setTimeout(done, 75));
    }
    const metrics = await Promise.all(tabs.map(tab => evaluate(tab, "typeof metrics==='function'?metrics():null")));
    throw new Error(`${label} timed out: ${JSON.stringify(metrics)}`);
  }
  await until(async () => (await Promise.all(tabs.map(tab => evaluate(tab, "window.ready===true")))).every(Boolean), "module load", false);
  await Promise.all(tabs.map((tab, i) => evaluate(tab, `start(${JSON.stringify(i ? "b" : "a")});Promise.all([controller.setDevice('audio',true),controller.setDevice('video',true)])`)));
  const mediaFlows = async () => (await Promise.all(tabs.map(tab => evaluate(tab, "metrics()")))).every(m =>
    m.stats.some(p => p.state === "connected" && ["audio", "video"].every(kind => p.inbound.some(r => r.kind === kind && r.bytes > 0)))
    && m.remote.some(kinds => kinds.length === 2 && kinds.includes("audio") && kinds.includes("video")) && m.errors.length === 0);
  await until(mediaFlows, "two-way camera and microphone");
  console.log("PASS: both tabs received real audio and video packets after simultaneous offers.");
  await evaluate(tabs[0], "controller.mute()");
  assert.equal((await evaluate(tabs[0], "metrics()")).mic, false);
  assert.equal((await evaluate(tabs[1], "metrics()")).mic, true);
  await evaluate(tabs[0], "controller.setDevice('audio',true)");
  console.log("PASS: microphone mute and resume stayed independent between participants.");
  const previous = (await evaluate(tabs[0], "metrics()")).stats[0].generation;
  await evaluate(tabs[0], "adapter.reconnect()");
  await until(mediaFlows, "media recovery after replacing a peer");
  assert.notEqual((await evaluate(tabs[0], "metrics()")).stats[0].generation, previous);
  console.log("PASS: replacing a peer connection restored two-way media.");
  const released = await Promise.all(tabs.map(tab => evaluate(tab, "(() => { const tracks=snapshot.localStream?.getTracks()||[]; controller.dispose(); return tracks.length===2 && tracks.every(t=>t.readyState==='ended'); })()")));
  assert.ok(released.every(Boolean));
  console.log("PASS: leaving released the synthetic camera and microphone.");
} finally {
  clearTimeout(startupTimer);
  for (const client of clients) client.close();
  chrome.kill("SIGTERM");
  await new Promise(done => { if (chrome.exitCode !== null) done(); else { chrome.once("exit", done); setTimeout(done, 3000).unref(); } });
  await new Promise(done => server.close(done));
  await rm(profile, { recursive: true, force: true });
}
