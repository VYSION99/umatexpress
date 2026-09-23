import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

/**
 * The two-party notice book. Every service puts a provider and the platform on
 * opposite sides of a decision, and the outbox row is the only place either
 * party learns what was decided — so these tests hold the shape of the book
 * rather than one product's copy: every kind of provider, every decision, a
 * message that names the service and carries the reason, and one queue that
 * cannot send the same decision twice.
 */

process.env.TURSO_DATABASE_URL = "https://party-notices-test.turso.io";
process.env.TURSO_AUTH_TOKEN = "test-token";

const outbox = [];
let tursoDown = false;

const empty = { cols: [], rows: [] };
const ok = (result) => ({ type: "ok", response: { result: result || {} } });

function handle(sql, args) {
  if (/INSERT INTO notification_outbox/.test(sql)) {
    const [, channel, recipient, template, subject, message, reference] = args;
    if (outbox.some((row) => row.reference === reference && row.template === template)) {
      return ok({ affected_row_count: 0 });
    }
    outbox.push({ channel, recipient, template, subject, message, reference });
    return ok({ affected_row_count: 1 });
  }
  return ok(empty);
}

globalThis.fetch = async (_url, init) => {
  if (tursoDown) throw new Error("turso is unreachable");
  const body = JSON.parse(init.body);
  const results = body.requests
    .filter((request) => request.type === "execute")
    .map(({ stmt }) => handle(stmt.sql, (stmt.args || []).map((arg) => (arg.type === "null" ? null : arg.value))));
  results.push({ type: "ok" });
  return { ok: true, json: async () => ({ results }) };
};

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => vite.close());

const {
  PARTY_TEMPLATES, PROVIDER_COPY,
  notifyParty, providerDecisionNotice, providerKycNotice, providerListingNotice,
} = await vite.ssrLoadModule("/lib/notify-templates.ts");

const kinds = Object.keys(PROVIDER_COPY);

