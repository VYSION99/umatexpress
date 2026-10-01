import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

process.env.TURSO_DATABASE_URL = "https://hostel-conditions-test.turso.io";
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
  assert.ok(target.startsWith("https://hostel-conditions-test.turso.io"), "Tests must never access a real provider");
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
const conditions=await vite.ssrLoadModule('/lib/hostel-engine/conditions.ts');
const stays=await vite.ssrLoadModule('/lib/hostel-engine/stays.ts');
const residency=await vite.ssrLoadModule('/lib/hostel-engine/residency.ts');
const filesModule=await vite.ssrLoadModule('/lib/hostel-engine/maintenance-files.ts');
const {ensureHostelConditionTables}=await vite.ssrLoadModule('/lib/hostel-engine/condition-schema.ts');
const {resetPlatformSettingsCache}=await vite.ssrLoadModule('/lib/platform-settings.ts');
await ensureHostelConditionTables();
await (await vite.ssrLoadModule("/lib/hostel-engine/refunds.ts")).ensureHostelRefundTables();
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
const start=()=>conditions.startConditionRecord(student,{reference:'HF-TEST'});
const items=(detail,condition='GOOD')=>detail.record.checklist.map(item=>({...item,condition,note:condition==='GOOD'?'':'Recorded condition at handover'}));
const update=(detail,action,extra={},actor=student,photos=[])=>conditions.updateConditionRecord(actor,detail.record.id,{version:detail.record.version,mutationId:crypto.randomUUID(),action,note:'Inspection recorded',...extra},photos,bucket);
const submit=async()=>{const detail=await start();return update(detail,'SUBMIT',{items:items(detail)});};
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
 insert('platform_settings',{key:'hostel_conditions_enabled',value:'1',updated_at:stamp,updated_by:owner.email});
 insert('hostel_condition_settings',{property_id:'property',enabled:1,checklist_json:JSON.stringify([{key:'bed',label:'Bed frame'},{key:'locks',label:'Door and locks'}]),version:1,updated_by:owner.email,updated_at:stamp});
 for(const actor of [owner,manager])insert('console_accounts',{id:actor.name,email:actor.email,name:actor.name,role:'LANDLORD',status:'ACTIVE',profile_id:'owner',created_at:stamp,updated_at:stamp});
 insert('hostel_managers',{id:'manager',landlord_id:'owner',email:manager.email,name:manager.name,status:'ACTIVE',created_at:stamp,updated_at:stamp});
});


