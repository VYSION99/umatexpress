import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { sqliteTurso } from "./helpers/sqlite-turso.mjs";

const saved = { url: process.env.TURSO_DATABASE_URL, token: process.env.TURSO_AUTH_TOKEN };
process.env.TURSO_DATABASE_URL = "https://food-payments-test.turso.io";
process.env.TURSO_AUTH_TOKEN = "test";
const sql = sqliteTurso();
const originalFetch = globalThis.fetch;
globalThis.fetch = sql.fetch;
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ configFile:false, appType:"custom", root, resolve:{ alias:{ "@":root } }, plugins:[{ name:"food-payment-notices", enforce:"pre", resolveId(source){ if(source==="@/lib/notify-templates") return "\0notices"; }, load(id){ if(id==="\0notices") return "export async function notifyParty(){return {status:'QUEUED'}}"; } }], server:{ middlewareMode:true, hmr:false } });
after(async()=>{ await vite.close(); sql.db.close(); globalThis.fetch=originalFetch; if(saved.url===undefined) delete process.env.TURSO_DATABASE_URL; else process.env.TURSO_DATABASE_URL=saved.url; if(saved.token===undefined) delete process.env.TURSO_AUTH_TOKEN; else process.env.TURSO_AUTH_TOKEN=saved.token; });

const payments = await vite.ssrLoadModule("/lib/food/payments.ts");
const finance = await vite.ssrLoadModule("/lib/payments/schema.ts");
const providerId = "food-provider-payments";
const now = new Date().toISOString();

function addOrder(id, status="ACCEPTED") {
  sql.db.prepare(`INSERT INTO food_preorders(id,reference,provider_id,student_id,student_name,student_email,pickup_at,status,total_pesewas,response_due_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?, ?,10000,?,?,?)`).run(id,`ORDER-${id}`,providerId,"student-1","Student","student@st.umat.edu.gh",new Date(Date.now()+3600000).toISOString(),status,new Date(Date.now()+1800000).toISOString(),now,now);
}
function addPayment(orderId, reference, status="PENDING", delay=0) {
  sql.db.prepare("INSERT INTO payment_intents(id,product,order_reference,customer,amount,currency,created_at) VALUES(?,?,?,?,?,'GHS',?)").run(`intent-${reference}`,"FOOD",`ORDER-${orderId}`,"student@st.umat.edu.gh",10200,now);
  sql.db.prepare("INSERT INTO payment_attempts(reference,intent_id,provider,state,amount,currency,updated_at) VALUES(?,?,'PAYSTACK',?,10200,'GHS',?)").run(reference,`intent-${reference}`,status==="SUCCESSFUL"?"SUCCESSFUL":"PENDING",now);
  sql.db.prepare(`INSERT INTO food_payments(id,preorder_id,provider_id,reference,status,currency,base_amount,fee_amount,amount,commission_amount,vendor_amount,settlement_delay_minutes,paid_at,created_at,updated_at)
    VALUES(?,?,?,?,?,'GHS',10000,200,10200,1000,9000,?,?,?,?)`).run(`payment-${reference}`,orderId,providerId,reference,status,delay,status==="SUCCESSFUL"?now:"",now,now);
}

before(async()=>{
  await payments.ensureFoodPaymentTables();
  await finance.ensureFinanceSchema();
  sql.db.prepare(`INSERT INTO food_providers(id,name,location,contact_label,contact_href,hours,status,created_by,created_at,updated_at)
    VALUES(?,?,?,?,?,?,'PUBLISHED',?,?,?)`).run(providerId,"Payment Kitchen","Campus","Call","tel:+233200000000","Daily","staff",now,now);
});

test("amount mismatch enters terminal review and late failure cannot overwrite it", async()=>{
  addOrder("review-order"); addPayment("review-order","food-review");
  assert.equal((await payments.settleFoodPayment("food-review",10199,"GHS","tx-wrong")).status,"REVIEW");
  assert.equal((await payments.failFoodPayment("food-review","late failure","tx-late")).status,"REVIEW");
  assert.equal((await payments.settleFoodPayment("food-review",10200,"GHS","tx-later")).status,"REVIEW");
  assert.equal(sql.db.prepare("SELECT status FROM food_payments WHERE reference='food-review'").get().status,"REVIEW");
});

test("paid cancellation creates one guarded refund and mismatch stays in review", async()=>{
  addOrder("refund-order"); addPayment("refund-order","food-refund","SUCCESSFUL");
  const cancelled = await payments.cancelStudentFoodOrderWithRefund({ preorderId:"refund-order", studentId:"student-1", expectedStatus:"ACCEPTED", actor:"student@st.umat.edu.gh" });
  assert.equal(cancelled.refundStatus,"REQUESTED");
  await assert.rejects(payments.cancelStudentFoodOrderWithRefund({ preorderId:"refund-order", studentId:"student-1", expectedStatus:"ACCEPTED", actor:"student@st.umat.edu.gh" }), error=>error.code==="CONFLICT");
  assert.equal(sql.db.prepare("SELECT COUNT(*) AS count FROM food_refunds WHERE preorder_id='refund-order'").get().count,1);
  sql.db.prepare("UPDATE food_refunds SET status='APPROVED',paystack_reference='refund-provider-1' WHERE preorder_id='refund-order'").run();
  assert.equal((await payments.applyFoodRefundEvent({ event:"refund.processed", reference:"refund-provider-1", amount:10000, currency:"GHS" })).status,"REVIEW");
  assert.equal((await payments.applyFoodRefundEvent({ event:"refund.processed", reference:"refund-provider-1", amount:10200, currency:"GHS" })).status,"REVIEW");
});

test("collection creates one settlement and payout references cannot be reused", async()=>{
  addOrder("collect-one","READY"); addPayment("collect-one","food-collect-one","SUCCESSFUL",0);
  await payments.collectPaidFoodOrder({ preorderId:"collect-one", providerId, note:"Collected" });
  await assert.rejects(payments.collectPaidFoodOrder({ preorderId:"collect-one", providerId, note:"Again" }), error=>error.code==="CONFLICT");
  let overview = await payments.foodFinanceOverview();
  const first = overview.settlements.find(row=>row.preorder_id==="collect-one");
  assert.equal(first.status,"AVAILABLE");
  await payments.markFoodSettlementPaid(first.id,"MOMO-UNIQUE-1","staff@example.com");

  addOrder("collect-two","READY"); addPayment("collect-two","food-collect-two","SUCCESSFUL",0);
  await payments.collectPaidFoodOrder({ preorderId:"collect-two", providerId, note:"Collected" });
  overview = await payments.foodFinanceOverview();
  const second = overview.settlements.find(row=>row.preorder_id==="collect-two");
  await assert.rejects(payments.markFoodSettlementPaid(second.id,"MOMO-UNIQUE-1","staff@example.com"), error=>error.code==="CONFLICT");
});
