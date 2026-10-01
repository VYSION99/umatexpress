import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

process.env.TURSO_DATABASE_URL = "https://hostel-m3-test.turso.io";
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
  assert.ok(target.startsWith("https://hostel-m3-test.turso.io"), "Tests must never access a real provider");
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
const engine=await vite.ssrLoadModule("/lib/hostel-engine/residency.ts");
const stays=await vite.ssrLoadModule("/lib/hostel-engine/stays.ts");
const {residentDashboard}=await vite.ssrLoadModule("/lib/hostel-engine/resident.ts");
const {ensureHostelOnboardingTables}=await vite.ssrLoadModule("/lib/hostel-engine/onboarding.ts");
const {ensureHostelPluginTables}=await vite.ssrLoadModule("/lib/hostel-engine/plugins.ts");
const {ensureHostelReviewTables}=await vite.ssrLoadModule("/lib/hostel-engine/reviews.ts");
const {ensureHostelRefundTables}=await vite.ssrLoadModule("/lib/hostel-engine/refunds.ts");
const {ensureHostelMessageTables}=await vite.ssrLoadModule("/lib/hostel-engine/message-schema.ts");
await engine.ensureHostelResidencyTables();
await ensureHostelOnboardingTables();
await Promise.all([ensureHostelPluginTables(),ensureHostelReviewTables(),ensureHostelRefundTables(),ensureHostelMessageTables()]);
const m3=await vite.ssrLoadModule('/lib/hostel-engine/stay-requests.ts');
const {ensureStayRequestTables}=await vite.ssrLoadModule('/lib/hostel-engine/stay-request-schema.ts');
const {setHostelRoomRate,submitHostelListing}=await vite.ssrLoadModule('/lib/hostel-engine/listings.ts');
await ensureStayRequestTables();
const stamp=new Date().toISOString();
const day=offset=>new Date(Date.now()+offset*86400000).toISOString().slice(0,10);
function insert(table,row){const keys=Object.keys(row);db.prepare(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(()=>"?").join(",")})`).run(...keys.map(key=>row[key]));}
function makeBed(id,price=120000){insert("hostel_spaces",{id,room_id:"room",label:id,status:"AVAILABLE",created_at:stamp,updated_at:stamp});insert("hostel_listings",{id:"listing-"+id,space_id:id,period_id:"year",price,status:"APPROVED",created_at:stamp,updated_at:stamp});return "listing-"+id;}
beforeEach(()=>{
  for(const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) if(!["schema_passes","campus_schema_meta"].includes(name))db.exec(`DELETE FROM "${name}"`);
  db.exec("DROP TRIGGER IF EXISTS fail_ledger; DROP TRIGGER IF EXISTS fail_stay_event;");
  insert("hostel_landlords",{id:"owner",name:"Owner",email:"owner@example.test",kyc_status:"VERIFIED",status:"ACTIVE",commission_bps:300,created_at:stamp,updated_at:stamp,payout_method:"MOMO",payout_account_last4:"1234",payout_bank_code:"MTN",payout_updated_at:stamp});
  insert("hostel_owner_onboarding",{landlord_id:"owner",profile_status:"APPROVED",payout_status:"APPROVED",payout_snapshot:JSON.stringify(["MOMO","1234","MTN",stamp]),updated_at:stamp});
  insert("hostel_properties",{id:"property",landlord_id:"owner",name:"Test Lodge",status:"APPROVED",created_at:stamp,updated_at:stamp});
  insert("hostel_rooms",{id:"room",property_id:"property",label:"A1",capacity:4,status:"ACTIVE",created_at:stamp,updated_at:stamp});
  insert("hostel_periods",{id:"year",name:"Current academic year",starts_on:day(-30),ends_on:day(180),active:1,created_at:stamp});
  insert("hostel_property_photos",{id:"photo",property_id:"property",status:"APPROVED",created_at:stamp});
  makeBed("bed-a");makeBed("bed-b");makeBed("expensive",140000);
});
const student=email=>({email,name:"Student",phone:"0240000000"});
const hold=(id="bed-a",email="student@st.umat.edu.gh")=>engine.startHostelBooking({listingId:"listing-"+id,student:student(email),origin:"https://example.test",secure:true});

const studentActor={kind:'STUDENT',email:'student@st.umat.edu.gh',name:'Student'};
const staff={kind:'STAFF',email:'owner@example.test',name:'Owner',landlordId:'owner',isOwner:true};
const mutation=()=>crypto.randomUUID();
async function setup(){
 const result=await hold();await engine.settleHostelBooking({reference:result.booking.reference,amount:120000,source:'test'});
 insert('platform_settings',{key:'hostel_stay_requests_enabled',value:'1',updated_at:stamp});
 insert('hostel_periods',{id:'next',name:'Next academic year',starts_on:day(181),ends_on:day(540),active:1,created_at:stamp});
 await m3.saveStayRequestConfig(staff,{propertyId:'property',version:0,movesEnabled:true,renewalsEnabled:true,periodId:'next',opensOn:day(-1),closesOn:day(30)});
 return result.booking.reference;
}
const create=(reference,kind='MOVE')=>m3.createStayRequest(studentActor,{reference,kind,preference:'Please arrange my stay.',mutationId:mutation()});
const update=(actor,record,action,extra={})=>m3.updateStayRequest(actor,record.id,{version:record.version,action,mutationId:mutation(),note:'Please arrange this request.',...extra},'https://example.test');
const offer=(record,listingId='listing-bed-b')=>update(staff,record,'OFFER',{listingId,expiresAt:new Date(Date.now()+86400000).toISOString()});
test('room change requires student acceptance and preserves atomic key/assignment history',async()=>{
 const reference=await setup();let d=await create(reference);d=await offer(d.record);
 await assert.rejects(update(staff,d.record,'FULFILL',{stayVersion:0}),/not available/);
 d=await update(studentActor,d.record,'ACCEPT');d=await update(staff,d.record,'FULFILL',{stayVersion:0});
 assert.equal(d.record.status,'FULFILLED');assert.equal((await engine.getHostelBookingByReference(reference)).spaceId,'bed-b');
 assert.equal(db.prepare('SELECT space_id FROM hostel_bed_claims WHERE period_id=?').get('year').space_id,'bed-b');
 assert.equal(db.prepare("SELECT COUNT(*) n FROM hostel_stay_events WHERE action='TRANSFER'").get().n,1);
});
test('renewal books next year without changing current occupancy and retries do not duplicate checkout',async()=>{
 const reference=await setup();await setHostelRoomRate('owner',{roomId:'room',periodId:'next',price:130000});
 const listing=db.prepare("SELECT id FROM hostel_listings WHERE space_id='bed-a' AND period_id='next'").get();
 await submitHostelListing('owner',listing.id);db.prepare("UPDATE hostel_listings SET status='APPROVED' WHERE period_id='next'").run();
 let d=await create(reference,'RENEWAL');d=await offer(d.record,listing.id);
 const body={version:d.record.version,action:'ACCEPT',mutationId:mutation()};
 d=await m3.updateStayRequest(studentActor,d.record.id,body,'https://example.test');assert.equal(d.record.status,'PAYMENT_PENDING');assert.ok(d.record.checkoutUrl);
 const again=await m3.updateStayRequest(studentActor,d.record.id,body,'https://example.test');assert.equal(again.record.checkoutReference,d.record.checkoutReference);
 assert.equal(db.prepare("SELECT status FROM hostel_spaces WHERE id='bed-a'").get().status,'OCCUPIED');
 await engine.settleHostelBooking({reference:d.record.checkoutReference,amount:130000,source:'test'});
 d=await m3.stayRequestDetail(studentActor,d.record.id);assert.equal(d.record.status,'FULFILLED');
 assert.equal(db.prepare("SELECT COUNT(*) n FROM hostel_bed_claims WHERE space_id='bed-a'").get().n,2);
 await stays.updateHostelStay({landlordId:'owner',reference,actor:'owner',action:'CHECK_IN',version:0});
 await stays.updateHostelStay({landlordId:'owner',reference,actor:'owner',action:'CHECK_OUT',version:1,note:'End of current residency'});
 assert.equal(db.prepare("SELECT status FROM hostel_spaces WHERE id='bed-a'").get().status,'AVAILABLE');
 assert.equal(db.prepare("SELECT COUNT(*) n FROM hostel_bed_claims WHERE space_id='bed-a' AND period_id='next'").get().n,1);
 await assert.rejects(engine.startHostelBooking({listingId:listing.id,student:student('other@st.umat.edu.gh'),origin:'https://example.test',secure:true}),/taken/);
});
async function renewalOffer(){const reference=await setup();await setHostelRoomRate('owner',{roomId:'room',periodId:'next',price:130000});db.prepare("UPDATE hostel_listings SET status='APPROVED' WHERE period_id='next'").run();const listingId=db.prepare("SELECT id FROM hostel_listings WHERE period_id='next' AND space_id='bed-a'").get().id;return {reference,listingId,detail:await offer((await create(reference,'RENEWAL')).record,listingId)};}
test('another student or hostel cannot read or mutate a request',async()=>{const d=await create(await setup());for(const actor of [{...studentActor,email:'other@example.test'},{...staff,landlordId:'other'}]){await assert.rejects(m3.stayRequestDetail(actor,d.record.id),/not found/);await assert.rejects(update(actor,d.record,'CANCEL'),/not found/);}});
test('owner-only settings reject managers, invalid windows and stale edits',async()=>{await setup();const config=await m3.stayRequestConfig(staff,{propertyId:'property'});await assert.rejects(m3.saveStayRequestConfig({...staff,isOwner:false},config),/Only the owner/);await assert.rejects(m3.saveStayRequestConfig(staff,{...config,closesOn:day(182)}),/window/);await m3.saveStayRequestConfig(staff,{...config,movesEnabled:false});await assert.rejects(m3.saveStayRequestConfig(staff,config),/changed/);});
test('create retries are idempotent and changed content or another open request conflicts',async()=>{const reference=await setup(),body={reference,kind:'MOVE',preference:'A quiet room please.',mutationId:mutation()};const a=await m3.createStayRequest(studentActor,body),b=await m3.createStayRequest(studentActor,body);assert.equal(a.record.id,b.record.id);await assert.rejects(m3.createStayRequest(studentActor,{...body,preference:'Different text'}),/changed/);await assert.rejects(create(reference),/open request/);assert.equal(db.prepare('SELECT COUNT(*) n FROM hostel_stay_requests').get().n,1);});
test('a changed next-year price, approval or configuration requires a fresh offer',async()=>{const {detail,listingId}=await renewalOffer();db.prepare('UPDATE hostel_listings SET price=price+100 WHERE id=?').run(listingId);await assert.rejects(update(studentActor,detail.record,'ACCEPT'),/changed/);db.prepare('UPDATE hostel_listings SET price=price-100 WHERE id=?').run(listingId);const c=await m3.stayRequestConfig(staff,{propertyId:'property'});await m3.saveStayRequestConfig(staff,{...c,closesOn:day(29)});await assert.rejects(update(studentActor,detail.record,'ACCEPT'),/changed/);assert.equal(db.prepare("SELECT COUNT(*) n FROM hostel_bookings WHERE period_id='next'").get().n,0);});
test('expired offers cannot be accepted and remain in the activity history',async()=>{let d=await create(await setup());d=await offer(d.record);db.prepare('UPDATE hostel_stay_requests SET expires_at=? WHERE id=?').run(new Date(Date.now()-1000).toISOString(),d.record.id);await assert.rejects(update(studentActor,d.record,'ACCEPT'),/changed|available/);d=await m3.stayRequestDetail(studentActor,d.record.id);assert.equal(d.record.status,'EXPIRED');assert.ok(d.events.some(e=>e.action==='EXPIRED'));});
test('a new quote clears student acceptance; different-price transfers are unavailable',async()=>{let d=await create(await setup());await assert.rejects(offer(d.record,'listing-expensive'),/same rent/);d=await offer(d.record);d=await update(studentActor,d.record,'ACCEPT');d=await offer(d.record);assert.equal(d.record.status,'OFFERED');await assert.rejects(update(staff,d.record,'FULFILL',{stayVersion:0}),/not available/);});
test('a pending refund or departed stay blocks submission and handover',async()=>{const reference=await setup();let d=await create(reference);d=await offer(d.record);d=await update(studentActor,d.record,'ACCEPT');const b=await engine.getHostelBookingByReference(reference);insert('hostel_refunds',{id:'refund',booking_id:b.id,reference,landlord_id:'owner',student_email:studentActor.email,status:'REQUESTED',reason:'Change of plans',created_at:stamp,updated_at:stamp});await assert.rejects(update(staff,d.record,'FULFILL',{stayVersion:0}),/changed/);assert.equal((await engine.getHostelBookingByReference(reference)).spaceId,'bed-a');});
test('fulfillment rolls back both transfer and request when the M3 audit cannot be written',async()=>{const reference=await setup();let d=await offer((await create(reference)).record);d=await update(studentActor,d.record,'ACCEPT');db.exec("CREATE TRIGGER fail_m3_event BEFORE INSERT ON hostel_stay_request_events WHEN NEW.action='FULFILL' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END");try{await assert.rejects(update(staff,d.record,'FULFILL',{stayVersion:0}),/audit unavailable/);assert.equal((await engine.getHostelBookingByReference(reference)).spaceId,'bed-a');assert.equal((await m3.stayRequestDetail(studentActor,d.record.id)).record.status,'ACCEPTED');}finally{db.exec('DROP TRIGGER fail_m3_event');}});
test('simultaneous acceptance creates one new-year checkout and an independent payout accrual',async()=>{const {detail}=await renewalOffer();const results=await Promise.allSettled([update(studentActor,detail.record,'ACCEPT'),update(studentActor,detail.record,'ACCEPT')]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);const d=await m3.stayRequestDetail(studentActor,detail.record.id);assert.equal(db.prepare("SELECT COUNT(*) n FROM hostel_bookings WHERE period_id='next'").get().n,1);await engine.settleHostelBooking({reference:d.record.checkoutReference,amount:130000,source:'test'});await engine.settleHostelBooking({reference:d.record.checkoutReference,amount:130000,source:'retry'});assert.equal(db.prepare('SELECT COUNT(*) n FROM hostel_payouts').get().n,2);assert.equal(db.prepare('SELECT SUM(gross_amount) n FROM hostel_payouts').get().n,250000);});
test('a competing next-year booking prevents accepting the renewal offer',async()=>{const {detail,listingId}=await renewalOffer();await engine.startHostelBooking({listingId,student:student('another@st.umat.edu.gh'),origin:'https://example.test',secure:true});await assert.rejects(update(studentActor,detail.record,'ACCEPT'),/changed/);assert.equal(db.prepare("SELECT COUNT(*) n FROM hostel_bookings WHERE period_id='next'").get().n,1);});
test('abandoned renewal releases only its year claim; late payment goes to review',async()=>{const {detail,reference}=await renewalOffer();const d=await update(studentActor,detail.record,'ACCEPT');await engine.expireHostelBooking(d.record.checkoutReference);assert.equal((await engine.getHostelBookingByReference(reference)).status,'PAID');assert.equal(db.prepare("SELECT status FROM hostel_spaces WHERE id='bed-a'").get().status,'OCCUPIED');assert.equal(db.prepare("SELECT COUNT(*) n FROM hostel_bed_claims WHERE period_id='next'").get().n,0);assert.equal((await m3.stayRequestDetail(studentActor,d.record.id)).record.status,'EXPIRED');await engine.settleHostelBooking({reference:d.record.checkoutReference,amount:130000,source:'late'});assert.equal((await m3.stayRequestDetail(studentActor,d.record.id)).record.status,'PAYMENT_REVIEW');assert.equal(db.prepare('SELECT COUNT(*) n FROM hostel_payouts').get().n,1);});
test('claim migration protects future beds from retirement and normal direct checkout duplication',async()=>{const {detail,listingId}=await renewalOffer();await update(studentActor,detail.record,'ACCEPT');assert.throws(()=>db.prepare("UPDATE hostel_spaces SET status='RETIRED' WHERE id='bed-a'").run(),/YEAR_RESERVATION/);await assert.rejects(engine.startHostelBooking({listingId,student:student('another@st.umat.edu.gh'),origin:'https://example.test',secure:true}),/taken/);});
test('cross-origin and unsigned M3 requests are rejected by both audiences',async()=>{const {stayRequestRoute}=await vite.ssrLoadModule('/lib/hostel-engine/stay-request-http.ts');for(const audience of ['STUDENT','STAFF']){const response=await stayRequestRoute(new Request('https://example.test/api/stay-requests',{method:'POST',headers:{origin:'https://evil.test'},body:'{}'}),audience);assert.equal(response.status,403);const read=await stayRequestRoute(new Request('https://example.test/api/stay-requests'),audience);assert.equal(read.status,401);}});
test('future-only residents cannot read current private announcements',async()=>{const {detail}=await renewalOffer();const d=await update(studentActor,detail.record,'ACCEPT');await engine.settleHostelBooking({reference:d.record.checkoutReference,amount:130000,source:'test'});db.prepare("UPDATE hostel_stays SET status='CHECKED_OUT' WHERE booking_id=(SELECT id FROM hostel_bookings WHERE period_id='year')").run();insert('hostel_announcements',{id:'private',landlord_id:'owner',property_id:'property',title:'Current resident notice',body:'Private current-year message',status:'PUBLISHED',created_at:stamp,updated_at:stamp});assert.equal((await residentDashboard(studentActor.email)).announcements.length,0);});
test('switching off new offers still permits cancellation and accepted handovers',async()=>{const reference=await setup();let d=await offer((await create(reference)).record);d=await update(studentActor,d.record,'ACCEPT');db.prepare("UPDATE platform_settings SET value='0' WHERE key='hostel_stay_requests_enabled'").run();d=await update(staff,d.record,'FULFILL',{stayVersion:0});assert.equal(d.record.status,'FULFILLED');await assert.rejects(create(reference),/changed|unavailable/);});
test('bulk next-year pricing and submission include beds occupied this year',async()=>{await setup();db.prepare("UPDATE hostel_rooms SET label='A 1' WHERE id='room'").run();const batches=await vite.ssrLoadModule('/lib/hostel-engine/room-batches.ts');const input={propertyId:'property',prefix:'A',start:1,end:1,width:1,periodId:'next',price:135000};const priced=await batches.priceHostelRoomRange('owner',input);assert.equal(priced.changed,3);await batches.submitHostelRoomRange('owner',input);assert.equal(db.prepare("SELECT COUNT(*) n FROM hostel_listings WHERE period_id='next' AND status='PENDING_REVIEW'").get().n,3);});
test('late renewal payment is retained for review even after a replacement request exists',async()=>{const {detail,reference}=await renewalOffer();const d=await update(studentActor,detail.record,'ACCEPT');await engine.expireHostelBooking(d.record.checkoutReference);await create(reference,'RENEWAL');await engine.settleHostelBooking({reference:d.record.checkoutReference,amount:130000,source:'late'});assert.equal((await m3.stayRequestDetail(studentActor,d.record.id)).record.status,'PAYMENT_REVIEW');assert.equal((await engine.getHostelBookingByReference(d.record.checkoutReference)).status,'PAYMENT_REVIEW');});
test('renewal payment does not permit services or a lived-in review before the new year',async()=>{const {detail}=await renewalOffer();const d=await update(studentActor,detail.record,'ACCEPT');await engine.settleHostelBooking({reference:d.record.checkoutReference,amount:130000,source:'test'});const booking=await engine.getHostelBookingByReference(d.record.checkoutReference);const {submitHostelReview}=await vite.ssrLoadModule('/lib/hostel-engine/reviews.ts');await assert.rejects(submitHostelReview({booking,rating:5,body:'I have not stayed yet.'}),/Reviews open/);const {requestHostelService}=await vite.ssrLoadModule('/lib/hostel-engine/plugins.ts');insert('hostel_plugins',{id:'wifi',code:'WIFI',name:'Wi-Fi',category:'UTILITY',price:0,active:1,created_at:stamp,updated_at:stamp});insert('hostel_plugin_subscriptions',{id:'sub',reference:'HP-WIFI',landlord_id:'owner',plugin_id:'wifi',period_id:'next',property_id:'property',platform_price:0,resident_price:0,status:'ACTIVE',created_at:stamp,updated_at:stamp});await assert.rejects(requestHostelService({booking,pluginId:'wifi'}),/stay has ended|service already/);assert.equal(db.prepare('SELECT COUNT(*) n FROM hostel_service_requests').get().n,0);});
