import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

process.env.TURSO_DATABASE_URL = "https://hostel-maintenance-test.turso.io";
process.env.TURSO_AUTH_TOKEN = "test-token";
process.env.PAYSTACK_SECRET_KEY = "sk_test_stays";
process.env.CONSOLE_SESSION_SECRET = "stay-test-console-secret-at-least-32-characters";
const db = new DatabaseSync(":memory:");
function execute(stmt) {
  try {
    const args = (stmt.args || []).map(arg => arg.type === "null" ? null : arg.type === "integer" ? Number(arg.value) : arg.value);
    const query = db.prepare(stmt.sql);
    if (query.columns().length) {
      const cols = query.columns().map(column => ({ name: column.name }));
      const rows = query.all(...args).map(row => cols.map(({name}) => row[name] === null ? {type:"null"} : {type:typeof row[name] === "number" ? "integer" : "text",value:String(row[name])}));
      return {result:{cols,rows,affected_row_count:0}};
    }
    const result = query.run(...args);
    return {result:{cols:[],rows:[],affected_row_count:Number(result.changes)}};
  } catch (error) { return {error:{message:error.message}}; }
}
globalThis.fetch = async (url, init) => {
  const target = String(url);
  if (target === "https://api.paystack.co/transaction/initialize") return Response.json({status:true,data:{authorization_url:"https://checkout.paystack.com/test",access_code:"test"}});
  assert.ok(target.startsWith("https://hostel-maintenance-test.turso.io"), "Tests must never access a real provider");
  const body = JSON.parse(init.body);
  const results = body.requests.map(request => {
    if (request.type === "close") return {type:"ok"};
    if (request.type === "execute") {
      const result=execute(request.stmt); return result.error ? {type:"error",error:result.error} : {type:"ok",response:{result:result.result}};
    }
    const step_results=[],step_errors=[];
    const allowed=condition => !condition || condition.type === "ok" ? !condition || step_results[condition.step] !== null && step_results[condition.step] !== undefined : condition.type === "not" ? !allowed(condition.cond) : condition.type === "and" ? condition.conds.every(allowed) : false;
    for (const step of request.batch.steps) {
      const result = allowed(step.condition) ? execute(step.stmt) : {};
      step_results.push(result.result || null);step_errors.push(result.error || null);
    }
    return {type:"ok",response:{result:{step_results,step_errors}}};
  });
  return Response.json({results});
};
const root=fileURLToPath(new URL("..",import.meta.url));
const vite=await createServer({appType:"custom",configFile:false,root,resolve:{alias:{"@":root}},server:{middlewareMode:true,hmr:false}});
after(async()=>{await vite.close();db.close();});
const maintenance=await vite.ssrLoadModule('/lib/hostel-engine/maintenance.ts');
const filesModule=await vite.ssrLoadModule('/lib/hostel-engine/maintenance-files.ts');
const {ensureHostelMaintenanceTables}=await vite.ssrLoadModule('/lib/hostel-engine/maintenance-schema.ts');
const {resetPlatformSettingsCache}=await vite.ssrLoadModule('/lib/platform-settings.ts');
await ensureHostelMaintenanceTables();
process.env.STUDENT_SESSION_SECRET='maintenance-student-secret-at-least-32-characters';
const studentAuth=await vite.ssrLoadModule('/lib/student-auth.ts');
const consoleAuth=await vite.ssrLoadModule('/lib/console-auth.ts');
await studentAuth.ensureStudentAccountsTable();
const stamp=new Date().toISOString();
const day=offset=>new Date(Date.now()+offset*86400000).toISOString().slice(0,10);
function insert(table,row){const keys=Object.keys(row);db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).run(...Object.values(row));}
const student={kind:'STUDENT',email:'student@st.umat.edu.gh',name:'Student'};
const owner={kind:'STAFF',email:'owner@example.test',name:'Owner',landlordId:'owner',isOwner:true};
const manager={...owner,email:'manager@example.test',name:'Manager',isOwner:false};
const objects=new Map();let failUpload=false;
const bucket={async put(key,body){objects.set(key,body);if(failUpload)throw Error('Upload failed');},async get(key){return objects.has(key)?{body:new Response(objects.get(key)).body}:null;},async delete(keys){for(const key of typeof keys==='string'?[keys]:keys)objects.delete(key);}};
const photo=()=>({name:'leak.png',type:'image/png',body:Uint8Array.from([137,80,78,71,13,10,26,10,1,2,3]).buffer});
const draft=(extra={})=>({reference:'HF-TEST',clientRequestId:crypto.randomUUID(),category:'PLUMBING',urgency:'ROUTINE',locationType:'ROOM',locationDetail:'Bathroom tap',title:'Tap is leaking',description:'The bathroom tap has leaked since yesterday.',entryPermission:'ARRANGE_FIRST',preferredAccess:'After 4 pm',...extra});
const create=(extra={},photos=[])=>maintenance.createMaintenanceRequest(student,draft(extra),photos,bucket);
const update=(detail,action,extra={},actor=owner,photos=[])=>maintenance.updateMaintenanceRequest(actor,detail.ticket.id,{version:detail.ticket.version,mutationId:crypto.randomUUID(),action,note:'Recorded update',...extra},photos,bucket);
const count=table=>db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
beforeEach(()=>{
 for(const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all())db.exec(`DROP TRIGGER "${name}"`);
 for(const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all())if(!['schema_passes','campus_schema_meta'].includes(name))db.exec(`DELETE FROM "${name}"`);
 objects.clear();failUpload=false;resetPlatformSettingsCache();
 insert('hostel_landlords',{id:'owner',name:'Owner',email:owner.email,phone:'0240000000',kyc_status:'VERIFIED',status:'ACTIVE',created_at:stamp,updated_at:stamp});
 insert('hostel_owner_onboarding',{landlord_id:'owner',profile_status:'APPROVED',updated_at:stamp});
 insert('hostel_properties',{id:'property',landlord_id:'owner',name:'Test Lodge',status:'APPROVED',created_at:stamp,updated_at:stamp});
 insert('hostel_rooms',{id:'room',property_id:'property',label:'A1',capacity:4,status:'ACTIVE',created_at:stamp,updated_at:stamp});
 insert('hostel_spaces',{id:'bed',room_id:'room',label:'Lower bunk',status:'OCCUPIED',created_at:stamp,updated_at:stamp});
 insert('hostel_periods',{id:'year',name:'Current year',starts_on:day(-10),ends_on:day(100),active:1,created_at:stamp});
 insert('hostel_bookings',{id:'booking',reference:'HF-TEST',listing_id:'listing',space_id:'bed',room_id:'room',property_id:'property',landlord_id:'owner',period_id:'year',student_email:student.email,student_name:student.name,price:120000,total_amount:120000,status:'PAID',created_at:stamp,updated_at:stamp});
 insert('hostel_stays',{booking_id:'booking',status:'CHECKED_IN',updated_at:stamp});
 insert('platform_settings',{key:'hostel_maintenance_enabled',value:'1',updated_at:stamp,updated_by:owner.email});
 insert('hostel_maintenance_settings',{property_id:'property',enabled:1,service_hours:'Monday–Friday, 8 am–5 pm',acknowledgement_hours:24,version:1,updated_at:stamp});
 for(const actor of [owner,manager])insert('console_accounts',{id:actor.name,email:actor.email,name:actor.name,role:'LANDLORD',status:'ACTIVE',profile_id:'owner',created_at:stamp,updated_at:stamp});
 insert('hostel_managers',{id:'manager',landlord_id:'owner',email:manager.email,name:manager.name,status:'ACTIVE',created_at:stamp,updated_at:stamp});
});

