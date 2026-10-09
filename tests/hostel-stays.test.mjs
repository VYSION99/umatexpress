import assert from "node:assert/strict";
import test, { after, beforeEach } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

process.env.TURSO_DATABASE_URL = "https://hostel-stays-test.turso.io";
process.env.TURSO_AUTH_TOKEN = "test-token";
process.env.PAYSTACK_SECRET_KEY = "sk_test_stays";
process.env.CONSOLE_SESSION_SECRET = "stay-test-console-secret-at-least-32-characters";
const db = new DatabaseSync(":memory:");
let requests = 0;
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
  assert.ok(target.startsWith("https://hostel-stays-test.turso.io"), "Tests must never access a real provider");
  requests++;
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
const {hostelResidentList}=await vite.ssrLoadModule("/lib/hostel-engine/resident-list.ts");
const {ensureHostelOnboardingTables}=await vite.ssrLoadModule("/lib/hostel-engine/onboarding.ts");
const {ensureHostelPluginTables}=await vite.ssrLoadModule("/lib/hostel-engine/plugins.ts");
const {ensureHostelReviewTables}=await vite.ssrLoadModule("/lib/hostel-engine/reviews.ts");
const {ensureHostelRefundTables}=await vite.ssrLoadModule("/lib/hostel-engine/refunds.ts");
const {ensureHostelMessageTables}=await vite.ssrLoadModule("/lib/hostel-engine/message-schema.ts");
await engine.ensureHostelResidencyTables();
await ensureHostelOnboardingTables();
await Promise.all([ensureHostelPluginTables(),ensureHostelReviewTables(),ensureHostelRefundTables(),ensureHostelMessageTables()]);
const stamp=new Date().toISOString();
const day=offset=>new Date(Date.now()+offset*86400000).toISOString().slice(0,10);
function insert(table,row){const keys=Object.keys(row);db.prepare(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(()=>"?").join(",")})`).run(...keys.map(key=>row[key]));}
function makeBed(id,price=120000){insert("hostel_spaces",{id,room_id:"room",label:id,status:"AVAILABLE",created_at:stamp,updated_at:stamp});insert("hostel_listings",{id:"listing-"+id,space_id:id,period_id:"year",price,status:"APPROVED",created_at:stamp,updated_at:stamp});return "listing-"+id;}
beforeEach(()=>{
  const financeTriggers=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND (name LIKE 'finance_%' OR name LIKE 'ledger_%')").all();
  for(const trigger of financeTriggers) db.exec(`DROP TRIGGER "${trigger.name}"`);
  db.exec("PRAGMA foreign_keys=OFF");
  for(const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) if(!["schema_passes","campus_schema_meta"].includes(name))db.exec(`DELETE FROM "${name}"`);
  db.exec("PRAGMA foreign_keys=ON");
  for(const trigger of financeTriggers) db.exec(trigger.sql);
  db.exec("DROP TRIGGER IF EXISTS fail_ledger; DROP TRIGGER IF EXISTS fail_stay_event;");
  insert("hostel_landlords",{id:"owner",name:"Owner",email:"owner@example.test",kyc_status:"VERIFIED",status:"ACTIVE",commission_bps:300,created_at:stamp,updated_at:stamp,payout_method:"MOMO",payout_account_last4:"1234",payout_bank_code:"MTN",payout_updated_at:stamp});
  insert("hostel_owner_onboarding",{landlord_id:"owner",profile_status:"APPROVED",payout_status:"APPROVED",payout_snapshot:JSON.stringify(["MOMO","1234","MTN",stamp]),updated_at:stamp});
  insert("hostel_properties",{id:"property",landlord_id:"owner",name:"Test Lodge",status:"APPROVED",created_at:stamp,updated_at:stamp});
  insert("hostel_rooms",{id:"room",property_id:"property",label:"A1",capacity:4,status:"ACTIVE",created_at:stamp,updated_at:stamp});
  insert("hostel_periods",{id:"year",name:"Current academic year",starts_on:day(-30),ends_on:day(180),active:1,created_at:stamp});
  insert("hostel_property_photos",{id:"photo",property_id:"property",status:"APPROVED",created_at:stamp});
  makeBed("bed-a");makeBed("bed-b");makeBed("expensive",140000);
  requests=0;
});
const student=email=>({email,name:"Student",phone:"0240000000"});
const hold=(id="bed-a",email="student@st.umat.edu.gh")=>engine.startHostelBooking({listingId:"listing-"+id,student:student(email),origin:"https://example.test",secure:true});
async function paid(){const held=await hold();return (await engine.settleHostelBooking({reference:held.booking.reference,amount:held.booking.totalAmount,source:"test"})).booking;}
const act=(booking,action,extra={})=>stays.updateHostelStay({landlordId:"owner",reference:booking.reference,version:booking.stayVersion,actor:"manager@example.test",action,...extra});

test("concurrent pending checkouts for one student cannot claim two beds",async()=>{
 const results=await Promise.allSettled([hold("bed-a"),hold("bed-b")]);
 assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
 assert.equal(results.find(r=>r.status==="rejected").reason.code,"CONFLICT");
 assert.equal(db.prepare("SELECT COUNT(*) n FROM hostel_bookings").get().n,1);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM hostel_spaces WHERE status='RESERVED'").get().n,1);
});
test("a failed settlement rolls back the payment, bed and ledger and retry completes once",async()=>{
 const held=await hold();db.exec("CREATE TRIGGER fail_ledger BEFORE INSERT ON hostel_payouts BEGIN SELECT RAISE(ABORT,'ledger unavailable'); END;");
 const input={reference:held.booking.reference,amount:held.booking.totalAmount,source:"test"};
 await assert.rejects(engine.settleHostelBooking(input),/ledger unavailable/);
 assert.equal(db.prepare("SELECT status FROM hostel_bookings").get().status,"PENDING_PAYMENT");
 assert.equal(db.prepare("SELECT status FROM hostel_spaces WHERE id='bed-a'").get().status,"RESERVED");
 db.exec("DROP TRIGGER fail_ledger;");await engine.settleHostelBooking(input);await engine.settleHostelBooking(input);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM hostel_payouts").get().n,1);
 assert.equal(db.prepare("SELECT status FROM hostel_spaces WHERE id='bed-a'").get().status,"OCCUPIED");
});
test("retry repairs a historical paid booking with a missing ledger entry",async()=>{
 const booking=await paid();const guard=db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='finance_hostel_payouts_no_delete'").get()?.sql;db.exec("DROP TRIGGER IF EXISTS finance_hostel_payouts_no_delete; DELETE FROM hostel_payouts;");if(guard)db.exec(guard);
 await engine.settleHostelBooking({reference:booking.reference,amount:booking.totalAmount,source:"retry"});
 assert.equal(db.prepare("SELECT COUNT(*) n FROM hostel_payouts").get().n,1);
});
test("arrival, keys and checkout follow a versioned audited lifecycle without rewriting payment",async()=>{
 let booking=await paid();
 let detail=await act(booking,"SCHEDULE",{expectedArrivalOn:day(0)});booking=detail.booking;
 detail=await act(booking,"CHECK_IN",{keyReference:"A1-2"});
 await assert.rejects(act(booking,"CHECK_IN"),e=>e.code==="CONFLICT");booking=detail.booking;
 await assert.rejects(act(booking,"CHECK_OUT",{note:"Leaving"}),/returned/);
 detail=await act(booking,"CHECK_OUT",{note:"Inspection complete",keysReturned:true});
 assert.equal(detail.booking.status,"PAID");assert.equal(detail.booking.stayStatus,"CHECKED_OUT");
 assert.equal(db.prepare("SELECT status FROM hostel_spaces WHERE id='bed-a'").get().status,"AVAILABLE");
 assert.equal(detail.events.length,3);assert.ok(detail.events.every(e=>e.actor==="manager@example.test"));
});
test("a failed audit write rolls back check-in",async()=>{
 const booking=await paid();db.exec("CREATE TRIGGER fail_stay_event BEFORE INSERT ON hostel_stay_events BEGIN SELECT RAISE(ABORT,'audit unavailable'); END;");
 await assert.rejects(act(booking,"CHECK_IN"),/audit unavailable/);
 assert.equal((await engine.getHostelBookingByReference(booking.reference)).stayStatus,"EXPECTED");
});
test("transfers preserve the price, free the old bed and refuse stale, occupied or differently priced destinations",async()=>{
 const booking=await paid();await assert.rejects(act(booking,"TRANSFER",{targetListingId:"listing-expensive",note:"Change room"}),e=>e.status===409);
 const changed=await act(booking,"TRANSFER",{targetListingId:"listing-bed-b",note:"Requested by student"});
 assert.equal(changed.booking.spaceId,"bed-b");assert.equal(changed.booking.totalAmount,booking.totalAmount);
 assert.equal(db.prepare("SELECT status FROM hostel_spaces WHERE id='bed-a'").get().status,"AVAILABLE");
 assert.equal(db.prepare("SELECT status FROM hostel_spaces WHERE id='bed-b'").get().status,"OCCUPIED");
 await assert.rejects(act(booking,"TRANSFER",{targetListingId:"listing-bed-a",note:"Stale"}),e=>e.code==="CONFLICT");
 await assert.rejects(stays.hostelStayDetail("another-owner",booking.reference),e=>e.status===404);
});
test("no-show releases occupancy and rejects early or repeated actions",async()=>{
 let booking=await paid();booking=(await act(booking,"SCHEDULE",{expectedArrivalOn:day(2)})).booking;
 await assert.rejects(act(booking,"NO_SHOW",{note:"Missing"}),/arrival date/);
 booking=(await act(booking,"SCHEDULE",{expectedArrivalOn:day(0)})).booking;
 const result=await act(booking,"NO_SHOW",{note:"Confirmed with student"});
 assert.equal(result.booking.stayStatus,"NO_SHOW");assert.equal(result.booking.status,"PAID");
 await assert.rejects(act(result.booking,"CHECK_IN"),e=>e.status===409);
});
test("cancelled and departed residents do not receive newly published private notices",async()=>{
 const booking=await paid();insert("hostel_announcements",{id:"notice",landlord_id:"owner",property_id:"property",title:"Residents only",body:"Building notice",status:"PUBLISHED",created_at:stamp,updated_at:stamp});
 assert.equal((await residentDashboard(booking.studentEmail)).announcements.length,1);
 db.prepare("UPDATE hostel_bookings SET status='CANCELLED' WHERE id=?").run(booking.id);
 assert.equal((await residentDashboard(booking.studentEmail)).residencies.length,0);
 const history=await residentDashboard(booking.studentEmail,{view:"history"});assert.equal(history.residencies.length,1);assert.equal(history.announcements.length,0);
});
test("current dashboard includes pending checkout and uses a bounded number of round trips",async()=>{
 const held=await hold();requests=0;const dashboard=await residentDashboard(held.booking.studentEmail);
 assert.equal(dashboard.residencies[0].booking.status,"PENDING_PAYMENT");assert.equal(dashboard.historyTotal,0);
 assert.ok(requests<=4,`Expected batched reads, got ${requests}`);
});
test("staff resident roster starts at confirmed payment and retains paid stay history",async()=>{
 const held=await hold();
 assert.equal((await hostelResidentList("owner")).summary.total,0);
 const paidBooking=(await engine.settleHostelBooking({reference:held.booking.reference,amount:held.booking.totalAmount,source:"test"})).booking;
 assert.equal((await hostelResidentList("owner")).summary.total,1);
 db.prepare("UPDATE hostel_bookings SET status='CANCELLED' WHERE id=?").run(paidBooking.id);
 const cancelled=await hostelResidentList("owner",{status:"CANCELLED"});
 assert.equal(cancelled.summary.total,1);
 assert.equal(cancelled.residents[0].reference,paidBooking.reference);
 const review=await hold("bed-b","review@st.umat.edu.gh");
 db.prepare("UPDATE hostel_bookings SET status='PAYMENT_REVIEW',paid_at=? WHERE id=?").run(stamp,review.booking.id);
 assert.equal((await hostelResidentList("owner")).summary.total,1);
});
test("staff pagination totals cover more than 200 records and respect academic year and property filters",async()=>{
 const original=await paid();const row=db.prepare("SELECT * FROM hostel_bookings WHERE id=?").get(original.id);
 for(let i=0;i<224;i++)insert("hostel_bookings",{...row,id:"bulk-"+i,reference:"HF-BULK-"+i,space_id:"bulk-bed-"+i,student_email:`bulk-${i}@st.umat.edu.gh`});
 const first=await hostelResidentList("owner",{periodId:"year",propertyId:"property"});
 assert.equal(first.residents.length,20);assert.equal(first.summary.total,225);assert.equal(first.summary.bedRevenue,225*original.totalAmount);assert.equal(first.pagination.pages,12);
 const last=await hostelResidentList("owner",{page:12});assert.equal(last.residents.length,5);
 assert.equal((await hostelResidentList("another-owner")).pagination.total,0);
 assert.equal((await hostelResidentList("owner",{periodId:"another-year"})).summary.total,0);
});

test("a stale service form cannot create requests after checkout or the academic year ends",async()=>{
 const {requestHostelService}=await vite.ssrLoadModule('/lib/hostel-engine/plugins.ts');
 let booking=await paid();
 const plugin=db.prepare("SELECT * FROM hostel_plugins LIMIT 1").get();
 // beforeEach clears the catalogue after schema setup, so seed an explicitly available service.
 const pluginId=plugin?.id || 'wifi-test';
 if(!plugin) insert('hostel_plugins',{id:pluginId,code:'TEST',name:'Wi-Fi',category:'UTILITY',price:0,active:1,created_at:stamp,updated_at:stamp});
 insert('hostel_plugin_subscriptions',{id:'subscription',reference:'HP-TEST',landlord_id:'owner',plugin_id:pluginId,period_id:'year',property_id:'property',platform_price:0,resident_price:0,status:'ACTIVE',created_at:stamp,updated_at:stamp});
 await requestHostelService({booking,pluginId});
 assert.equal(db.prepare('SELECT COUNT(*) n FROM hostel_service_requests').get().n,1);
 db.exec("UPDATE hostel_service_requests SET status='APPROVED'");
 assert.equal((await hostelResidentList('owner')).summary.openServices,1);
 db.exec("UPDATE hostel_service_requests SET status='COMPLETED'");
 const checkedIn=(await act(booking,'CHECK_IN')).booking;
 await act(checkedIn,'CHECK_OUT',{note:'Leaving'});
 await assert.rejects(requestHostelService({booking,pluginId}),e=>e.code==='INVALID_STATE');
 assert.equal(db.prepare('SELECT COUNT(*) n FROM hostel_service_requests').get().n,1);
 db.exec("UPDATE hostel_stays SET status='EXPECTED'");db.prepare('UPDATE hostel_periods SET ends_on=?').run(day(-1));
 await assert.rejects(requestHostelService({booking,pluginId}),e=>e.status===409);
});
test('refund approval after checkout never frees the next student’s occupied bed',async()=>{
 const {approveHostelRefund}=await vite.ssrLoadModule('/lib/hostel-engine/refunds.ts');
 let booking=await paid();booking=(await act(booking,'CHECK_IN')).booking;await act(booking,'CHECK_OUT',{note:'Leaving early'});
 const next=await hold('bed-a','next@st.umat.edu.gh');await engine.settleHostelBooking({reference:next.booking.reference,amount:next.booking.totalAmount,source:'test'});
 // A historical exception awaiting review must not release a later occupant's bed.
 const refund={id:'historical-refund'};insert('hostel_refunds',{id:refund.id,booking_id:booking.id,reference:booking.reference,landlord_id:'owner',student_email:booking.studentEmail,status:'REQUESTED',created_at:stamp,updated_at:stamp});
 const key=process.env.PAYSTACK_SECRET_KEY;delete process.env.PAYSTACK_SECRET_KEY;
 try{await approveHostelRefund({refundId:refund.id,actor:'admin@example.test',overridePercent:0,reason:'Record zero-value cancellation'});}finally{process.env.PAYSTACK_SECRET_KEY=key;}
 assert.equal(db.prepare("SELECT status FROM hostel_spaces WHERE id='bed-a'").get().status,'OCCUPIED');
 assert.equal((await engine.getHostelBookingByReference(next.booking.reference)).status,'PAID');
});
test('an expired hold after a former resident leaves releases the bed',async()=>{
 let booking=await paid();booking=(await act(booking,'CHECK_IN')).booking;await act(booking,'CHECK_OUT',{note:'Leaving'});
 const next=await hold('bed-a','next@st.umat.edu.gh');
 db.prepare('UPDATE hostel_bookings SET hold_expires_at=? WHERE reference=?').run(new Date(Date.now()-3600000).toISOString(),next.booking.reference);
 await engine.releaseExpiredHostelHolds({graceMinutes:0});
 assert.equal(db.prepare("SELECT status FROM hostel_spaces WHERE id='bed-a'").get().status,'AVAILABLE');
});
test('checked-in transfers require key return and replace the key reference',async()=>{
 let booking=await paid();booking=(await act(booking,'CHECK_IN',{keyReference:'A1'})).booking;
 await assert.rejects(act(booking,'TRANSFER',{note:'Room change',targetListingId:'listing-bed-b'}),/returned/);
 const result=await act(booking,'TRANSFER',{note:'Room change',targetListingId:'listing-bed-b',keysReturned:true,keyReference:'B2'});
 assert.equal(result.stay.key_reference,'B2');assert.equal(result.booking.stayStatus,'CHECKED_IN');
});
test('a pending refund blocks check-in, departure, and transfer',async()=>{
 const booking=await paid();insert('hostel_refunds',{id:'refund',booking_id:booking.id,reference:booking.reference,student_email:booking.studentEmail,status:'REQUESTED',created_at:stamp,updated_at:stamp});
 await assert.rejects(act(booking,'CHECK_IN'),e=>e.status===409);
 await assert.rejects(act(booking,'NO_SHOW',{note:'No arrival'}),e=>e.status===409);
 await assert.rejects(act(booking,'TRANSFER',{note:'Move',targetListingId:'listing-bed-b'}),e=>e.status===409);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM hostel_stay_events').get().n,0);
});
test('residency endpoints reject unsigned requests before reading resident details',async()=>{
 const route=await vite.ssrLoadModule('/app/api/console/hostel/residents/stay/route.ts');
 for(const method of ['GET','PATCH']) {
   const response=await route[method](new Request('https://example.test/api/console/hostel/residents/stay?reference=HF-TEST',{method,...(method==='PATCH'?{headers:{'content-type':'application/json'},body:'{}'}:{})}));
   assert.equal(response.status,401);
 }
});
