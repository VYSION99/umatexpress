/** Real account, room-access and socket hooks across mounted account changes. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { rolldown } from "rolldown";
const root = fileURLToPath(new URL("..", import.meta.url));
const entry=resolve(root,"scripts/__cinema_account_review.tsx");
const source=`import React,{useState,useCallback} from 'react';import{createRoot}from'react-dom/client';import{useStudentAccount,publishStudentAccount}from'@/components/account/useStudentAccount';import{useCinemaSocket}from'@/components/cinema/useCinemaSocket';import{useCinemaRoomAccess}from'@/components/cinema/useCinemaRoomAccess';import{useCinemaCaptions}from'@/components/cinema/CinemaCaptionTranslation';
window.activeIdentity='a';window.probeSockets=[];
window.WebSocket=class{static OPEN=1;constructor(url){this.owner=window.activeIdentity;this.url=url;this.readyState=0;this.sent=[];window.probeSockets.push(this);setTimeout(()=>{if(this.owner==='b'){this.readyState=3;this.onclose?.();return;}this.readyState=1;this.onopen?.();this.onmessage?.({data:JSON.stringify({type:'chat',message:{id:'secret-a',sessionId:'private-room',senderId:'a',senderName:'A',content:'A PRIVATE ROOM SECRET',atSeconds:null,createdAt:new Date().toISOString(),sequence:1}})});},0);}send(raw){const frame=JSON.parse(raw);this.sent.push(frame);if(frame.type==='chat_message')setTimeout(()=>this.onmessage?.({data:JSON.stringify({type:'chat_ack',requestId:frame.requestId,message:{id:'echo-'+frame.requestId,sessionId:'private-room',senderId:this.owner,senderName:this.owner,content:frame.message,atSeconds:null,createdAt:new Date().toISOString(),sequence:2}})}),0);}close(){this.readyState=3;this.closed=true;setTimeout(()=>this.onclose?.(),0);}};
function Access(){const access=useCinemaRoomAccess('private-room');return <p id="room">{access.room?.title||access.error||'Checking access'}</p>;}
function Captions(){const[videoId,setVideoId]=useState('first');window.changeCaptionVideo=setVideoId;const at=useCallback(()=>12,[]);const{currentCaption}=useCinemaCaptions('caption-room',true,at,{sourceType:'UPLOAD',videoId});return <p id="caption">{currentCaption?.text||'none'}</p>;}
function Preview(){const{ready,account}=useStudentAccount();window.swapAccount=(id,verified=true)=>{window.activeIdentity=id;publishStudentAccount(id?{id,name:id,emailVerified:verified}:null);};const live=useCinemaSocket({roomId:'private-room',accountId:account?.id||'',enabled:Boolean(ready&&account)});return <><p id="identity">{account?.id||'none'}</p><p id="connection">{live.state}</p><div id="cache">{live.messages.map(m=><p key={m.id}>{m.senderId+':'+m.content}</p>)}</div><button id="send" onClick={()=>void live.sendChat('Message from B interface',null,'review-send-123').catch(()=>{})}>Send</button><Access/><Captions/></>;}createRoot(document.getElementById('root')).render(<Preview/>);`;
const build = await rolldown({ input: entry, platform: "browser", transform: { define: { "process.env.NODE_ENV": JSON.stringify("production") }, jsx: { runtime: "automatic" } }, onwarn(warning, warn) { if (warning.code !== "MODULE_LEVEL_DIRECTIVE") warn(warning); }, plugins: [{
  name: "chat-preview", resolveId(id) {
    if (id === entry) return entry;
    if (id.startsWith("@/")) { const base = resolve(root, id.slice(2)); return [base, `${base}.tsx`, `${base}.ts`].find(existsSync); }
  }, load(id) { if (id === entry) return source; },
}] });
const output = await build.generate({ format: "iife" }); const bundle = output.output.find(chunk => chunk.type === "chunk").code; await build.close();
const server=createServer(async(request,response)=>{const url=new URL(request.url,'http://localhost');response.setHeader('cache-control','no-store');if(url.pathname==='/'){response.setHeader('content-type','text/html');response.end('<div id="root"></div><script src="/bundle.js"></script>');return;}if(url.pathname==='/bundle.js'){response.setHeader('content-type','text/javascript');response.end(bundle);return;}response.setHeader('content-type','application/json');if(url.pathname.endsWith('/transcript')){const video=url.searchParams.get('video');if(video==='second')await new Promise(done=>setTimeout(done,250));response.end(JSON.stringify({privacy:{transcriptEnabled:true},segments:[{id:video,text:video,source:'UPLOAD',atSeconds:12,createdAt:new Date().toISOString()}]}));return;}if(url.pathname==='/api/auth/student'){response.end(JSON.stringify({account:{id:'a',name:'A',emailVerified:true}}));return;}if(request.headers['x-cinema-account']==='a'){response.end(JSON.stringify({room:{id:'private-room',title:'A PRIVATE ROOM TITLE',isMember:true}}));return;}await new Promise(done=>setTimeout(done,150));response.writeHead(403).end(JSON.stringify({error:'B is not a room member'}));});
const profile = await mkdtemp(resolve(tmpdir(), "cinema-chat-browser-"));
let chrome; const clients = []; let startupTimer;
try {
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  chrome = spawn(process.env.CHROME_BIN || "google-chrome", ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const endpoint = await new Promise((done, reject) => {
    let stderr = ""; startupTimer = setTimeout(() => reject(new Error(stderr.slice(-1000))), 15000);
    chrome.on("error", reject); chrome.stderr.on("data", data => { stderr += data; const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) { clearTimeout(startupTimer); done(match[1]); } });
  });
  async function connect(url) {
    const socket = new WebSocket(url), pending = new Map(); let id = 0;
    await new Promise((done, reject) => { socket.addEventListener("open", done, { once: true }); socket.addEventListener("error", reject, { once: true }); });
    socket.addEventListener("message", event => { const m = JSON.parse(event.data), p = pending.get(m.id); if (!p) return; pending.delete(m.id); clearTimeout(p.timer); if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result); });
    const client = { call(method, params = {}) { return new Promise((resolve, reject) => { const requestId = ++id, timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`Timeout: ${method}`)); }, 12000); pending.set(requestId, { resolve, reject, timer }); socket.send(JSON.stringify({ id: requestId, method, params })); }); }, close() { socket.close(); } }; clients.push(client); return client;
  }
  const browser = await connect(endpoint), origin = `http://127.0.0.1:${server.address().port}`;
  const { targetId } = await browser.call("Target.createTarget", { url: origin });
  const tabs = await (await fetch(`http://127.0.0.1:${new URL(endpoint).port}/json/list`)).json();
  const tab = await connect(tabs.find(t => t.id === targetId).webSocketDebuggerUrl);
  async function evaluate(expression) { const result = await tab.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value; }
  async function until(expression) { const end = Date.now() + 12000; while (Date.now() < end) { if (await evaluate(`Boolean(${expression})`)) return; await new Promise(done => setTimeout(done, 50)); } throw new Error(`UI check timed out: ${expression}\n${await evaluate("document.body.innerText")}`); }
  await until("document.querySelector('#identity')?.textContent==='a'&&document.querySelector('#cache')?.textContent.includes('A PRIVATE ROOM SECRET')");
  await until("document.querySelector('#room')?.textContent==='A PRIVATE ROOM TITLE'");
  await evaluate("window.swapAccount('b')"); await until("document.querySelector('#identity')?.textContent==='b'");
  assert.equal(await evaluate("document.body.textContent.includes('A PRIVATE ROOM')"),false);
  await until("window.probeSockets.length===2&&window.probeSockets[0].closed&&document.querySelector('#connection')?.textContent==='closed'");
  await until("document.querySelector('#room')?.textContent==='B is not a room member'");
  await evaluate("document.querySelector('#send').click()");
  assert.equal(await evaluate("window.probeSockets[0].sent.some(frame=>frame.type==='chat_message')"),false);
  await evaluate("window.swapAccount(null)");await until("document.querySelector('#identity')?.textContent==='none'&&window.probeSockets[0].closed");
  await evaluate("window.swapAccount('b')");await until("document.querySelector('#identity')?.textContent==='b'&&document.querySelector('#connection')?.textContent==='closed'");
  assert.equal(await evaluate("document.body.textContent.includes('A PRIVATE ROOM')"),false);
  // A later successful sign-in must reauthorize and recover, rather than
  // remaining permanently blocked by B's refusal or A's original join flag.
  await evaluate("window.swapAccount('a')");
  await until("document.querySelector('#room')?.textContent==='A PRIVATE ROOM TITLE'&&document.querySelector('#connection')?.textContent==='live'");
  await evaluate("window.swapAccount('a',false)");
  await until("document.querySelector('#room')?.textContent==='Checking access'");
  await evaluate("window.swapAccount('a',true)");
  await until("document.querySelector('#room')?.textContent==='A PRIVATE ROOM TITLE'");
  await until("document.querySelector('#caption')?.textContent==='first'");
  await evaluate("window.changeCaptionVideo('second')");
  await until("document.querySelector('#caption')?.textContent==='none'");
  await evaluate("window.changeCaptionVideo('third')");
  await until("document.querySelector('#caption')?.textContent==='third'");
  await new Promise(done=>setTimeout(done,300));
  assert.equal(await evaluate("document.querySelector('#caption').textContent"),'third', 'a delayed previous-video response must stay hidden');
  console.log('Cinema account browser checks passed: socket replacement, cache isolation, room reauthorization, refused access, sign-in recovery and caption video isolation.');
} finally {
  clearTimeout(startupTimer); clients.forEach(c => c.close()); chrome?.kill("SIGTERM");
  if (chrome && chrome.exitCode === null) await new Promise(done => { chrome.once("exit", done); setTimeout(done, 3000).unref(); });
  if (server.listening) await new Promise(done => server.close(done));
  await rm(profile, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 }).catch(error => console.error("Cleanup:", error.message));
}