test('creation uses booking snapshots, immutable event and transactional notifications',async()=>{
 const detail=await create({roomLabel:'Fake room',landlordId:'other'});
 assert.equal(detail.ticket.roomLabel,'A1');assert.equal(detail.ticket.spaceLabel,'Lower bunk');assert.equal(detail.events[0].action,'SUBMIT');
 assert.equal(count('notification_outbox'),2);assert.equal(count('hostel_maintenance_requests'),1);
 assert.equal(detail.ticket.assigneeEmail,'');assert.equal((await maintenance.maintenanceConfig(student,{reference:'HF-TEST'})).urgentContact,'0240000000');
});
test('identical retries and concurrent creation produce one ticket and event',async()=>{
 const body=draft();const results=await Promise.all([maintenance.createMaintenanceRequest(student,body),maintenance.createMaintenanceRequest(student,body)]);
 assert.equal(results[0].ticket.id,results[1].ticket.id);assert.equal(count('hostel_maintenance_requests'),1);assert.equal(count('hostel_maintenance_events'),1);assert.equal(count('notification_outbox'),2);
 await assert.rejects(maintenance.createMaintenanceRequest(student,{...body,title:'Different problem'}),e=>e.status===409);
});
test('current paid stay, property opt-in and platform switch are all required',async()=>{
 for(const [disable,restore] of [
  ["UPDATE hostel_bookings SET status='PENDING_PAYMENT'","UPDATE hostel_bookings SET status='PAID'"],
  ["UPDATE hostel_stays SET status='CHECKED_OUT'","UPDATE hostel_stays SET status='CHECKED_IN'"],
  ["UPDATE hostel_maintenance_settings SET enabled=0","UPDATE hostel_maintenance_settings SET enabled=1"],
  ["UPDATE platform_settings SET value='0'","UPDATE platform_settings SET value='1'"],
  ["UPDATE hostel_landlords SET status='SUSPENDED'","UPDATE hostel_landlords SET status='ACTIVE'"],
  ["UPDATE hostel_periods SET starts_on='2999-01-01'",`UPDATE hostel_periods SET starts_on='${day(-10)}'`],
 ]){db.exec(disable);resetPlatformSettingsCache();await assert.rejects(create(),e=>e.status===409);db.exec(restore);resetPlatformSettingsCache();}
 assert.equal(count('hostel_maintenance_requests'),0);
});
test('platform switch defaults off and an unreviewed phone is hidden',async()=>{
 db.exec("DELETE FROM platform_settings; UPDATE hostel_owner_onboarding SET profile_status='PENDING';");resetPlatformSettingsCache();
 const config=await maintenance.maintenanceConfig(student,{reference:'HF-TEST'});assert.equal(config.canCreate,false);assert.equal(config.urgentContact,'');
});
test('other students and properties cannot read or mutate reports',async()=>{
 const detail=await create();
 for(const actor of [{...student,email:'someone@st.umat.edu.gh'},{...owner,landlordId:'other'}]){
  await assert.rejects(maintenance.maintenanceDetail(actor,detail.ticket.id),e=>e.status===404);
  await assert.rejects(update(detail,'COMMENT',{},actor),e=>e.status===404);
  assert.equal((await maintenance.listMaintenanceRequests(actor)).tickets.length,0);
 }
 await assert.rejects(maintenance.maintenanceConfig({...student,email:'someone@st.umat.edu.gh'},{reference:'HF-TEST'}),e=>e.status===404);
});
test('assignment requires active same-hostel staff and hides staff email from students',async()=>{
 let detail=await create();await assert.rejects(update(detail,'ASSIGN',{assigneeEmail:'outsider@example.test'}),e=>e.status===400);
 detail=await update(detail,'ASSIGN',{assigneeEmail:manager.email});assert.equal(detail.ticket.assigneeEmail,manager.email);
 assert.equal((await maintenance.maintenanceDetail(student,detail.ticket.id)).ticket.assigneeEmail,'');
 db.exec("UPDATE hostel_managers SET status='REVOKED'");await assert.rejects(update(detail,'ASSIGN',{assigneeEmail:manager.email}),e=>e.status===400);
 await assert.rejects(update(detail,'ASSIGN',{assigneeEmail:owner.email},student),e=>e.status===409);
});
test('staff and student complete, confirm, reopen and cancel with audited state changes',async()=>{
 let detail=await create();await assert.rejects(update(detail,'RESOLVE'),e=>e.status===409);
 detail=await update(detail,'ACKNOWLEDGE');assert.ok(detail.ticket.acknowledgedAt);
 detail=await update(detail,'START',{},manager);detail=await update(detail,'WAIT');assert.equal(detail.ticket.status,'WAITING_FOR_STUDENT');
 detail=await update(detail,'COMMENT',{note:'I am available tomorrow'},student);assert.equal(detail.ticket.status,'ACKNOWLEDGED');
 detail=await update(detail,'RESOLVE');assert.ok(detail.ticket.resolvedAt);await assert.rejects(update(detail,'CLOSE'),e=>e.status===409);
 detail=await update(detail,'CLOSE',{},student);assert.equal(detail.ticket.status,'CLOSED');
 detail=await update(detail,'REOPEN',{note:'It is leaking again'},student);assert.equal(detail.ticket.status,'SUBMITTED');assert.equal(detail.ticket.acknowledgedAt,'');
 detail=await update(detail,'ESCALATE',{},student);assert.ok(detail.ticket.escalatedAt);
 detail=await update(detail,'CANCEL',{},student);assert.equal(detail.ticket.status,'CANCELLED');assert.equal(detail.actions.length,0);assert.equal(detail.events.length,10);
 await assert.rejects(update(detail,'COMMENT',{},student),e=>e.status===409);
});
test('stale versions cannot overwrite another edit; mutation retries are idempotent',async()=>{
 const detail=await create();const change={version:0,mutationId:crypto.randomUUID(),action:'ACKNOWLEDGE'};
 const result=await maintenance.updateMaintenanceRequest(owner,detail.ticket.id,change);
 const repeat=await maintenance.updateMaintenanceRequest(owner,detail.ticket.id,change);assert.equal(repeat.ticket.version,1);
 await assert.rejects(update(detail,'CANCEL'),e=>e.status===409);assert.equal(count('hostel_maintenance_events'),2);
 await assert.rejects(maintenance.updateMaintenanceRequest(owner,detail.ticket.id,{...change,action:'START'}),e=>e.status===409);
 assert.equal(result.ticket.status,'ACKNOWLEDGED');
});
test('existing tickets remain accessible and actionable after checkout and switches turn off',async()=>{
 let detail=await create();db.exec("UPDATE hostel_stays SET status='CHECKED_OUT'; UPDATE platform_settings SET value='0'; UPDATE hostel_maintenance_settings SET enabled=0");resetPlatformSettingsCache();
 detail=await update(detail,'COMMENT',{note:'Still waiting for a response'},student);assert.equal(detail.events.length,2);
 detail=await update(detail,'ACKNOWLEDGE');assert.equal(detail.ticket.status,'ACKNOWLEDGED');await assert.rejects(create(),e=>e.status===409);
});
test('private photos require signed actor-bound links and report ownership',async()=>{
 const detail=await create({},[photo()]);assert.equal(objects.size,1);assert.equal(count('hostel_property_photos'),0);
 const attachment=detail.files[0],token=new URL(attachment.url,'https://example.test').searchParams.get('token');
 const response=await maintenance.readMaintenancePhoto(student,attachment.id,token,bucket);assert.equal(response.headers.get('cache-control'),'private, no-store');assert.equal((await response.arrayBuffer()).byteLength,11);
 await assert.rejects(maintenance.readMaintenancePhoto({...student,email:'other@st.umat.edu.gh'},attachment.id,token,bucket),e=>e.status===403);
 await assert.rejects(maintenance.readMaintenancePhoto(owner,attachment.id,token,bucket),e=>e.status===403);
 const other={...student,email:'other@st.umat.edu.gh'},url=await filesModule.maintenancePhotoUrl(other,attachment.id);
 await assert.rejects(maintenance.readMaintenancePhoto(other,attachment.id,new URL(url,'https://example.test').searchParams.get('token'),bucket),e=>e.status===404);
 assert.equal(await filesModule.verifyMaintenancePhotoToken(student,attachment.id,'1.'+'a'.repeat(64)),false);
});
test('invalid files, upload failures and database failures do not leave partial tickets',async()=>{
 await assert.rejects(create({},[{...photo(),type:'image/svg+xml'}]),e=>e.status===400);
 await assert.rejects(create({},Array.from({length:4},photo)),e=>e.status===400);
 failUpload=true;await assert.rejects(create({},[photo()]),/Upload failed/);assert.equal(objects.size,0);failUpload=false;
 db.exec("CREATE TRIGGER fail_event BEFORE INSERT ON hostel_maintenance_events BEGIN SELECT RAISE(ABORT,'audit unavailable'); END;");
 await assert.rejects(create({},[photo()]),/audit unavailable/);assert.equal(objects.size,0);assert.equal(count('hostel_maintenance_requests'),0);assert.equal(count('notification_outbox'),0);
});
test('photo limit is enforced on the transaction and concurrent edits clean losing uploads',async()=>{
 let detail=await create({},[photo(),photo(),photo()]);detail=await update(detail,'COMMENT',{},student,[photo(),photo(),photo()]);detail=await update(detail,'COMMENT',{},student,[photo(),photo(),photo()]);
 await assert.rejects(update(detail,'COMMENT',{},student,[photo(),photo()]),e=>e.status===409);assert.equal(objects.size,9);
 const results=await Promise.allSettled([update(detail,'COMMENT',{},student,[photo()]),update(detail,'COMMENT',{},student,[photo()])]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(objects.size,10);assert.equal(count('hostel_maintenance_attachments'),10);
});
test('owner settings require ownership, optimistic version and an audit record',async()=>{
 const input={propertyId:'property',enabled:true,serviceHours:'Weekdays 9–5',acknowledgementHours:12,version:1};
 await assert.rejects(maintenance.saveMaintenanceConfig(manager,input),e=>e.status===403);
 const config=await maintenance.saveMaintenanceConfig(owner,input);assert.equal(config.version,2);assert.equal(config.acknowledgementHours,12);assert.equal(count('admin_audit_logs'),1);
 await assert.rejects(maintenance.saveMaintenanceConfig(owner,input),e=>e.status===409);assert.equal(count('admin_audit_logs'),1);
});
test('queue pagination, filters, overdue and escalation totals use the complete scope',async()=>{
 const detail=await create();const original=db.prepare('SELECT * FROM hostel_maintenance_requests').get();
 for(let i=0;i<44;i++)insert('hostel_maintenance_requests',{...original,id:'copy-'+i,reference:'MT-'+i,client_request_id:crypto.randomUUID(),category:i%2?'WATER':'INTERNET',acknowledgement_due_at:'2000-01-01',escalated_at:i===0?stamp:''});
 const first=await maintenance.listMaintenanceRequests(owner);assert.equal(first.tickets.length,20);assert.equal(first.pagination.pages,3);assert.equal(first.summary.open,45);assert.equal(first.summary.overdue,44);assert.equal(first.summary.escalated,1);
 assert.equal((await maintenance.listMaintenanceRequests(owner,{page:3})).tickets.length,5);
 assert.equal((await maintenance.listMaintenanceRequests(owner,{category:'WATER'})).pagination.total,22);
 assert.equal((await maintenance.listMaintenanceRequests(owner,{search:detail.ticket.reference})).pagination.total,1);
 assert.equal((await maintenance.listMaintenanceRequests(owner,{escalated:true})).pagination.total,1);
});
test('routes reject unsigned access and cross-origin mutation before database access',async()=>{
 const {maintenanceRoute,maintenanceFileRoute}=await vite.ssrLoadModule('/lib/hostel-engine/maintenance-http.ts');
 for(const audience of ['STUDENT','STAFF']){
  assert.equal((await maintenanceRoute(new Request('https://example.test/api/maintenance'),audience)).status,401);
  assert.equal((await maintenanceRoute(new Request('https://example.test/api/maintenance',{method:'PATCH',headers:{origin:'https://attacker.test'},body:'{}'}),audience)).status,403);
  assert.equal((await maintenanceFileRoute(new Request('https://example.test/api/maintenance/files/x'),audience,'x')).status,401);
 }
});

test('signed student route creates a report and revoked manager sessions immediately lose access',async()=>{
 insert('student_accounts',{id:'student',email:student.email,name:student.name,password_hash:'test',password_salt:'test',password_iterations:1,created_at:stamp,updated_at:stamp});
 const studentCookie=`${studentAuth.STUDENT_SESSION_COOKIE}=${await studentAuth.createStudentSession('student')}`;
 const managerCookie=`${consoleAuth.CONSOLE_SESSION_COOKIE}=${await consoleAuth.createConsoleSession({id:'Manager',role:'LANDLORD'})}`;
 const {maintenanceRoute,maintenanceSettingsRoute}=await vite.ssrLoadModule('/lib/hostel-engine/maintenance-http.ts');
 const response=await maintenanceRoute(new Request('https://example.test/api/hostel/maintenance',{method:'POST',headers:{cookie:studentCookie,'content-type':'application/json'},body:JSON.stringify(draft())}),'STUDENT');
 assert.equal(response.status,201);const detail=await response.json();
 const staffRequest=()=>new Request('https://example.test/api/console/hostel/maintenance?id='+detail.ticket.id,{headers:{cookie:managerCookie}});
 assert.equal((await maintenanceRoute(staffRequest(),'STAFF')).status,200);
 const settings=await maintenanceSettingsRoute(new Request('https://example.test/api/console/hostel/maintenance/settings',{method:'PATCH',headers:{cookie:managerCookie,'content-type':'application/json'},body:JSON.stringify({propertyId:'property',enabled:false,serviceHours:'Weekdays',acknowledgementHours:12,version:1})}));assert.equal(settings.status,403);
 db.exec("UPDATE hostel_managers SET status='REVOKED'");assert.equal((await maintenanceRoute(staffRequest(),'STAFF')).status,403);
 db.exec("UPDATE student_accounts SET active=0");assert.equal((await maintenanceRoute(new Request('https://example.test/api/hostel/maintenance?id='+detail.ticket.id,{headers:{cookie:studentCookie}}),'STUDENT')).status,401);
});
test('multipart parser accepts supported photos and rejects oversized, malformed and unsupported bodies',async()=>{
 const form=new FormData();form.set('data',JSON.stringify(draft()));form.append('photos',new File([photo().body],'leak.png',{type:'image/png'}));
 const parsed=await filesModule.readMaintenanceBody(new Request('https://example.test',{method:'POST',body:form}));assert.equal(parsed.files.length,1);assert.equal(parsed.data.title,'Tap is leaking');
 for(const body of ['[]','broken'])await assert.rejects(filesModule.readMaintenanceBody(new Request('https://example.test',{method:'POST',headers:{'content-type':'application/json'},body})),e=>e.status===400);
 await assert.rejects(filesModule.readMaintenanceBody(new Request('https://example.test',{method:'POST',headers:{'content-length':String(20*1024*1024)},body:'x'})),e=>e.status===413);
 await assert.rejects(filesModule.readMaintenanceBody(new Request('https://example.test',{method:'POST',headers:{'content-type':'text/plain'},body:'bad'})),e=>e.status===400);
});
test('turning the platform off while a photo uploads blocks the stale submission and cleans storage',async()=>{
 const racingBucket={...bucket,async put(key,body){await bucket.put(key,body);db.exec("UPDATE platform_settings SET value='0'");}};
 await assert.rejects(maintenance.createMaintenanceRequest(student,draft(),[photo()],racingBucket),e=>e.status===409);
 assert.equal(count('hostel_maintenance_requests'),0);assert.equal(count('notification_outbox'),0);assert.equal(objects.size,0);
});
test('maintenance guide fallback stays factual and never claims live ticket access',async()=>{
 const {answerHostelGuide}=await vite.ssrLoadModule('/lib/hostel-engine/help-assistant.ts');
 const result=await answerHostelGuide('How can I report a leaking tap?','student');assert.match(result.answer,/Report a problem/);assert.match(result.answer,/cannot see live reports/);
 const staff=await answerHostelGuide('How do I manage maintenance?','staff','LANDLORD');assert.match(staff.answer,/acknowledge/);
});

test('updates route notifications back to the owner when assigned staff access was revoked',async()=>{
 let detail=await create();detail=await update(detail,'ASSIGN',{assigneeEmail:manager.email});
 db.exec("UPDATE hostel_managers SET status='REVOKED'; DELETE FROM notification_outbox;");
 await update(detail,'COMMENT',{note:'Please arrange a new staff member'},student);
 assert.equal(db.prepare("SELECT recipient FROM notification_outbox WHERE template='hostel_maintenance_staff'").get().recipient,owner.email);
});
