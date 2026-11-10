/** Local UI regressions: account isolation, poll drafts, upload recovery, references and responsive captions. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { rolldown } from "rolldown";
const root = fileURLToPath(new URL("..", import.meta.url));
const entry=resolve(root,"scripts/__cinema_ui_preview.tsx");
const fixture={id:'ui-room',hostStudentId:'host',hostName:'Ama',title:'Engineering study group',stableRoomId:'stable-ui-room',eventSlug:'',sourceType:'YOUTUBE',videoId:'dQw4w9WgXcQ',status:'LIVE',joinLocked:false,visibility:'PRIVATE',isPrivate:true,isHost:true,isMember:true,currentRole:'HOST',waitingRoomEnabled:false,discussionMode:false,managedStage:false,stageLimit:6,waitingState:'',startsAt:'',endsAt:'',durationMinutes:0,invited:true,participants:[{studentId:'host',displayName:'Ama',role:'HOST'}],createdAt:new Date().toISOString()};
const source=`import React,{useState} from 'react';import{CinemaStudyPanel}from'@/components/cinema/CinemaStudyPanel';import{CinemaRoomPlansPage}from'@/components/cinema/CinemaRoomPlansPage';import{CinemaJaasStage}from'@/components/cinema/CinemaJaasStage';import{createRoot}from'react-dom/client';import{CinemaLobby}from'@/components/cinema/CinemaLobby';import{publishStudentAccount}from'@/components/account/useStudentAccount';import{CinemaRoom}from'@/components/cinema/CinemaRoom';import{UploadPanel}from'@/components/cinema/UploadPanel';import{CinemaPollsPanel}from'@/components/cinema/CinemaPollsPanel';import{CinemaTranscriptPanel}from'@/components/cinema/CinemaTranscriptPanel';
window.frames=[];window.errors=[];window.addEventListener('error',e=>window.errors.push(String(e.message)));window.addEventListener('unhandledrejection',e=>window.errors.push(String(e.reason)));
window.switchLobbyAccount=async()=>{await fetch('/switch-account');publishStudentAccount({id:'second',name:'Second',email:'second@st.umat.edu.gh',emailVerified:true});};const room=${JSON.stringify(fixture)};window.WebSocket=class{static OPEN=1;constructor(){window.receiveRoomFrame=frame=>this.onmessage?.({data:JSON.stringify(frame)});this.readyState=0;setTimeout(()=>{this.readyState=1;this.onopen?.();for(const frame of[{type:'presence',members:[{studentId:'host',displayName:'Ama',role:'HOST',isHost:true,since:Date.now(),mic:false,camera:false,handRaised:false}]},{type:'state',playback:{positionSeconds:12,isPlaying:false,updatedAt:Date.now(),durationSeconds:300},serverAt:Date.now()},{type:'chat',message:{id:'message-1',sessionId:room.id,sequence:1,senderId:'guest',senderName:'Kojo',content:'Can someone explain how momentum changes?',createdAt:new Date().toISOString(),atSeconds:12,video:{sourceType:'YOUTUBE',videoId:room.videoId}}}])this.onmessage?.({data:JSON.stringify(frame)});},10);}send(raw){const frame=JSON.parse(raw);window.frames.push(frame);if(frame.type==='ping')this.onmessage?.({data:JSON.stringify({type:'pong',at:Date.now(),sentAt:frame.sentAt})});}close(){this.readyState=3;this.onclose?.();}};
function StudyPreview(){const[enabled,setEnabled]=useState(true);const[revision,setRevision]=useState(0);window.setStudyConsent=setEnabled;window.refreshStudy=()=>setRevision(value=>value+1);const test=new URLSearchParams(location.search).get('test')||'retry';return <CinemaStudyPanel roomId={'study-'+test} aiEnabled={enabled} roomEnded={!test.startsWith('cached')} canGenerate canSeek revision={revision} video={{sourceType:'YOUTUBE',videoId:'current-video'}} onSeek={(seconds,video)=>{window.lastSeek={seconds,video};}}/>;}const mode=new URLSearchParams(location.search).get('mode');
window.sdkRequests=0;
if(mode==='stage'){
  const append=document.head.appendChild.bind(document.head);
  document.head.appendChild=node=>{
    if(node.dataset?.cinemaJaas==='true'){
      const attempt=++window.sdkRequests;
      node.removeAttribute('src');
      setTimeout(()=>{
        if(attempt===1){node.dispatchEvent(new Event('error'));return;}
        window.JitsiMeetExternalAPI=class{
          constructor(){this.frame=document.createElement('iframe');}
          getIFrame(){return this.frame;}
          addListener(event,listener){if(event==='videoConferenceJoined')setTimeout(listener,0);}
          removeListener(){} executeCommand(){} dispose(){}
        };
        node.dispatchEvent(new Event('load'));
      },30);
    }
    return append(node);
  };
}
createRoot(document.getElementById('root')).render(<main className="campus-shell">{mode==='stage'?<CinemaJaasStage roomId='ui-room' active send={()=>true}/>:mode==='resume'?<UploadPanel roomId='resume-room' isPrivate onUploaded={()=>{window.uploadResumed=true;}}/>:mode==='pricing'?<CinemaRoomPlansPage/>:mode==='study'?<StudyPreview/>:mode==='lobby'?<CinemaLobby/>:mode==='upload'?<UploadPanel roomId="ui-room" isPrivate onUploaded={()=>{}}/>:mode==='polls'?<CinemaPollsPanel roomId="ui-room" canManage/>:mode==='transcript'?<CinemaTranscriptPanel roomId="ui-room" video={{sourceType:'YOUTUBE',videoId:'current-video'}} isHost active canSeek atSeconds={()=>12} onSeek={(seconds,video)=>{window.lastSeek={seconds,video};}}/>:<CinemaRoom initialRoom={room}/>}</main>);`;
const build = await rolldown({ input: entry, platform: "browser", transform: { define: { "process.env.NODE_ENV": JSON.stringify("production") }, jsx: { runtime: "automatic" } }, onwarn(warning, warn) { if (warning.code !== "MODULE_LEVEL_DIRECTIVE") warn(warning); }, plugins: [{
  name: "chat-preview", resolveId(id) {
    if (id === entry) return entry;
    if(id==='next/link')return '\0link';
    if(id==='next/navigation')return '\0navigation';
    if(id.endsWith('.css'))return '\0css';
    if(id.endsWith('/YouTubePlayer')||id==='./YouTubePlayer')return '\0player';
    if (id.startsWith("@/")) { const base = resolve(root, id.slice(2)); return [base, `${base}.tsx`, `${base}.ts`].find(existsSync); }
  }, load(id) { if (id === entry) return source;if(id==='\0css')return '';if(id==='\0link')return "import React from 'react';export default function Link(props){return React.createElement('a',props)}";if(id==='\0navigation')return 'export const useRouter=()=>({push:()=>{},refresh:()=>{}});export const usePathname=()=>location.pathname;';if(id==='\0player')return "import React from 'react';export function YouTubePlayer(){return React.createElement('div',{style:{aspectRatio:'16/9',background:'#13271d',display:'grid',placeItems:'center',color:'white'}},'Video player · inspection fixture')}"; },
}] });
const output = await build.generate({ format: "iife" }); const bundle = output.output.find(chunk => chunk.type === "chunk").code; await build.close();
const css=(await Promise.all(['app/globals.css','app/palette.css','app/material-icons.css','app/bottom-sheet.css','components/cinema/cinema.css'].map(path=>readFile(resolve(root,path),'utf8')))).join('\n');
let secondAccount=false,unfinishedUpload=true,cancelFails=true,pollFails=true;const cancellations=[];const studyAttempts=new Map();let cachedStudy=true,holdStudyRead=false,releaseStudyRead,studyExpiry;
let pricingAccountProbe=false, resumableUpload=null;
const attemptedParts=[], completionRequests=[];
const studyChapters=[{title:'Previous video chapter',sourceKey:'TRANSCRIPT:old',atSeconds:12,summary:'Previous video',video:{sourceType:'YOUTUBE',videoId:'M7lc1UVf-VE'}},{title:'Unknown video chapter',sourceKey:'TRANSCRIPT:legacy',atSeconds:13,summary:'Legacy video'},{title:'Current video chapter',sourceKey:'TRANSCRIPT:current',atSeconds:14,summary:'Current video',video:{sourceType:'YOUTUBE',videoId:fixture.videoId}}];
const server=createServer(async(request,response)=>{
const url=new URL(request.url,'http://localhost');response.setHeader('cache-control','no-store');
if(url.pathname==='/'){response.setHeader('content-type','text/html');response.end('<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><link rel="stylesheet" href="/style.css"><script src="/bundle.js"></script>');return;}
if(url.pathname==='/style.css'){response.setHeader('content-type','text/css');response.end(css);return;}
if(url.pathname==='/bundle.js'){response.setHeader('content-type','text/javascript');response.end(bundle);return;}
response.setHeader('content-type','application/json');if(url.pathname==='/switch-account'){secondAccount=true;response.end('{}');return;}if(url.pathname==='/api/cinema/sessions'){response.end(JSON.stringify({rooms:[],hasMore:false}));return;}if(url.pathname==='/api/cinema/reusable-rooms'){response.end(JSON.stringify({rooms:secondAccount?[{id:'saved-b',hostStudentId:'second',currentSessionId:'session-b',title:'B SAVED ROOM',sourceType:'YOUTUBE',videoId:'',visibility:'PRIVATE',currentStatus:'LIVE',durationMinutes:0}]:[{id:'saved-a',hostStudentId:'host',currentSessionId:'session-a',title:'A PRIVATE SAVED ROOM SECRET',sourceType:'YOUTUBE',videoId:'dQw4w9WgXcQ',visibility:'PRIVATE',currentStatus:'LIVE',durationMinutes:0}]}));return;}
if(url.pathname==='/api/auth/student'){response.end(JSON.stringify({account:{id:'host',name:'Ama',email:'ama@st.umat.edu.gh',emailVerified:true}}));return;}
if (url.pathname.endsWith('/jaas')) {
  response.end(JSON.stringify({access:{domain:'8x8.vc',roomName:'fixture-app/fixture-room',role:'HOST',token:'test',expiresAt:new Date(Date.now()+300000).toISOString(),activeUntil:new Date(Date.now()+300000).toISOString()}}));return;
}
if (url.pathname.includes('/resume-room/upload')) {
  const upload={id:'resumable-file',status:'UPLOADING',filename:'resume.mp4',sizeBytes:8,mimeType:'video/mp4',durationSeconds:0,playlistPosition:1};
  if (url.pathname.endsWith('/part')) {
    const partNumber=Number(url.searchParams.get('n'));
    attemptedParts.push({partNumber,uploadId:url.searchParams.get('uploadId')});
    if (partNumber===2&&attemptedParts.length===2){response.writeHead(429,{'Retry-After':'3'}).end('{}');return;}
    response.end(JSON.stringify({part:{partNumber,etag:'part-'+partNumber}}));return;
  }
  if (url.pathname.endsWith('/complete')) {
    let body='';for await(const chunk of request)body+=chunk;completionRequests.push(JSON.parse(body));
    resumableUpload={...upload,status:'READY'};response.end(JSON.stringify({upload:resumableUpload}));return;
  }
  if (request.method==='POST'){resumableUpload=upload;response.end(JSON.stringify({upload,partBytes:4,parts:2}));return;}
  response.end(JSON.stringify({upload:resumableUpload,uploads:resumableUpload?[resumableUpload]:[],limits:{types:['video/mp4'],partBytes:4,maxParts:100,maxBytes:524288000},allowance:{plan:'FREE',maxFiles:1,maxBytes:524288000,maxMinutes:60}}));return;
}
if (url.pathname === '/api/cinema/room-plans') {
  if (pricingAccountProbe && secondAccount) { response.writeHead(503).end(JSON.stringify({error:'Second account catalogue request failed.'}));return; }
  const MB = 1024 ** 2;
  const plans = [
    { code: 'FREE', label: 'Free', files: 1, bytes: 500 * MB, minutes: 60, pricePesewas: 0, checkoutPesewas: 0, eligible: true },
    { code: 'STUDENT_PLUS', label: 'Student Plus', files: 3, bytes: 2048 * MB, minutes: 180, pricePesewas: 3700, checkoutPesewas: 3774, eligible: true },
    { code: 'STUDENT_POLITICS_PLUS', label: 'Student Politics Plus', files: 6, bytes: 3072 * MB, minutes: 240, pricePesewas: 5900, checkoutPesewas: 6018, eligible: false, eligibilityMessage: 'Requires staff approval.' },
    { code: 'ORGANIZER_PRO', label: 'Club / Department Pro', files: 10, bytes: 5120 * MB, minutes: 300, pricePesewas: 8600, checkoutPesewas: 8772, eligible: true },
    { code: 'PRO_PLUS', label: 'Pro Plus', files: 15, bytes: 8192 * MB, minutes: 300, pricePesewas: 11900, checkoutPesewas: 12137, eligible: true },
  ].map(plan => ({ ...plan, description: 'Playlist allowance', available: true }));
  response.end(JSON.stringify({ plans, current: { plan: 'FREE', validUntil: '' }, pending: pricingAccountProbe ? {plan:'STUDENT_PLUS',reference:'CRP-ACCOUNT-ONE',checkoutUrl:'/fixture-payment/a',checkoutPesewas:3774} : null, periodDays: 30, uploadsEnabled: true, perFile: { bytes: 2048 * MB, minutes: 120 } }));
  return;
}
if(url.pathname.endsWith('/study')){
  if(request.method==='POST'){studyAttempts.set(url.pathname,(studyAttempts.get(url.pathname)||0)+1);response.writeHead(503).end(JSON.stringify({error:'Study queue temporarily unavailable. Try again.'}));return;}
  const payload={pack:cachedStudy&&url.pathname.includes('study-cached')?{id:'fixture-pack',summary:'CACHED STUDY SOURCE',chapters:[],notes:[],flashcards:[],questions:[],expiresAt:studyExpiry}:url.pathname.includes('/ui-room/')?{id:'room-pack',summary:'ROOM STUDY SOURCE',chapters:studyChapters,notes:[],flashcards:[],questions:[]}:null,job:null};
  if(holdStudyRead&&url.pathname.includes('study-cached')){holdStudyRead=false;await new Promise(done=>{releaseStudyRead=done;});}
  response.end(JSON.stringify(payload));return;
}if(url.pathname.endsWith('/upload')){if(request.method==='DELETE'){cancellations.push(url.searchParams.get('uploadId'));if(cancelFails){cancelFails=false;response.writeHead(503).end(JSON.stringify({error:'Could not cancel. Please retry.'}));return;}unfinishedUpload=false;response.end(JSON.stringify({aborted:true}));return;}if(!unfinishedUpload){response.end(JSON.stringify({upload:null,uploads:[],limits:{types:['video/mp4'],partBytes:5242880,maxParts:100,maxBytes:524288000},allowance:{plan:'FREE',maxFiles:1,maxBytes:524288000,maxMinutes:60}}));return;}if(request.method==='POST'){response.writeHead(409).end(JSON.stringify({error:'Finish or cancel the current upload before adding another file.'}));return;}response.end(JSON.stringify({upload:{id:'orphan-upload',status:'UPLOADING',filename:'lesson.mp4',sizeBytes:10000},uploads:[{id:'orphan-upload',status:'UPLOADING',filename:'lesson.mp4',sizeBytes:10000}],limits:{types:['video/mp4'],partBytes:5242880,maxParts:100,maxBytes:524288000},allowance:{plan:'FREE',maxFiles:1,maxBytes:524288000,maxMinutes:60},currentUploadId:''}));return;}
if(url.pathname.endsWith('/polls')){if(request.method==='POST'){if(pollFails){pollFails=false;response.writeHead(503).end(JSON.stringify({error:'Temporary poll storage failure. Please retry.'}));return;}response.end(JSON.stringify({id:'created-poll'}));return;}response.end(JSON.stringify({polls:[]}));return;}
if(url.pathname.endsWith('/messages')){response.end(JSON.stringify({messages:[],context:[],hasMore:false,before:0,after:0,through:1}));return;}
if(url.pathname.endsWith('/assistant')){response.end(JSON.stringify({enabled:true,jobs:[]}));return;}
if(url.pathname.endsWith('/private-study')){response.end(JSON.stringify({enabled:true,requests:[]}));return;}
if(url.pathname.endsWith('/host-assistance')){response.end(JSON.stringify({enabled:true,drafts:[]}));return;}
if(url.pathname.endsWith('/rtc')){response.end(JSON.stringify({voice:false,camera:false,recordings:false,iceServers:[]}));return;}
if(url.pathname.endsWith('/recordings')){response.end(JSON.stringify({recordings:[],limits:{types:[],maxBytes:10000,maxMinutes:60}}));return;}
if(url.pathname.endsWith('/transcript')){response.end(JSON.stringify({privacy:{transcriptEnabled:true,aiStudyEnabled:true,translationEnabled:false,retentionHours:24},segments:url.searchParams.has('captions')?[]:[{id:'old-caption',speakerName:'Ama',source:'UPLOAD',text:'PREVIOUS VIDEO CAPTION',atSeconds:12,video:{sourceType:'YOUTUBE',videoId:'previous-video'},createdAt:new Date().toISOString()},{id:'legacy-caption',speakerName:'Ama',source:'UPLOAD',text:'LEGACY CAPTION',atSeconds:13,createdAt:new Date().toISOString()},{id:'current-caption',speakerName:'Ama',source:'UPLOAD',text:'CURRENT VIDEO CAPTION',atSeconds:14,video:{sourceType:'YOUTUBE',videoId:'current-video'},createdAt:new Date().toISOString()}]}));return;}
if(url.pathname.endsWith('/bookmarks')){response.end(JSON.stringify({bookmarks:[{id:'old-bookmark',studentId:'host',displayName:'Ama',label:'Previous video moment',atSeconds:12,video:{sourceType:'YOUTUBE',videoId:'M7lc1UVf-VE'}},{id:'legacy-bookmark',studentId:'host',displayName:'Ama',label:'Legacy moment',atSeconds:12},{id:'current-bookmark',studentId:'host',displayName:'Ama',label:'Current moment',atSeconds:15,video:{sourceType:'YOUTUBE',videoId:fixture.videoId}}]}));return;}
if(url.pathname==='/api/cinema/sessions/ui-room'||url.pathname.endsWith('/join')){response.end(JSON.stringify({room:fixture}));return;}
response.end('{}');});
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
  await tab.call('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await until("document.querySelector('.cinema-chat-composer')||document.body?.textContent.includes('Engineering study group')");
  await new Promise(done=>setTimeout(done,500));
  async function snapshot(name){const result=await tab.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});await writeFile('/tmp/'+name+'.png',Buffer.from(result.data,'base64'));}
  async function geometry(){return evaluate("(()=>{const title=document.querySelector('.cinema-video-title strong').getBoundingClientRect(),caption=document.querySelector('.cinema-caption-controls').getBoundingClientRect(),toolbar=document.querySelector('.cinema-toolbar');return{width:innerWidth,pageOverflow:document.documentElement.scrollWidth>innerWidth,toolbarOverflow:toolbar.scrollWidth>toolbar.clientWidth+1,captionCoversTitle:Math.min(title.right,caption.right)>Math.max(title.left,caption.left)&&Math.min(title.bottom,caption.bottom)>Math.max(title.top,caption.top)}})()");}
  for(const width of[320,390,768,900,901,1024,1440]){await tab.call('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:width<=900});await new Promise(done=>setTimeout(done,100));const metrics=await geometry();assert.equal(metrics.pageOverflow,false);assert.equal(metrics.toolbarOverflow,false);assert.equal(metrics.captionCoversTitle,false);}
  await snapshot('cinema-ui-desktop-fixed');
  await tab.call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await new Promise(done=>setTimeout(done,150));await snapshot('cinema-ui-mobile-fixed');
  console.log('PASS: room controls fit 320–1440px and captions do not cover the room title.');
  await evaluate("[...document.querySelectorAll('.cinema-toolbar button')].find(b=>b.getAttribute('aria-label')==='More').click()");await until("document.querySelector('#cinema-sheet-more')?.open");
  await evaluate("[...document.querySelectorAll('#cinema-sheet-more summary')].find(e=>e.textContent==='Study tools').click()");await evaluate("[...document.querySelectorAll('#cinema-sheet-more button')].find(b=>b.textContent.includes('My notes')).click()");await until("document.querySelector('#cinema-sheet-notes')?.open");
  assert.equal(await evaluate("document.body.style.overflow"),'hidden');await evaluate("document.querySelector('#cinema-sheet-notes header button').click()");
  await tab.call('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});await new Promise(done=>setTimeout(done,150));
  await evaluate("[...document.querySelectorAll('.cinema-toolbar button')].find(b=>b.getAttribute('aria-label')==='Bookmarks').click()");await until("document.querySelectorAll('.cinema-bookmark-jump').length===3");
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.cinema-bookmark-jump')].map(b=>b.disabled)"),[true,true,false]);await evaluate("document.querySelectorAll('.cinema-bookmark-jump')[2].click()");assert.deepEqual(await evaluate("window.frames.findLast(frame=>frame.type==='seek').video"),{sourceType:'YOUTUBE',videoId:fixture.videoId});
  console.log('PASS: bookmark jumps require matching video context and send that context to the room.');
  await evaluate("[...document.querySelectorAll('.cinema-toolbar button')].find(b=>b.getAttribute('aria-label')==='More').click()");await until("!document.querySelector('#cinema-sheet-more')?.hidden");
  await evaluate("(()=>{const summary=[...document.querySelectorAll('#cinema-sheet-more summary')].find(e=>e.textContent==='Study tools');if(!summary.parentElement.open)summary.click();[...document.querySelectorAll('#cinema-sheet-more button')].find(b=>b.textContent.includes('Study pack')).click();})()");
  await until("document.querySelectorAll('.cinema-study ol button').length===3");
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.cinema-study ol button')].map(b=>b.disabled)"),[true,true,false]);
  await evaluate("window.frames.length=0;document.querySelectorAll('.cinema-study ol button')[0].click();document.querySelectorAll('.cinema-study ol button')[1].click()");
  assert.equal(await evaluate("window.frames.some(frame=>frame.type==='seek')"),false);
  await evaluate("document.querySelectorAll('.cinema-study ol button')[2].click()");
  assert.deepEqual(await evaluate("window.frames.findLast(frame=>frame.type==='seek').video"),{sourceType:'YOUTUBE',videoId:fixture.videoId});
  assert.equal(await evaluate("window.frames.findLast(frame=>frame.type==='seek').time"),14);
  await evaluate("window.receiveRoomFrame({type:'source',sourceType:'YOUTUBE',videoId:'M7lc1UVf-VE'})");
  await until("document.querySelectorAll('.cinema-study ol button')[2].disabled");
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.cinema-study ol button')].map(b=>b.disabled)"),[false,true,true]);
  console.log('PASS: shared study chapters disable unknown and different videos; valid jumps send the cited video through CinemaRoom.');
  await tab.call('Page.navigate',{url:origin+'/?mode=polls'});await until("document.querySelector('.cinema-polls form')");
  await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='Add choice').click()");await until("document.querySelectorAll('.cinema-poll-option-edit').length===3");
  await evaluate(`(()=>{const values=['A difficult question','First answer','Second answer','Third answer'];document.querySelectorAll('.cinema-polls form input:not([type=checkbox]):not([type=radio])').forEach((element,index)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(element,values[index]);element.dispatchEvent(new Event('input',{bubbles:true}));});})()`);
  await evaluate("document.querySelector('.cinema-polls input[type=checkbox]').click()");await until("document.querySelectorAll('.cinema-polls input[type=radio]').length===3");await evaluate("document.querySelectorAll('.cinema-polls input[type=radio]')[2].click()");
  await until("!document.querySelector('.cinema-polls button[type=submit]').disabled");await evaluate("document.querySelector('.cinema-polls button[type=submit]').click()");await until("document.querySelector('.cinema-polls .cinema-error')");
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.cinema-polls form input:not([type=checkbox]):not([type=radio])')].map(e=>e.value)"),['A difficult question','First answer','Second answer','Third answer']);assert.equal(await evaluate("document.querySelectorAll('.cinema-polls input[type=radio]')[2].checked"),true);
  await evaluate("document.querySelector('.cinema-polls button[type=submit]').click()");await until("document.querySelector('.cinema-polls form input').value===''");assert.equal(await evaluate("document.querySelectorAll('.cinema-polls input[type=radio]')[0].checked"),true);
  console.log('PASS: failed quiz creation preserves the complete draft; successful creation resets the answer selection.');
  await tab.call('Page.navigate',{url:origin+'/?mode=upload'});await until("document.body?.textContent.includes('Cancel unfinished upload')");
  assert.equal(await evaluate("document.querySelector('input[type=file]').disabled"),true);
  await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='Cancel unfinished upload').click()");await until("document.querySelector('.cinema-error')");assert.equal(unfinishedUpload,true);
  await until("[...document.querySelectorAll('button')].some(b=>b.textContent==='Cancel unfinished upload'&&!b.disabled)");await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='Cancel unfinished upload').click()");await until("!document.querySelector('input[type=file]').disabled");assert.deepEqual(cancellations,['orphan-upload','orphan-upload']);
  console.log('PASS: interrupted uploads can be cancelled after reload, preserve failed cancellation for retry and enable a replacement file.');
  await tab.call('Page.navigate',{url:origin+'/?mode=transcript'});await until("document.body?.textContent.includes('CURRENT VIDEO CAPTION')");assert.deepEqual(await evaluate("[...document.querySelectorAll('.cinema-transcript ol button')].map(b=>b.disabled)"),[true,true,false]);await evaluate("document.querySelectorAll('.cinema-transcript ol button')[2].click()");assert.deepEqual(await evaluate("window.lastSeek"),{seconds:14,video:{sourceType:'YOUTUBE',videoId:'current-video'}});
  console.log('PASS: transcript archive timestamps cannot seek into a different or unknown video.');
  await tab.call('Page.navigate',{url:origin+'/?mode=lobby'});await until("document.body?.textContent.includes('A PRIVATE SAVED ROOM SECRET')");await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='Edit').click()");await until("document.querySelector('.cinema-room-edit')");
  await evaluate("window.switchLobbyAccount()");await until("document.body?.textContent.includes('B SAVED ROOM')");assert.equal(await evaluate("document.body.textContent.includes('A PRIVATE SAVED ROOM SECRET')"),false);assert.equal(await evaluate("document.querySelector('.cinema-room-edit')"),null);assert.deepEqual(await evaluate('window.errors'),[]);
  console.log('PASS: account switches clear saved-room details and open editing dialogs before loading the new account.');
  for(const test of['retry','blocked']){
    let injection;
    if(test==='blocked')injection=await tab.call('Page.addScriptToEvaluateOnNewDocument',{source:"Object.defineProperty(window,'sessionStorage',{get(){throw new Error('Storage is blocked')}})"});
    await tab.call('Page.navigate',{url:origin+'/?mode=study&test='+test});await until("document.querySelector('.cinema-study .cinema-error')");
    await new Promise(done=>setTimeout(done,350));const path='/api/cinema/sessions/study-'+test+'/study';assert.equal(studyAttempts.get(path),1,'automatic study generation attempts only once');
    await evaluate("[...document.querySelectorAll('.cinema-study button')].find(button=>button.textContent==='Generate study pack').click()");
    const deadline=Date.now()+5000;while(studyAttempts.get(path)<2&&Date.now()<deadline)await new Promise(done=>setTimeout(done,25));await new Promise(done=>setTimeout(done,350));assert.equal(studyAttempts.get(path),2,'only the explicit retry adds a request');
    assert.deepEqual(await evaluate('window.errors'),[]);
    if(injection)await tab.call('Page.removeScriptToEvaluateOnNewDocument',{identifier:injection.identifier});
  }
  console.log('PASS: failed automatic study requests run once, including blocked storage; further attempts require an explicit retry.');
  await tab.call('Page.navigate',{url:origin+'/?mode=study&test=cached'});await until("document.body?.textContent.includes('CACHED STUDY SOURCE')");
  await evaluate("window.setStudyConsent(false)");await until("!document.querySelector('.cinema-study-summary')");assert.equal(await evaluate("[...document.querySelectorAll('.cinema-study button')].some(button=>button.textContent.includes('PDF'))"),false);
  holdStudyRead=true;await evaluate('window.refreshStudy()');
  const readDeadline=Date.now()+5000;while(!releaseStudyRead&&Date.now()<readDeadline)await new Promise(done=>setTimeout(done,25));assert.equal(typeof releaseStudyRead,'function');
  cachedStudy=false;await evaluate('window.refreshStudy()');await new Promise(done=>setTimeout(done,200));
  releaseStudyRead();await new Promise(done=>setTimeout(done,200));await evaluate('window.setStudyConsent(true)');await new Promise(done=>setTimeout(done,200));assert.equal(await evaluate("document.body.textContent.includes('CACHED STUDY SOURCE')"),false);
  console.log('PASS: revoked consent hides cached study text and PDF; source refresh and out-of-order replies cannot restore a cleared pack.');
  cachedStudy=true;studyExpiry=new Date(Date.now()+2000).toISOString();
  await tab.call('Page.navigate',{url:origin+'/?mode=study&test=cached-expiry'});await until("document.body?.textContent.includes('CACHED STUDY SOURCE')");
  await until("!document.querySelector('.cinema-study-summary')");
  assert.equal(await evaluate("[...document.querySelectorAll('.cinema-study button')].some(button=>button.textContent.includes('PDF'))"),false);
  await new Promise(done=>setTimeout(done,150));assert.equal(await evaluate("document.body.textContent.includes('CACHED STUDY SOURCE')"),false);
  console.log('PASS: cached study text and PDF disappear at source expiry without waiting for a cleanup job.');
  await tab.call('Emulation.setDeviceMetricsOverride',{width:320,height:700,deviceScaleFactor:1,mobile:true});
  await tab.call('Page.navigate',{url:origin+'/?mode=pricing'});
  await until("document.querySelectorAll('.cinema-plan-card').length===5");
  assert.match(await evaluate("document.querySelector('#cinema-plan-PRO_PLUS').textContent"), /Queue up to 15 videos/);
  const setPlaylistNeeds = (values) => evaluate(`(() => {
    const values = ${JSON.stringify(values)};
    document.querySelectorAll('.cinema-plan-finder input').forEach((input, index) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, String(values[index]));
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  })()`);
  await setPlaylistNeeds([1, 500, 60]);
  await until("document.querySelector('.cinema-plan-finder [aria-live]').textContent.includes('You don’t need to buy')");
  await setPlaylistNeeds([4, 2800, 220]);
  await until("document.querySelector('.cinema-plan-finder a')?.getAttribute('href') === '#cinema-plan-ORGANIZER_PRO'");
  assert.match(await evaluate("document.querySelector('.cinema-plan-finder [aria-live]').textContent"), /87\.72/);
  await setPlaylistNeeds([15, 4200, 270]);
  await until("document.querySelector('.cinema-plan-finder a')?.getAttribute('href') === '#cinema-plan-PRO_PLUS'");
  await setPlaylistNeeds([16, 4200, 270]);
  await until("document.querySelector('.cinema-plan-finder [aria-live]').textContent.includes('No room plan fits')");
  assert.equal(await evaluate('document.documentElement.scrollWidth > innerWidth'), false);
  assert.deepEqual(await evaluate('window.errors'), []);
  console.log('PASS: pricing finder recognizes Free, skips ineligible plans, recommends Pro Plus when needed, and fits a 320px viewport.');
  secondAccount=false;pricingAccountProbe=true;
  await tab.call('Page.navigate',{url:origin+'/?mode=pricing&account-probe=1'});
  await until("document.querySelector('.cinema-plan-pending a')?.getAttribute('href')==='/fixture-payment/a'");
  await evaluate('window.switchLobbyAccount()');
  await until("document.body.textContent.includes('Second account catalogue request failed.')");
  assert.equal(await evaluate("document.querySelector('.cinema-plan-pending')"),null);
  console.log('PASS: switching accounts clears the previous checkout even when the new catalogue request fails.');

  await tab.call('Page.navigate',{url:origin+'/?mode=stage'});
  await until("document.querySelector('.cinema-jaas-stage')?.dataset.status==='failed'");
  assert.equal(await evaluate("document.querySelectorAll('script[data-cinema-jaas]').length"),0);
  await evaluate("document.querySelector('.cinema-jaas-stage button').click()");
  await until("document.querySelector('.cinema-jaas-stage')?.dataset.status==='ready'");
  assert.equal(await evaluate('window.sdkRequests'),2);
  console.log('PASS: managed-stage retry requests a fresh SDK after an initial failure and connects.');

  await tab.call('Page.navigate',{url:origin+'/?mode=resume'});
  await until("document.querySelector('.cinema-upload-file')");
  await evaluate("(()=>{const input=document.querySelector('.cinema-upload-file');const files=new DataTransfer();files.items.add(new File(['12345678'],'resume.mp4',{type:'video/mp4'}));input.files=files.files;input.dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('.cinema-upload-consent input').click();})()");
  await until("[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Upload the video')&&!b.disabled)");
  await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Upload the video')).click()");
  await until("[...document.querySelectorAll('button')].some(b=>b.textContent==='Resume upload'&&b.disabled)");
  assert.deepEqual(attemptedParts.map(part=>part.partNumber),[1,2]);
  await until("[...document.querySelectorAll('button')].some(b=>b.textContent==='Resume upload'&&!b.disabled)");
  await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='Resume upload').click()");
  await until("window.uploadResumed===true");
  assert.deepEqual(attemptedParts,[{partNumber:1,uploadId:'resumable-file'},{partNumber:2,uploadId:'resumable-file'},{partNumber:2,uploadId:'resumable-file'}]);
  assert.deepEqual(completionRequests,[{uploadId:'resumable-file',parts:[{partNumber:1,etag:'part-1'},{partNumber:2,etag:'part-2'}]}]);
  console.log('PASS: the upload pauses for Retry-After and resumes the same file at the first missing part.');

} finally {
  clearTimeout(startupTimer); clients.forEach(c => c.close()); chrome?.kill("SIGTERM");
  if (chrome && chrome.exitCode === null) await new Promise(done => { chrome.once("exit", done); setTimeout(done, 3000).unref(); });
  if (server.listening) await new Promise(done => server.close(done));
  await rm(profile, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 }).catch(error => console.error("Cleanup:", error.message));
}