test('open is idempotent, checks enablement and snapshots actual room and inventory',async()=>{
 const [a,b]=await Promise.all([start(),start()]);assert.equal(a.record.id,b.record.id);assert.equal(count('hostel_condition_records'),1);assert.equal(a.record.roomLabel,'A1');assert.equal(a.record.checklist.length,2);
 db.exec("UPDATE hostel_condition_settings SET checklist_json='[]',enabled=0; UPDATE platform_settings SET value='0'");resetPlatformSettingsCache();assert.equal((await start()).record.checklist.length,2);
});
test('new records fail closed for disabled, unpaid, future or ended stays',async()=>{
 for(const [disable,restore] of [["UPDATE platform_settings SET value='0'","UPDATE platform_settings SET value='1'"],["UPDATE hostel_condition_settings SET enabled=0","UPDATE hostel_condition_settings SET enabled=1"],["UPDATE hostel_bookings SET status='PENDING_PAYMENT'","UPDATE hostel_bookings SET status='PAID'"],["UPDATE hostel_stays SET status='CHECKED_OUT'","UPDATE hostel_stays SET status='CHECKED_IN'"],["UPDATE hostel_periods SET starts_on='2999-01-01'",`UPDATE hostel_periods SET starts_on='${day(-10)}'`]]){db.exec(disable);resetPlatformSettingsCache();await assert.rejects(start(),e=>e.status===409);db.exec(restore);resetPlatformSettingsCache();}
 assert.equal(count('hostel_condition_records'),0);
});
test('every checklist item is required and damage needs a meaningful note',async()=>{
 const d=await start();await assert.rejects(update(d,'SUBMIT',{items:[]}),e=>e.status===400);
 await assert.rejects(update(d,'SUBMIT',{items:items(d).map(i=>({...i,condition:'DAMAGED',note:''}))}),e=>e.status===400);
 assert.equal(count('hostel_condition_revisions'),0);
});
test('amendments preserve original evidence; stale and duplicate mutations are handled',async()=>{
 let d=await submit();const original=d.revisions[0];const body={version:d.record.version,mutationId:crypto.randomUUID(),action:'AMEND',items:items(d,'WORN'),note:'Corrected after checking the bed'};
 d=await conditions.updateConditionRecord(student,d.record.id,body);assert.equal(d.revisions.length,2);assert.deepEqual(d.revisions.find(r=>r.revision===1),original);
 await conditions.updateConditionRecord(student,d.record.id,body);assert.equal(count('hostel_condition_revisions'),2);
 await assert.rejects(conditions.updateConditionRecord(student,d.record.id,{...body,mutationId:crypto.randomUUID()}),e=>e.status===409);
});
test('acknowledgment cannot erase a disagreement and only the raising side can withdraw it',async()=>{
 let d=await submit();d=await update(d,'DISPUTE',{note:'The recorded damage needs review'});d=await update(d,'ACKNOWLEDGE',{},owner);assert.equal(d.record.disputeBy,'STUDENT');assert.equal(d.record.status,'ACKNOWLEDGED');
 await assert.rejects(update(d,'WITHDRAW',{},owner),e=>e.status===409);d=await update(d,'WITHDRAW');assert.equal(d.record.disputeBy,'');
 d=await update(d,'CLARIFY',{},owner);assert.equal(d.record.status,'CLARIFICATION_REQUESTED');assert.ok(d.actions.includes('ACKNOWLEDGE'));assert.ok(!d.actions.includes('CLOSE'));d=await update(d,'ACKNOWLEDGE',{},owner);assert.equal(d.record.status,'ACKNOWLEDGED');
});
test('checkout comparison and closure require student receipt, resolved disagreement and departure',async()=>{
 let d=await submit();d=await update(d,'ACKNOWLEDGE',{},owner);d=await update(d,'CHECKOUT',{items:items(d,'WORN')},owner);assert.equal(d.revisions.filter(r=>r.phase==='CHECKOUT').length,1);
 await assert.rejects(update(d,'CLOSE',{},owner),e=>e.status===409);d=await update(d,'ACK_CHECKOUT');await assert.rejects(update(d,'CLOSE',{},owner),e=>e.status===409);
 db.exec("UPDATE hostel_stays SET status='CHECKED_OUT'");d=await update(d,'DISPUTE');await assert.rejects(update(d,'CLOSE',{},owner),e=>e.status===409);d=await update(d,'WITHDRAW');d=await update(d,'CLOSE',{},owner);
 assert.equal(d.record.status,'CLOSED');assert.ok(d.record.closedAt);assert.ok(d.actions.includes('DISPUTE'));d=await update(d,'DISPUTE',{note:'A later review found an unresolved observation'});assert.equal(d.record.disputeBy,'STUDENT');assert.equal(d.record.closedAt,'');assert.equal(db.prepare('SELECT total_amount FROM hostel_bookings').get().total_amount,120000);assert.equal(count('hostel_refunds'),0);
});
test('private photo links are scoped to the record owner, staff and feature namespace',async()=>{
 let d=await start();d=await update(d,'SUBMIT',{items:items(d),photoItems:['bed']},student,[photo()]);assert.equal(d.photos[0].itemKey,'bed');assert.ok([...objects.keys()][0].startsWith('hostel-conditions/'));
 const photoId=d.photos[0].id,token=new URL(d.photos[0].url,'https://example.test').searchParams.get('token');assert.equal((await conditions.readConditionPhoto(student,photoId,token,bucket)).status,200);
 await assert.rejects(conditions.readConditionPhoto({...student,email:'other@example.test'},photoId,token,bucket),e=>e.status===403);
 const maintenanceUrl=await filesModule.maintenancePhotoUrl(student,photoId);await assert.rejects(conditions.readConditionPhoto(student,photoId,new URL(maintenanceUrl,'https://example.test').searchParams.get('token'),bucket),e=>e.status===403);
 const foreign={...owner,landlordId:'other'};const link=await filesModule.maintenancePhotoUrl(foreign,photoId,'conditions');await assert.rejects(conditions.readConditionPhoto(foreign,photoId,new URL(link,'https://example.test').searchParams.get('token'),bucket),e=>e.status===404);assert.equal(count('hostel_property_photos'),0);
});
test('other students and hostels cannot read, export or modify records',async()=>{
 const d=await submit();for(const actor of [{...student,email:'other@example.test'},{...owner,landlordId:'other'}]){
  await assert.rejects(conditions.conditionDetail(actor,d.record.id),e=>e.status===404);await assert.rejects(conditions.exportConditionRecord(actor,d.record.id),e=>e.status===404);await assert.rejects(update(d,'COMMENT',{},actor),e=>e.status===404);assert.equal((await conditions.listConditionRecords(actor)).records.length,0);
 }
 const exported=await conditions.exportConditionRecord(student,d.record.id,'json');assert.match(exported.headers.get('content-disposition'),/attachment/);const data=await exported.json();assert.equal(data.revisions.length,1);assert.equal(data.photos.some(p=>'url' in p),false);const summary=await conditions.exportConditionRecord(student,d.record.id);assert.match(await summary.text(),/INSPECTION VERSIONS/);
});
test('upload and audit failures preserve evidence and leave no partial revision',async()=>{
 const d=await start();failUpload=true;await assert.rejects(update(d,'SUBMIT',{items:items(d),photoItems:['bed']},student,[photo()]),/Upload failed/);assert.equal(objects.size,0);failUpload=false;
 db.exec("CREATE TRIGGER fail_condition_event BEFORE INSERT ON hostel_condition_events BEGIN SELECT RAISE(ABORT,'audit unavailable'); END;");
 await assert.rejects(update(d,'SUBMIT',{items:items(d),photoItems:['bed']},student,[photo()]),/audit unavailable/);assert.equal(objects.size,0);assert.equal(count('hostel_condition_revisions'),0);assert.equal(count('notification_outbox'),0);assert.equal((await conditions.conditionDetail(student,d.record.id)).record.version,0);
});
async function transfer(target='bed-next') {
 const b=await residency.getHostelBookingByReference('HF-TEST');return stays.updateHostelStay({landlordId:'owner',reference:'HF-TEST',actor:owner.email,action:'TRANSFER',version:b.stayVersion,targetListingId:'listing-'+target,note:'Student requested a different bed'});
}
function nextBed(id='bed-next'){insert('hostel_spaces',{id,room_id:'room',label:id,status:'AVAILABLE',created_at:stamp,updated_at:stamp});insert('hostel_listings',{id:'listing-'+id,space_id:id,period_id:'year',price:120000,status:'APPROVED',created_at:stamp,updated_at:stamp});}
test('transfer atomically preserves old evidence and starts a distinct handover even with the switch off',async()=>{
 const d=await submit();nextBed();db.exec("UPDATE platform_settings SET value='0'");resetPlatformSettingsCache();await transfer();
 const old=await conditions.conditionDetail(student,d.record.id);assert.ok(old.record.archivedAt);assert.equal(old.revisions.length,1);assert.ok(!old.actions.includes('AMEND'));const next=await start();assert.notEqual(next.record.id,d.record.id);assert.equal(next.record.spaceLabel,'bed-next');assert.equal(next.record.moveInRevision,0);assert.equal(next.events[0].action,'TRANSFER');
 await assert.rejects(update(d,'AMEND',{items:items(d)}),e=>e.status===409);
});
test('failed destination handover insert rolls back the whole room transfer',async()=>{
 await submit();nextBed();db.exec("CREATE TRIGGER fail_condition_transfer BEFORE INSERT ON hostel_condition_records BEGIN SELECT RAISE(ABORT,'handover unavailable'); END;");
 await assert.rejects(transfer(),/handover unavailable/);assert.equal(db.prepare('SELECT space_id FROM hostel_bookings').get().space_id,'bed');assert.equal(db.prepare("SELECT status FROM hostel_spaces WHERE id='bed-next'").get().status,'AVAILABLE');assert.equal(db.prepare('SELECT archived_at FROM hostel_condition_records').get().archived_at,'');
});
test('leaving and returning to the same bed creates separate assignment records',async()=>{
 const original=await submit();nextBed();insert('hostel_listings',{id:'listing-bed',space_id:'bed',period_id:'year',price:120000,status:'APPROVED',created_at:stamp,updated_at:stamp});await transfer();await transfer('bed');
 const current=await start();assert.notEqual(current.record.id,original.record.id);assert.equal(current.record.spaceLabel,original.record.spaceLabel);assert.equal(count('hostel_condition_records'),3);
});
test('settings are owner-controlled and changes do not rewrite existing checklists',async()=>{
 const d=await start();const body={propertyId:'property',enabled:true,version:1,checklist:['Mattress','Windows']};await assert.rejects(conditions.saveConditionConfig(manager,body),e=>e.status===403);const config=await conditions.saveConditionConfig(owner,body);assert.equal(config.checklist[0].label,'Mattress');assert.equal((await conditions.conditionDetail(student,d.record.id)).record.checklist[0].label,'Bed frame');await assert.rejects(conditions.saveConditionConfig(owner,body),e=>e.status===409);
});
test('record list paginates and supports room search and disagreement filters',async()=>{
 const d=await submit(),row=db.prepare('SELECT * FROM hostel_condition_records').get();for(let i=0;i<24;i++)insert('hostel_condition_records',{...row,id:'copy'+i,reference:'HC-COPY'+i,assignment_id:'assignment'+i,dispute_by:i===0?'STUDENT':''});
 assert.equal((await conditions.listConditionRecords(owner)).records.length,20);assert.equal((await conditions.listConditionRecords(owner,{page:2})).records.length,5);assert.equal((await conditions.listConditionRecords(owner,{disputed:true})).pagination.total,1);assert.equal((await conditions.listConditionRecords(student,{q:d.record.reference})).pagination.total,1);
});
test('routes require live sessions; revoked managers cannot export private evidence',async()=>{
 const {conditionRoute}=await vite.ssrLoadModule('/lib/hostel-engine/condition-http.ts');assert.equal((await conditionRoute(new Request('https://example.test/api/hostel/conditions'),'STUDENT')).status,401);
 const d=await submit();const cookie=`${consoleAuth.CONSOLE_SESSION_COOKIE}=${await consoleAuth.createConsoleSession({id:'Manager',role:'LANDLORD'})}`;
 const request=()=>new Request('https://example.test/api/console/hostel/conditions/export?id='+d.record.id,{headers:{cookie}});assert.equal((await conditionRoute(request(),'STAFF','export')).status,200);db.exec("UPDATE hostel_managers SET status='REVOKED'");assert.equal((await conditionRoute(request(),'STAFF','export')).status,403);
});

test('concurrent inspection submissions commit one version and clean losing photos',async()=>{
 const d=await start();const result=await Promise.allSettled([update(d,'SUBMIT',{items:items(d),photoItems:['bed']},student,[photo()]),update(d,'SUBMIT',{items:items(d),photoItems:['bed']},student,[photo()])]);
 assert.equal(result.filter(r=>r.status==='fulfilled').length,1);assert.equal(count('hostel_condition_revisions'),1);assert.equal(count('hostel_condition_photos'),1);assert.equal(objects.size,1);
});

test('the record photo limit rejects additional uploads without leaving orphan objects',async()=>{
 let d=await start();d=await update(d,'SUBMIT',{items:items(d),photoItems:['bed','bed','']},student,[photo(),photo(),photo()]);
 for(let i=0;i<9;i++)d=await update(d,'COMMENT',{photoItems:['bed','','']},student,[photo(),photo(),photo()]);
 assert.equal(objects.size,30);await assert.rejects(update(d,'COMMENT',{photoItems:['bed']},student,[photo()]),e=>e.status===409);assert.equal(objects.size,30);assert.equal(count('hostel_condition_photos'),30);
});
