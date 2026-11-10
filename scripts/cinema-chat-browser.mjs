/** Browser integration of the real chat panel against deterministic API fixtures. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { rolldown } from "rolldown";
const root = fileURLToPath(new URL("..", import.meta.url));
const entry = resolve(root, "scripts/__cinema_chat_preview.tsx");
const source = `import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{CinemaChatPanel}from'@/components/cinema/CinemaChatPanel';import{CinemaNotes}from'@/components/cinema/CinemaNotes';import{CinemaPollsPanel}from'@/components/cinema/CinemaPollsPanel';
function Preview(){const[videoId,setVideoId]=useState('second');const[hostMode,setHostMode]=useState(false);const[pollRevision,setPollRevision]=useState(0);const[account,setAccount]=useState('self');const[share,setShare]=useState(null);const[live,setLive]=useState({state:'live',messages:[],removedChatIds:[],chatConnection:1});
window.switchVideo=value=>setVideoId(value);window.setHostMode=value=>setHostMode(value);window.refreshPolls=()=>setPollRevision(value=>value+1);window.switchAccount=id=>setAccount(id);window.reconnect=()=>setLive(p=>({...p,chatConnection:p.chatConnection+1}));window.remove=id=>setLive(p=>({...p,removedChatIds:[...p.removedChatIds,id]}));
const sendChat=async(text,timestamp,id,context)=>{const response=await fetch('/send',{method:'POST',body:JSON.stringify({text,timestamp,id,...context})});const data=await response.json();if(!response.ok)throw new Error(data.error);setLive(p=>({...p,messages:[...p.messages,data.message]}));return data.message;};
return <><CinemaNotes key={'notes:'+account} roomId="room" accountId={account} onShare={text=>setShare({id:crypto.randomUUID(),accountId:account,text,origin:'NOTE'})}/><section className="cinema-chat"><CinemaChatPanel key={'chat:'+account} roomId="room" accountId={account} canManage={hostMode} enabled preparedShare={share} onShareUsed={id=>setShare(p=>p?.id===id?null:p)} live={{...live,sendChat}} video={{sourceType:'UPLOAD',videoId}} timestamp={()=>25} canSeek onReport={()=>{}}/></section>{hostMode&&<CinemaPollsPanel roomId="room" canManage revision={pollRevision}/>}</>;}createRoot(document.getElementById('root')).render(<Preview/>);`;
const build = await rolldown({ input: entry, platform: "browser", transform: { define: { "process.env.NODE_ENV": JSON.stringify("production") }, jsx: { runtime: "automatic" } }, onwarn(warning, warn) { if (warning.code !== "MODULE_LEVEL_DIRECTIVE") warn(warning); }, plugins: [{
  name: "chat-preview", resolveId(id) {
    if (id === entry) return entry;
    if (id.startsWith("@/")) { const base = resolve(root, id.slice(2)); return [base, `${base}.tsx`, `${base}.ts`].find(existsSync); }
  }, load(id) { if (id === entry) return source; },
}] });
const output = await build.generate({ format: "iife" }); const bundle = output.output.find(chunk => chunk.type === "chunk").code; await build.close();
const messages = Array.from({ length: 65 }, (_, i) => ({ id: `message-${i + 1}`, sessionId: "room", senderId: "peer", senderName: "Ama", content: `History ${i + 1}`, sequence: i + 1, threadId: `message-${i + 1}`, atSeconds: 10, video: { sourceType: "UPLOAD", videoId: "first" }, createdAt: new Date().toISOString() }));
const sends = [], acknowledgements = new Map(), assistantJobs = new Map(), assistantCommands = []; let failFirst = true, opened;
const overviewQuestions = [], privateRequests = new Map(), privateCommands = []; let privateFailFirst = true;
const hostDrafts = new Map(), hostCommands = [], publishedPolls = []; let hostFailFirst = true, hostApplyFailFirst = true;
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  response.setHeader("cache-control", "no-store");
  if (url.pathname === "/") { response.setHeader("content-type", "text/html"); response.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><style>body{--ink:#10382a;--green:#136541;--mint:#eaf6ee;font-family:Arial,sans-serif;margin:16px}#root{max-width:680px;margin:auto}</style><div id="root"></div><script>localStorage.setItem("umatexpress.cinema.notes.v1:room","EARLIER DEVICE NOTE");</script><script src="/bundle.js"></script>'); return; }
  if (url.pathname === "/bundle.js") { response.setHeader("content-type", "text/javascript"); response.end(bundle); return; }
  if (url.pathname === "/styles.css") { response.setHeader("content-type", "text/css"); response.end(`${await readFile(resolve(root, "app/material-icons.css"), "utf8")}
${await readFile(resolve(root, "components/cinema/cinema.css"), "utf8")}`); return; }
  if (url.pathname === "/fonts/material-symbols-rounded-app.woff2") { response.setHeader("content-type", "font/woff2"); response.end(await readFile(resolve(root, "public/fonts/material-symbols-rounded-app.woff2"))); return; }
  response.setHeader("content-type", "application/json");
  if (url.pathname.endsWith("/polls")) { response.end(JSON.stringify({ polls: publishedPolls })); return; }
  if (url.pathname.endsWith("/host-assistance/sources")) {
    const job = hostDrafts.get(url.searchParams.get("request"));
    if (request.headers["x-cinema-account"] !== "self" || !job) { response.writeHead(403).end('{}'); return; }
    response.end(JSON.stringify({ source: { ...job.citations[0], text: "Evidence from the public question about force and velocity." } })); return;
  }
  if (url.pathname.endsWith("/host-assistance")) {
    if (request.headers["x-cinema-account"] !== "self") { response.writeHead(403).end('{"error":"Only current hosts can use suggestions."}'); return; }
    if (request.method === "GET") { response.end(JSON.stringify({ enabled: true, drafts: [...hostDrafts.values()] })); return; }
    let body = ""; for await (const chunk of request) body += chunk; const input = JSON.parse(body); hostCommands.push({ method: request.method, ...input });
    let job = request.method === "POST" ? [...hostDrafts.values()].find(job => job.deliveryId === input.requestId) : hostDrafts.get(input.requestId);
    if (request.method === "POST" && !job) {
      const failed = input.brief.includes("failure"), citations = [{ key: "M1", kind: "MESSAGE", id: "question-3", threadId: "question-3", atSeconds: 12 }];
      const proposal = input.kind === "POLL" ? { kind: "POLL", question: "Which topic needs another example?", options: ["Inertia", "Force"], citations: ["M1"] } : input.kind === "PROMPT" ? { kind: "PROMPT", text: "How does inertia relate to force?", citations: ["M1"] } : { kind: "MODERATION", items: [{ observation: "Repeated wording may need context.", reminder: "Please keep messages constructive.", citations: ["M1"] }] };
      job = { id: `host-${input.requestId}`, deliveryId: input.requestId, kind: input.kind, brief: input.brief, status: failed ? "FAILED" : "DONE", attempts: 1, reviewStatus: "REVIEW", resultId: "", error: failed ? "Suggestion failed. You can retry." : "", proposal: failed ? null : proposal, scope: { asOf: new Date().toISOString(), sourceCount: 3, video: input.kind === "MODERATION" || !input.linkVideo ? undefined : input.video }, citations, dependencies: ["question-3"], createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString() }; hostDrafts.set(job.id, job);
    }
    if (!job) { response.writeHead(404).end('{}'); return; }
    if (request.method === "POST") {
      if (hostFailFirst) { hostFailFirst = false; response.writeHead(503).end('{"error":"Suggestion delivery confirmation was lost. Retry the same request."}'); return; }
      response.end(JSON.stringify({ draft: job })); return;
    }
    if (input.action === "DISMISS") { hostDrafts.delete(job.id); response.end('{"deleted":true}'); return; }
    if (input.action === "RETRY" || input.action === "CANCEL") { Object.assign(job, input.action === "RETRY" ? { status: "QUEUED", attempts: 2 } : { status: "CANCELLED", error: "Suggestion cancelled." }); response.end(JSON.stringify({ draft: job })); return; }
    if (input.action === "APPLY") {
      if (job.reviewStatus !== "APPLIED") {
        job.resultId = `reviewed-public-${hostDrafts.size}`; job.reviewStatus = "APPLIED";
        if (job.kind === "POLL") publishedPolls.push({ id: job.resultId, question: input.question, options: input.options, kind: "POLL", status: "OPEN", correctIndex: -1, votes: input.options.map(() => 0), myVote: -1, createdAt: new Date().toISOString(), aiAssisted: true });
        else messages.push({ id: job.resultId, sessionId: "room", sequence: messages.at(-1).sequence + 1, senderId: "self", senderName: "You", content: input.text, threadId: job.resultId, atSeconds: null, createdAt: new Date().toISOString(), aiAssisted: true });
      }
      if (hostApplyFailFirst) { hostApplyFailFirst = false; response.writeHead(503).end('{"error":"Approval confirmation was lost. Retry to check the same action."}'); return; }
      response.end(JSON.stringify({ result: { resultId: job.resultId, kind: job.kind === "POLL" ? "POLL" : "MESSAGE" } })); return;
    }
    response.writeHead(400).end('{}'); return;
  }
  if (url.pathname.endsWith("/private-study/sources")) {
    const owner = request.headers["x-cinema-account"], job = privateRequests.get(url.searchParams.get("request"));
    if (!job || job.owner !== owner) { response.writeHead(404).end('{}'); return; }
    const citation = job.citations.find(source => source.key === url.searchParams.get("key"));
    response.end(JSON.stringify({ source: { ...citation, text: "Private evidence from the selected room message.", threadId: citation.id } })); return;
  }
  if (url.pathname.endsWith("/private-study")) {
    const owner = request.headers["x-cinema-account"];
    if (request.method === "GET") { response.end(JSON.stringify({ enabled: true, requests: [...privateRequests.values()].filter(job => job.owner === owner).map(({ owner: _owner, ...job }) => { void _owner; return job; }) })); return; }
    let body = ""; for await (const chunk of request) body += chunk; const input = JSON.parse(body);
    privateCommands.push({ method: request.method, owner, ...input });
    let job = request.method === "POST" ? [...privateRequests.values()].find(job => job.owner === owner && job.deliveryId === input.requestId) : privateRequests.get(input.requestId);
    if (request.method !== "POST" && (!job || job.owner !== owner)) { response.writeHead(404).end('{}'); return; }
    if (request.method === "DELETE") { privateRequests.delete(job.id); response.end('{"deleted":true}'); return; }
    if (request.method === "PATCH") Object.assign(job, input.action === "RETRY" ? { status: "QUEUED", attempts: 2, error: "" } : { status: "CANCELLED", error: "Request cancelled." });
    else if (!job) {
      const failed = input.question.includes("failure");
      job = { id: `private-${input.requestId}`, deliveryId: input.requestId, owner, question: input.question, anchorId: input.anchorId || "", status: failed ? "FAILED" : "DONE", attempts: 1, answer: failed ? "" : "Inertia resists changes in motion. Keep my personal example private.", citations: [{ key: "M1", kind: "MESSAGE", id: "message-2", threadId: "message-2", atSeconds: 10 }], dependencies: ["message-2"], error: failed ? "This private explanation failed. Try again." : "", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString() };
      privateRequests.set(job.id, job);
    }
    if (privateFailFirst && request.method === "POST") { privateFailFirst = false; response.writeHead(503).end('{"error":"Private delivery confirmation was lost. Retry your private question."}'); return; }
    const { owner: _owner, ...result } = job; void _owner;
    response.end(JSON.stringify({ request: result })); return;
  }
  if (url.pathname.endsWith("/assistant/sources")) {
    const job = assistantJobs.get(url.searchParams.get("job"));
    const citation = messages.find(message => message.id === job?.answerId)?.assistant?.citations.find(item => item.key === url.searchParams.get("key"));
    const original = messages.find(message => message.id === citation?.id);
    response.end(JSON.stringify({ source: { ...citation, text: original?.id === "message-1" ? "Evidence: inertia resists changes in motion." : original?.content || "", threadId: original?.threadId } })); return;
  }
  if (url.pathname.endsWith("/assistant")) {
    if (request.method === "GET") { response.end(JSON.stringify({ enabled: true, jobs: [...assistantJobs.values()] })); return; }
    let body = ""; for await (const chunk of request) body += chunk;
    const input = JSON.parse(body), question = messages.find(m => m.id === input.messageId);
    assistantCommands.push({ method: request.method, ...input });
    let job = assistantJobs.get(input.messageId);
    if (request.method === "DELETE") job = { ...job, status: "CANCELLED", error: "Request cancelled." };
    else if (input.retry) job = { ...job, status: "QUEUED", attempts: 2, error: "" };
    else if (!job) {
      job = { id: question.id, requestedBy: "self", status: question.content.includes("failure") ? "FAILED" : "DONE", attempts: 1, answerId: "", error: "" };
      if (job.status === "FAILED") job.error = "Cinema could not prepare an answer. You can retry this request.";
      else {
        job.answerId = `ai-${question.id}`;
        const mode = question.content.includes("recent conversation") ? "CATCH_UP" : question.content.includes("group repeated questions") ? "REPEATED" : question.content.includes("questions without replies") ? "UNANSWERED" : null;
        const candidates = overviewQuestions.map((message, index) => ({ key: `M${index + 1}`, kind: "MESSAGE", id: message.id, atSeconds: message.atSeconds, video: message.video, threadId: message.threadId }));
        const items = mode === "REPEATED" ? [{ text: "Meaning of inertia", citations: ["M1", "M2"] }] : mode === "UNANSWERED" ? [{ text: overviewQuestions[2].content, citations: ["M3"] }] : [{ text: "The room discussed the meaning of inertia.", citations: ["M1"] }];
        const keys = new Set(items.flatMap(item => item.citations));
        const assistant = mode ? { jobId: job.id, citations: candidates.filter(citation => keys.has(citation.key)), dependencies: overviewQuestions.map(message => message.id), overview: { mode, scope: { fromSequence: overviewQuestions[0].sequence, throughSequence: question.sequence - 1, asOf: question.createdAt, scannedMessages: 100, includedMessages: 3, limited: true, video: question.video }, totalItems: items.length, items } }
          : { jobId: job.id, citations: [{ key: "M1", kind: "MESSAGE", id: "message-1", atSeconds: 10 }] };
        messages.push({ id: job.answerId, sessionId: "room", sequence: messages.at(-1).sequence + 1, senderId: "cinema-assistant", senderName: "Cinema", content: mode === "UNANSWERED" ? "1 detected question has no direct reply recorded in this snapshot." : mode ? "Overview of recent chat." : "Inertia resists changes in motion.", parentMessageId: question.id, threadId: question.threadId, atSeconds: null, assistant, createdAt: new Date().toISOString() });
      }
    }
    assistantJobs.set(input.messageId, job); response.end(JSON.stringify({ job })); return;
  }
  if (url.pathname.endsWith("/messages")) {
    const p = url.searchParams, after = p.has("after") ? Number(p.get("after")) : undefined, before = p.has("before") ? Number(p.get("before")) : Infinity;
    const through = p.has("through") ? Number(p.get("through")) : messages.at(-1).sequence;
    const all = messages.filter(m => m.sequence <= through && m.sequence < before && (after === undefined || m.sequence > after) && (!p.has("thread") || m.threadId === p.get("thread")));
    const rows = after === undefined ? all.slice(-50) : all.slice(0, 50);
    const context = rows.map(m => messages.find(parent => parent.id === m.parentMessageId)).filter(Boolean);
    response.end(JSON.stringify({ messages: rows, context, hasMore: all.length > 50, through, before: rows[0]?.sequence || 0, after: rows.at(-1)?.sequence || after || 0 })); return;
  }
  if (url.pathname === "/send") {
    let body = ""; for await (const chunk of request) body += chunk;
    const input = JSON.parse(body); sends.push(input);
    let message = acknowledgements.get(input.id);
    if (!message) {
      const parent = messages.find(m => m.id === input.parentMessageId);
      message = { id: input.id, sessionId: "room", sequence: messages.at(-1).sequence + 1, senderId: "self", senderName: "You", content: input.text, parentMessageId: parent?.id, threadId: parent?.threadId || input.id, atSeconds: input.timestamp, video: input.video, createdAt: new Date().toISOString() };
      acknowledgements.set(input.id, message); messages.push(message);
    }
    if (failFirst) { failFirst = false; response.writeHead(503).end(JSON.stringify({ error: "Delivery confirmation was lost. Retry your message." })); return; }
    response.end(JSON.stringify({ message })); return;
  }
  if (url.pathname.endsWith("/seek")) { opened = url.pathname.split("/").at(-2); response.end('{"opened":true}'); return; }
  response.writeHead(404).end('{}');
});
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
  const click = async (label, { allowDisabled = false } = {}) => {
    if (!allowDisabled) await until(`[...document.querySelectorAll('button')].some(b=>b.textContent.trim()===${JSON.stringify(label)}&&!b.disabled)`);
    return evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}${allowDisabled ? "" : "&&!b.disabled"});if(!b)throw new Error('Missing button');b.click()})()`);
  };
  async function until(expression) { const end = Date.now() + 12000; while (Date.now() < end) { if (await evaluate(`Boolean(${expression})`)) return; await new Promise(done => setTimeout(done, 50)); } throw new Error(`UI check timed out: ${expression}\n${await evaluate("document.body.innerText")}`); }
  await until("document.querySelectorAll('.cinema-messages>li').length===50"); await click("Load older messages");
  await until("document.querySelectorAll('.cinema-messages>li').length===65");
  console.log("PASS: older history loads without replacing the latest conversation.");
  await evaluate("[...document.querySelectorAll('.cinema-messages>li')].find(n=>n.textContent.includes('History 65')).querySelector('.cinema-message-actions button').click();document.querySelector('[aria-label=\"Message the room\"]').focus()");
  await tab.call("Input.insertText", { text: "Threaded question" });
  await evaluate("document.querySelector('.cinema-chat-form').requestSubmit()"); await until("document.body.innerText.includes('Delivery confirmation was lost')");
  assert.equal(await evaluate("document.querySelector('[aria-label=\"Message the room\"]').value"), "Threaded question");
  await click("Catch up", { allowDisabled: true });
  assert.equal(await evaluate("document.querySelector('[aria-label=\"Message the room\"]').value"), "Threaded question", "overview controls must preserve the pending draft");
  await evaluate("document.querySelector('.cinema-chat-form').requestSubmit()"); await until("document.querySelector('[aria-label=\"Message the room\"]').value===''");
  assert.equal(sends.length, 2); assert.equal(sends[0].id, sends[1].id); assert.equal(sends[1].parentMessageId, "message-65"); assert.equal(messages.filter(m => m.content === "Threaded question").length, 1);
  console.log("PASS: reply context and retry identity survive a lost acknowledgement.");
  for (let i = 0; i < 75; i++) { const sequence = messages.at(-1).sequence + 1; messages.push({ ...messages[0], id: `offline-${i}`, threadId: `offline-${i}`, content: `Offline ${i}`, sequence }); }
  await evaluate("window.reconnect()"); await until("document.querySelectorAll('.cinema-messages>li').length===141");
  console.log("PASS: reconnect recovers all 75 missed messages beyond the replay window.");
  await evaluate("[...document.querySelectorAll('.cinema-messages>li')].find(n=>n.textContent.includes('Threaded question')).querySelectorAll('.cinema-message-actions button')[1].click()");
  await until("document.body.innerText.includes('Conversation thread')&&document.querySelectorAll('.cinema-messages>li').length===2");
  await evaluate("window.remove('message-65')"); await until("document.body.innerText.includes('Message removed')&&!document.querySelector('.cinema-reply-preview')?.textContent.includes('History 65')");
  console.log("PASS: threaded view removes parent text from reply previews.");
  await click("Back to room chat");
  await evaluate("document.querySelector('.cinema-timestamp').click()"); await until("!document.body.innerText.includes('Opening…')");
  assert.equal(opened, "message-1");
  console.log("PASS: video navigation targets the stored message reference.");
  assert.equal(assistantCommands.length, 0, "ordinary chat must not request AI");
  await click("Ask Cinema"); await until("document.querySelector('[aria-label=\"Message the room\"]').value==='@Cinema '");
  await evaluate("document.querySelector('[aria-label=\"Message the room\"]').focus();document.querySelector('[aria-label=\"Message the room\"]').setSelectionRange(8,8)");
  await tab.call("Input.insertText", { text: "explain inertia" });
  await evaluate("document.querySelector('.cinema-chat-form').requestSubmit()");
  await until("document.body.innerText.includes('AI-generated · Check the sources')");
  assert.equal(assistantCommands.filter(c => c.method === "POST").length, 1);
  await click("M1 · Message · 0:10"); await until("document.querySelector('[aria-label=\"Source evidence\"]')?.textContent.includes('Evidence: inertia')");
  await click("Close source");
  console.log("PASS: ordinary chat skips AI; Ask Cinema renders a labelled reply with inspectable evidence.");
  await evaluate("document.querySelector('[aria-label=\"Message the room\"]').focus()");
  await tab.call("Input.insertText", { text: "@Cinema show failure" });
  await evaluate("document.querySelector('.cinema-chat-form').requestSubmit()");
  await until("document.body.innerText.includes('Retry answer')"); await click("Retry answer");
  await until("[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Cancel request'&&!b.disabled)"); await click("Cancel request");
  await until("document.body.innerText.includes('Request cancelled.')&&!document.body.innerText.includes('Cancel request')");
  assert.ok(assistantCommands.some(c => c.retry === true)); assert.ok(assistantCommands.some(c => c.method === "DELETE"));
  console.log("PASS: failed answers can be retried and queued work can be cancelled.");
  for (const content of ["What is inertia?", "How would you define inertia?", "Why does a net force change velocity?"]) {
    const message = { id: `question-${overviewQuestions.length + 1}`, sessionId: "room", senderId: "peer", senderName: "Ama", content, sequence: messages.at(-1).sequence + 1, atSeconds: 12, video: { sourceType: "UPLOAD", videoId: "second" }, createdAt: new Date().toISOString() };
    message.threadId = message.id; messages.push(message); overviewQuestions.push(message);
  }
  await evaluate("window.reconnect()"); await until("document.body.innerText.includes('Why does a net force change velocity?')");
  async function overviewRequest(button, text, heading) {
    await until(`[...document.querySelectorAll('button')].some(b=>b.textContent.trim()===${JSON.stringify(button)}&&!b.disabled)`);
    const before = assistantCommands.length;
    const reportCount = await evaluate("document.querySelectorAll('.cinema-overview-heading').length");
    await click(button);
    await until(`document.querySelector('[aria-label="Message the room"]').value===${JSON.stringify(text)}`);
    assert.equal(assistantCommands.length, before, "overview buttons prepare a request before sending");
    await evaluate("document.querySelector('.cinema-chat-form').requestSubmit()");
    await until(`document.querySelectorAll('.cinema-overview-heading').length===${reportCount + 1}&&[...document.querySelectorAll('.cinema-overview-heading h3')].some(h=>h.textContent===${JSON.stringify(heading)})`);
  }
  await overviewRequest("Catch up", "@Cinema catch up on the recent conversation", "Catch-up summary");
  await until("document.body.innerText.includes('Earlier messages are outside this overview’s window.')");
  await overviewRequest("Repeated questions", "@Cinema group repeated questions", "Suggested question groups");
  assert.equal(await evaluate("[...document.querySelectorAll('.cinema-overview-item strong')].some(n=>n.textContent==='2 questions')"), true);
  await evaluate("[...document.querySelectorAll('.cinema-assistant-answer')].find(n=>n.querySelector('h3')?.textContent==='Suggested question groups').querySelector('.cinema-ai-sources button').click()");
  await until("document.querySelector('[aria-label=\"Source evidence\"]')?.textContent.includes('What is inertia?')");
  await click("Open conversation"); await until("document.body.innerText.includes('Conversation thread')&&document.querySelectorAll('.cinema-messages>li').length===1");
  assert.equal(await evaluate("document.querySelector('.cinema-messages').textContent.includes('What is inertia?')"), true);
  await click("Back to room chat");
  await overviewRequest("Questions without replies", "@Cinema show questions without replies", "Questions without replies");
  assert.equal(await evaluate("[...document.querySelectorAll('.cinema-assistant-answer')].find(n=>n.querySelector('h3')?.textContent==='Questions without replies').textContent.includes('Room digest · Check the sources')"), true);
  assert.equal(await evaluate("document.querySelectorAll('.cinema-overview-heading').length"), 3);
  console.log("PASS: summaries, repeated groups and reply digests show scoped snapshots and source conversations.");
  await evaluate("document.querySelector('.cinema-chat-link input').click()");
  await until("document.querySelector('.cinema-overview-controls').textContent.includes('across the room')");
  await overviewRequest("Catch up", "@Cinema catch up on the recent conversation", "Catch-up summary");
  assert.equal(sends.at(-1).video, undefined); assert.equal(sends.at(-1).timestamp, null);
  assert.equal(await evaluate("[...document.querySelectorAll('.cinema-overview-heading')].at(-1).textContent.includes('across the room')"), true);
  console.log("PASS: existing drafts are preserved and clearing the video link requests a room-wide overview.");
  await tab.call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.equal(await evaluate("document.documentElement.scrollWidth<=window.innerWidth"), true);
  const overviewImage = await tab.call("Page.captureScreenshot", { format: "png" });
  await writeFile(resolve(tmpdir(), "cinema-overview-mobile.png"), Buffer.from(overviewImage.data, "base64"));
  const beforePrivate = messages.length, sendsBeforePrivate = sends.length, roomCommandsBeforePrivate = assistantCommands.length;
  await evaluate("document.querySelector('[aria-label=\"Message the room\"]').focus()"); await tab.call("Input.insertText", { text: "Existing room draft" });
  await evaluate("[...document.querySelectorAll('.cinema-messages>li')].find(n=>n.querySelector('p')?.textContent==='History 2').querySelectorAll('.cinema-message-actions button')[2].click()");
  await until("document.querySelector('[aria-label=\"Your private Cinema question\"]')?.value.length>0");
  await evaluate("(()=>{const t=document.querySelector('[aria-label=\"Your private Cinema question\"]');t.focus();t.setSelectionRange(0,t.value.length)})()");
  await tab.call("Input.insertText", { text: "PRIVATE QUESTION: explain inertia for me" });
  await evaluate("document.querySelector('.cinema-private-form').requestSubmit()");
  await until("document.body.innerText.includes('Private delivery confirmation was lost')");
  assert.equal(await evaluate("document.querySelector('[aria-label=\"Your private Cinema question\"]').value"), "PRIVATE QUESTION: explain inertia for me");
  await evaluate("document.querySelector('.cinema-private-form').requestSubmit()"); await until("document.querySelector('[aria-label=\"Private explanation answer\"]')");
  assert.equal(privateCommands[0].requestId, privateCommands[1].requestId); assert.equal(privateRequests.size, 1);
  assert.equal(messages.length, beforePrivate); assert.equal(sends.length, sendsBeforePrivate); assert.equal(assistantCommands.length, roomCommandsBeforePrivate);
  assert.equal(await evaluate("document.querySelector('.cinema-messages').textContent.includes('PRIVATE QUESTION')"), false);
  await evaluate("document.querySelector('.cinema-private-request .cinema-ai-sources button').click()"); await until("document.querySelector('[aria-label=\"Private source evidence\"]')?.textContent.includes('Private evidence')");
  await evaluate("window.noteStoreSetter=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key.startsWith('umatexpress.cinema.notes.v2:'))throw new Error('Storage blocked');return window.noteStoreSetter.call(this,key,value)}");
  await evaluate("document.querySelector('[aria-label=\"Your private notes for this room\"]').focus()"); await tab.call("Input.insertText", { text: "UNSAVED PERSONAL NOTE" });
  await evaluate("Storage.prototype.setItem=window.noteStoreSetter");
  await click("Save explanation to my notes"); await until("document.body.innerText.includes('Your current notes have unsaved changes')");
  assert.equal(await evaluate("document.querySelector('[aria-label=\"Your private notes for this room\"]').value"), "UNSAVED PERSONAL NOTE");
  await evaluate("Storage.prototype.setItem=window.noteStoreSetter;document.querySelector('[aria-label=\"Your private notes for this room\"]').focus()"); await tab.call("Input.insertText", { text: " RECOVERED" });
  await click("Save explanation to my notes"); await until("document.querySelector('[aria-label=\"Your private notes for this room\"]').value.includes('PRIVATE QUESTION')");
  const excerpt = "Inertia resists changes in motion.";
  await evaluate(`(()=>{const t=document.querySelector('[aria-label="Private explanation answer"]');t.focus();t.setSelectionRange(0,${excerpt.length});t.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));document.dispatchEvent(new Event('selectionchange'))})()`);
  await until("[...document.querySelectorAll('button')].some(b=>b.textContent==='Review selected explanation for sharing'&&!b.disabled)");
  await click("Review selected explanation for sharing"); await until("document.querySelector('[aria-label=\"Excerpt to share with the room\"]')");
  assert.equal(await evaluate("document.querySelector('[aria-label=\"Excerpt to share with the room\"]').value"), `Shared AI explanation: ${excerpt}`);
  assert.equal(await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='Use excerpt in composer').disabled"), true);
  assert.equal(await evaluate("document.querySelector('[aria-label=\"Message the room\"]').value"), "Existing room draft");
  await click("Keep it private"); assert.equal(sends.length, sendsBeforePrivate);
  await evaluate("(()=>{const t=document.querySelector('[aria-label=\"Message the room\"]');t.focus();t.setSelectionRange(0,t.value.length)})()");
  await tab.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 }); await tab.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
  await until("document.querySelector('[aria-label=\"Message the room\"]').value===''");
  await click("Review selected explanation for sharing"); await click("Use excerpt in composer");
  await until(`document.querySelector('[aria-label="Message the room"]').value===${JSON.stringify(`Shared AI explanation: ${excerpt}`)}`);
  assert.equal(sends.length, sendsBeforePrivate, "preparing an excerpt must not send it");
  await evaluate("document.querySelector('.cinema-chat-form').requestSubmit()"); await until("document.querySelector('[aria-label=\"Message the room\"]').value===''");
  assert.equal(sends.at(-1).text, `Shared AI explanation: ${excerpt}`); assert.equal(sends.at(-1).text.includes('personal example'), false); assert.equal(sends.at(-1).text.includes('PRIVATE QUESTION'), false);
  console.log("PASS: private requests preserve retry identity, stay out of room history, and share only a reviewed selection after Send.");
  await click("Review earlier device notes"); await until("document.querySelector('[aria-label=\"Earlier device notes\"]')?.value==='EARLIER DEVICE NOTE'");
  assert.equal(await evaluate("document.querySelector('[aria-label=\"Your private notes for this room\"]').value.includes('EARLIER DEVICE NOTE')"), false);
  await click("Copy earlier notes into my page"); await until("document.querySelector('[aria-label=\"Your private notes for this room\"]').value.includes('EARLIER DEVICE NOTE')");
  const noteExcerpt = "Personal note: force changes momentum.";
  await evaluate("(()=>{const t=document.querySelector('[aria-label=\"Your private notes for this room\"]');t.focus();t.setSelectionRange(0,t.value.length)})()");
  await tab.call("Input.insertText", { text: `${noteExcerpt} KEEP THIS DETAIL PRIVATE` });
  await evaluate(`(()=>{const t=document.querySelector('[aria-label="Your private notes for this room"]');t.focus();t.setSelectionRange(0,${noteExcerpt.length});t.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));document.dispatchEvent(new Event('selectionchange'))})()`);
  await until("[...document.querySelectorAll('button')].some(b=>b.textContent==='Review selected note for sharing'&&!b.disabled)");
  await click("Review selected note for sharing"); await until("document.querySelector('[aria-label=\"Excerpt to share with the room\"]')");
  assert.equal(await evaluate("document.querySelector('[aria-label=\"Excerpt to share with the room\"]').value"), noteExcerpt);
  const beforeNoteShare = sends.length; await click("Use excerpt in composer"); assert.equal(sends.length, beforeNoteShare);
  await evaluate("document.querySelector('.cinema-chat-form').requestSubmit()"); await until("document.querySelector('[aria-label=\"Message the room\"]').value===''"); assert.equal(sends.at(-1).text, noteExcerpt);
  await evaluate("window.switchAccount('other')"); await until("document.querySelector('[aria-label=\"Your private notes for this room\"]').value===''"); await click("Open private study");
  await until("document.querySelector('.cinema-private-study')&&document.querySelectorAll('.cinema-private-request').length===0");
  assert.equal(await evaluate("document.querySelector('.cinema-private-study').textContent.includes('PRIVATE QUESTION')"), false);
  assert.equal(await evaluate("document.querySelector('[aria-label=\"Your private notes for this room\"]').value.includes('KEEP THIS DETAIL')"), false);
  await evaluate("window.switchAccount('self')"); await until("document.querySelector('[aria-label=\"Your private notes for this room\"]').value.includes('KEEP THIS DETAIL PRIVATE')"); await click("Open private study");
  await until("document.querySelector('[aria-label=\"Private explanation answer\"]')"); await click("Delete private request"); await until("document.querySelectorAll('.cinema-private-request').length===0");
  await until("document.querySelector('[aria-label=\"Your private Cinema question\"]')&&!document.querySelector('[aria-label=\"Your private Cinema question\"]').disabled");
  await evaluate("document.querySelector('[aria-label=\"Your private Cinema question\"]').focus()"); await tab.call("Input.insertText", { text: "Private failure question" });
  await evaluate("document.querySelector('.cinema-private-form').requestSubmit()"); await until("document.body.innerText.includes('Retry private explanation')"); await click("Retry private explanation");
  await until("[...document.querySelectorAll('button')].some(b=>b.textContent==='Cancel private request'&&!b.disabled)"); await click("Cancel private request"); await until("document.body.innerText.includes('Request cancelled.')&&!document.body.innerText.includes('Cancel private request')");
  await until("[...document.querySelectorAll('button')].some(b=>b.textContent==='Delete private request'&&!b.disabled)"); await click("Delete private request"); await until("document.querySelectorAll('.cinema-private-request').length===0");
  console.log("PASS: device notes require explicit legacy import, stay separate by account, and private jobs support retry, cancel and delete.");
  await until("document.querySelector('[aria-label=\"Your private Cinema question\"]')&&!document.querySelector('[aria-label=\"Your private Cinema question\"]').disabled");
  await evaluate("document.querySelector('[aria-label=\"Your private Cinema question\"]').focus()"); await tab.call("Input.insertText", { text: "Explain inertia privately again" });
  await evaluate("document.querySelector('.cinema-private-form').requestSubmit()"); await until("document.querySelector('[aria-label=\"Private explanation answer\"]')");
  await evaluate("window.remove('message-2')"); await until("!document.querySelector('[aria-label=\"Private explanation answer\"]')&&document.querySelector('.cinema-private-request').textContent.includes('source was removed')");
  await click("Close private study");
  console.log("PASS: removing a room source immediately hides its cached private explanation.");
  assert.equal(await evaluate("[...document.querySelectorAll('button')].some(b=>b.textContent==='Open host assistant')"), false);
  await evaluate("window.setHostMode(true)"); await click("Open host assistant");
  await until("[...document.querySelectorAll('button')].some(b=>b.textContent==='Suggest for my review'&&!b.disabled)");
  const beforeHostMessages = messages.length;
  await evaluate("document.querySelector('[aria-label=\"Host suggestion brief\"]').focus()"); await tab.call("Input.insertText", { text: "Host brief: help participants choose a topic" });
  await evaluate("document.querySelector('.cinema-host-request').requestSubmit()"); await until("document.body.innerText.includes('Suggestion delivery confirmation was lost')");
  assert.equal(await evaluate("document.querySelector('[aria-label=\"Host suggestion brief\"]').value"), "Host brief: help participants choose a topic");
  await evaluate("document.querySelector('.cinema-host-request').requestSubmit()"); await until("document.querySelector('[aria-label=\"Reviewed poll question\"]')&&!document.querySelector('[aria-label=\"Reviewed poll question\"]').disabled");
  assert.equal(hostCommands[0].requestId, hostCommands[1].requestId); assert.equal(hostDrafts.size, 1); assert.equal(publishedPolls.length, 0); assert.equal(messages.length, beforeHostMessages);
  await evaluate("window.switchVideo('third')"); await until("document.querySelector('.cinema-host-review').textContent.includes('earlier video selection')");
  await evaluate("document.querySelector('[aria-label=\"Host assistant\"]').scrollIntoView({block:'start'})");
  const hostImage = await tab.call("Page.captureScreenshot", { format: "png" });
  await writeFile(resolve(tmpdir(), "cinema-host-assistant-mobile.png"), Buffer.from(hostImage.data, "base64"));
  await evaluate("window.switchVideo('second')");
  await evaluate("document.querySelector('[aria-label=\"Reviewed poll question\"]').focus();document.querySelector('[aria-label=\"Reviewed poll question\"]').select()"); await tab.call("Input.insertText", { text: "Which topic should we revisit together?" });
  await click("M1 · Source"); await until("document.querySelector('[aria-label=\"Host source evidence\"]')?.textContent.includes('public question')"); await click("Close host source");
  await click("Open reviewed poll"); await until("document.body.innerText.includes('Approval confirmation was lost')"); assert.equal(publishedPolls.length, 1);
  await click("Open reviewed poll"); await until("document.body.innerText.includes('Applied after your review.')"); assert.equal(publishedPolls.length, 1); assert.equal(publishedPolls[0].question, "Which topic should we revisit together?");
  await evaluate("window.refreshPolls()"); await until("document.querySelector('.cinema-poll-list')?.textContent.includes('AI-assisted · Host reviewed')");
  assert.equal(messages.length, beforeHostMessages);
  console.log("PASS: host drafts preserve delivery identity, require edited approval, and open one labelled poll after a lost acknowledgement.");
  const chooseHostKind = async kind => { await until("!document.querySelector('[aria-label=\"Host suggestion type\"]').disabled"); return evaluate(`(()=>{const s=document.querySelector('[aria-label="Host suggestion type"]');s.value=${JSON.stringify(kind)};s.dispatchEvent(new Event('change',{bubbles:true}))})()`); };
  await chooseHostKind("PROMPT"); await evaluate("document.querySelector('.cinema-host-request').requestSubmit()"); await until("document.querySelector('[aria-label=\"Reviewed discussion prompt\"]')&&!document.querySelector('[aria-label=\"Reviewed discussion prompt\"]').disabled");
  assert.equal(messages.length, beforeHostMessages);
  await evaluate("document.querySelector('[aria-label=\"Reviewed discussion prompt\"]').focus();document.querySelector('[aria-label=\"Reviewed discussion prompt\"]').select()"); await tab.call("Input.insertText", { text: "Reviewed prompt: explain how force changes motion." });
  await click("Post reviewed prompt"); await until("document.querySelector('.cinema-messages').textContent.includes('Reviewed prompt: explain how force changes motion.')");
  assert.equal(messages.at(-1).aiAssisted, true); assert.equal(messages.length, beforeHostMessages + 1);
  await chooseHostKind("MODERATION"); await evaluate("document.querySelector('.cinema-host-request').requestSubmit()"); await until("document.querySelector('[aria-label=\"Reviewed room reminder 1\"]')&&!document.querySelector('[aria-label=\"Reviewed room reminder 1\"]').disabled");
  assert.equal(messages.length, beforeHostMessages + 1); assert.equal(messages.find(message => message.id === "question-3").content, "Why does a net force change velocity?");
  await evaluate("document.querySelector('[aria-label=\"Reviewed room reminder 1\"]').focus();document.querySelector('[aria-label=\"Reviewed room reminder 1\"]').select()"); await tab.call("Input.insertText", { text: "Reviewed reminder: keep the discussion constructive." });
  await click("Post reviewed reminder"); await until("document.querySelector('.cinema-messages').textContent.includes('Reviewed reminder: keep the discussion constructive.')"); assert.equal(messages.length, beforeHostMessages + 2);
  console.log("PASS: prompts and moderation reminders remain host-only drafts until explicit review and posting.");
  await chooseHostKind("POLL"); await evaluate("document.querySelector('[aria-label=\"Host suggestion brief\"]').focus()"); await tab.call("Input.insertText", { text: "Host failure request" });
  await evaluate("document.querySelector('.cinema-host-request').requestSubmit()"); await until("document.body.innerText.includes('Retry suggestion')"); await click("Retry suggestion"); await click("Cancel suggestion");
  await until("document.body.innerText.includes('Suggestion cancelled.')"); await click("Dismiss suggestion"); await until("document.querySelectorAll('.cinema-host-draft').length===3");
  await chooseHostKind("PROMPT"); await evaluate("document.querySelector('.cinema-host-request').requestSubmit()"); await until("document.querySelectorAll('.cinema-host-draft').length===4");
  await evaluate("window.remove('question-3')"); await until("!document.querySelector('[aria-label=\"Reviewed discussion prompt\"]')");
  assert.equal(messages.length, beforeHostMessages + 2); assert.equal(publishedPolls.length, 1);
  await evaluate("window.setHostMode(false)"); await until("!document.querySelector('[aria-label=\"Host assistant\"]')");
  console.log("PASS: host suggestions support retries, cancellation and dismissal; removed evidence blocks cached draft actions.");
  await evaluate("window.remove('question-2')");
  await until("document.querySelectorAll('.cinema-overview-heading').length===0");
  console.log("PASS: removing an uncited input hides dependent overviews immediately.");
  await evaluate("window.remove('message-1')");
  await until("![...document.querySelectorAll('.cinema-assistant-answer')].some(n=>n.textContent.includes('Inertia resists changes in motion.'))&&document.body.innerText.includes('This Cinema reply is unavailable')");
  console.log("PASS: removing cited evidence hides the cached AI answer immediately.");
  await tab.call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.equal(await evaluate("document.documentElement.scrollWidth<=window.innerWidth"), true);
  const screenshot = await tab.call("Page.captureScreenshot", { format: "png" });
  await writeFile(resolve(tmpdir(), "cinema-chat-mobile.png"), Buffer.from(screenshot.data, "base64"));
  console.log("PASS: mobile chat fits the viewport; screenshot: /tmp/cinema-chat-mobile.png");
} finally {
  clearTimeout(startupTimer); clients.forEach(c => c.close()); chrome?.kill("SIGTERM");
  if (chrome && chrome.exitCode === null) await new Promise(done => { chrome.once("exit", done); setTimeout(done, 3000).unref(); });
  if (server.listening) await new Promise(done => server.close(done));
  await rm(profile, { recursive: true, force: true });
}