test("every service a person can join carries the facts a notice needs", () => {
  assert.deepEqual(kinds.sort(), ["driver", "landlord", "organizer", "vendor"], "the book covers each provider the platform has");
  for (const kind of kinds) {
    const copy = PROVIDER_COPY[kind];
    assert.ok(copy.label.trim(), `${kind} names the party`);
    assert.ok(copy.service.trim(), `${kind} names the product the message is about`);
    assert.ok(copy.offer.trim(), `${kind} names the thing a listing decision is about`);
    assert.match(copy.consolePath, /^\//, `${kind} knows where its party signs in`);
    assert.ok(copy.nextStep.length > 20, `${kind} tells an approved provider what to do first`);
  }
});

test("an account decision is one distinct message per service and outcome", () => {
  const seen = new Set();
  for (const kind of kinds) {
    for (const decision of ["APPROVE", "REJECT", "SUSPEND"]) {
      const notice = providerDecisionNotice(kind, decision, { reason: "The phone number does not reach you" });
      assert.equal(notice.template, PARTY_TEMPLATES.providerDecision(kind, decision), "the id is built in one place");
      assert.ok(notice.subject.trim(), `${kind} ${decision} has a subject`);
      assert.match(notice.message, new RegExp(PROVIDER_COPY[kind].service, "i"), `${kind} ${decision} says which product it is about`);
      assert.ok(!seen.has(notice.template), `${notice.template} is not reused for another decision`);
      seen.add(notice.template);
    }
  }
  assert.equal(seen.size, kinds.length * 3, "each decision reads as itself, never as a neighbour");
});

test("a rejection carries the reason, an approval carries the way in", () => {
  for (const kind of kinds) {
    const rejected = providerDecisionNotice(kind, "REJECT", { reason: "The phone number does not reach you" });
    assert.match(rejected.message, /The phone number does not reach you/, "a refusal without a reason is a dead end");
    assert.match(rejected.message, /apply again/i, "the applicant is told the door is not shut");

    const bare = providerDecisionNotice(kind, "APPROVE");
    assert.ok(!bare.message.includes("Reason:"), "an approval has nothing to correct");
    assert.match(bare.message, /Sign in at the console/, "with no link, the provider is still told where to go");

    const linked = providerDecisionNotice(kind, "APPROVE", { loginUrl: "https://umat.example/console/login" });
    assert.match(linked.message, /https:\/\/umat\.example\/console\/login/);
  }
});

test("the identity check reads as the money gate", () => {
  const verified = providerKycNotice("organizer", "VERIFY");
  assert.equal(verified.template, PARTY_TEMPLATES.providerKyc("organizer", "VERIFY"));
  assert.equal(verified.template, "organizer_kyc_verified");
  assert.match(verified.message, /payments can be sent/i, "a verified provider is told money may now move");
  assert.match(verified.message, /new check/i, "and that changing the details starts the gate again");

  const rejected = providerKycNotice("landlord", "REJECT", { reason: "The ID photo is unreadable" });
  assert.equal(rejected.template, "landlord_kyc_rejected");
  assert.match(rejected.subject, /could not verify/i);
  assert.match(rejected.message, /The ID photo is unreadable/, "the provider is told what to correct");
});

test("a listing decision names the bed and says what happens next", () => {
  const bed = "Owusu Hostels · Room 1 · Bed A";
  const approved = providerListingNotice("landlord", "APPROVE", { listing: bed });
  assert.equal(approved.template, PARTY_TEMPLATES.providerListing("landlord", "APPROVE"));
  assert.equal(approved.template, "landlord_listing_approved");
  assert.match(approved.message, /Owusu Hostels · Room 1 · Bed A/, "the landlord reads about the bed they built");
  assert.match(approved.message, /identity check/i, "an approval points at the gate a payout waits on");

  const returned = providerListingNotice("landlord", "REJECT", { listing: bed, reason: "The photo shows a different building." });
  assert.equal(returned.template, "landlord_listing_rejected");
  assert.match(returned.message, /The photo shows a different building/);
  assert.match(returned.message, /submit it again/i, "the listing is theirs to fix, not lost");

  const suspended = providerListingNotice("landlord", "SUSPEND", { listing: bed, reason: "A complaint was upheld." });
  assert.equal(suspended.template, "landlord_listing_suspended");
  assert.match(suspended.message, /taken down/i);
  assert.match(suspended.message, /stays hidden/i, "a suspension is the platform's to lift and the landlord is told so");

  const unnamed = providerListingNotice("landlord", "APPROVE");
  assert.match(unnamed.message, /your listing/i, "an unnamed listing still reads as a sentence");

  const trip = providerListingNotice("organizer", "APPROVE", { listing: "UMaT → Accra" });
  assert.equal(trip.template, "organizer_listing_approved", "a trip is a listing decision in the organizer's own vocabulary");
  assert.match(trip.subject, /vacationRide trip is live/i, "and the message uses the word the service uses");
});

test("the book lists the notices the products already send", () => {
  const existing = PARTY_TEMPLATES.existing;
  for (const template of [
    "vacation_booking_confirmed", "hostel_booking_confirmed", "hostel_booking_landlord",
    "hostel_refund_requested", "hostel_refund_decided", "hostel_payout_recorded",
    "hostel_review_received", "hostel_message_received", "driver_accepted", "trip_completed",
  ]) {
    assert.ok(existing[template], `${template} is described in the book`);
  }
});

test("one queue row per decision: a repeat is skipped, another party is not", async () => {
  outbox.length = 0;
  const notice = providerListingNotice("landlord", "APPROVE", { listing: "Owusu Hostels · Room 1 · Bed A" });

  assert.deepEqual(await notifyParty({ recipient: "Owusu@Example.com", reference: "listing-1", notice }), { status: "QUEUED" });
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].recipient, "owusu@example.com", "the address is stored in one case, so the unique index sees a repeat");
  assert.equal(outbox[0].channel, "email", "one row is both the email and the in-app record");

  assert.deepEqual(await notifyParty({ recipient: "owusu@example.com", reference: "listing-1", notice }), { status: "ALREADY_QUEUED" });
  assert.equal(outbox.length, 1, "the same decision never sends twice");

  assert.deepEqual(await notifyParty({ recipient: "owusu@example.com", reference: "listing-2", notice }), { status: "QUEUED" });
  assert.equal(outbox.length, 2, "a second listing is a second message");
});

test("a notice that cannot be addressed is skipped, and a failure never throws", async () => {
  outbox.length = 0;
  const notice = providerKycNotice("landlord", "VERIFY");
  assert.deepEqual(await notifyParty({ recipient: "", reference: "landlord-a", notice }), { status: "SKIPPED", reason: "NO_RECIPIENT" });
  assert.deepEqual(await notifyParty({ recipient: "not-an-email", reference: "landlord-a", notice }), { status: "SKIPPED", reason: "NO_RECIPIENT" });
  assert.deepEqual(await notifyParty({ recipient: "owusu@example.com", reference: "", notice }), { status: "SKIPPED", reason: "NO_REFERENCE" });
  assert.equal(outbox.length, 0, "nothing is written for a notice that has no party to reach");

  tursoDown = true;
  const failed = await notifyParty({ recipient: "owusu@example.com", reference: "landlord-a", notice });
  tursoDown = false;
  assert.equal(failed.status, "FAILED", "a messaging failure must not become an error an administrator sees");
  assert.ok(failed.reason, "the failure is reported so it can be logged");
  assert.equal(outbox.length, 0);
});
