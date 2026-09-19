import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

// "Find my trip" must answer from the real schedule: the model may choose an
// id, but it can never invent a trip, a fare or a date, and the page keeps
// working when the model is missing or wrong.

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => vite.close());
const { tripDateFromMessage, matchTripRequest, parseTripChoice, tripSearchReply } = await vite.ssrLoadModule("/lib/trip-search.ts");

// 2026-09-19 is a Saturday in Accra (UTC+0).
const today = new Date("2026-09-19T09:00:00Z");
const trips = [
  { id: "3", from: "UMaT Main Campus", to: "Accra", travelDate: "2026-09-25", time: "07:00", arrival: "11:30", price: 45, capacity: 50, coachType: "VIP Coach" },
  { id: "4", from: "UMaT Main Campus", to: "Accra", travelDate: "2026-09-26", time: "13:00", arrival: "17:30", price: 45, capacity: 50, coachType: "VIP Coach" },
  { id: "5", from: "UMaT Main Campus", to: "Kumasi", travelDate: "2026-09-25", time: "06:30", arrival: "10:00", price: 60, capacity: 45, coachType: "VIP Coach" },
];

test("a message's travel date is read the way students write it", () => {
  assert.equal(tripDateFromMessage("Accra next Friday", today), "2026-09-25");
  assert.equal(tripDateFromMessage("the bus on Friday", today), "2026-09-25");
  assert.equal(tripDateFromMessage("today please", today), "2026-09-19");
  assert.equal(tripDateFromMessage("tomorrow", today), "2026-09-20");
  assert.equal(tripDateFromMessage("travelling on 5 October", today), "2026-10-05");
  assert.equal(tripDateFromMessage("5th of October", today), "2026-10-05");
  assert.equal(tripDateFromMessage("book 05/10/2026", today), "2026-10-05");
  assert.equal(tripDateFromMessage("2026-10-05", today), "2026-10-05");
  assert.equal(tripDateFromMessage("I want a seat somewhere", today), "");
  assert.equal(tripDateFromMessage("31 February", today), "");
});

test("a named destination and date choose the real coach", () => {
  const accra = matchTripRequest("Please, I want to go to Accra next Friday", trips, today);
  assert.equal(accra.tripId, "3");
  assert.match(accra.reply, /07:00/);
  assert.match(accra.reply, /Accra/);
  assert.match(accra.reply, /GH₵ 45/);

  const kumasi = matchTripRequest("Kumasi on Friday", trips, today);
  assert.equal(kumasi.tripId, "5");
  assert.match(kumasi.reply, /Kumasi/);
});

test("a destination with no coach that day is reported honestly", () => {
  const result = matchTripRequest("Accra tomorrow", trips, today);
  assert.equal(result.tripId, null, "another day's coach must not be passed off as tomorrow's");
  assert.match(result.reply, /No coach goes to Accra on/);
  assert.match(result.reply, /Fri 25 Sep/);
});

test("an unknown destination lists what is actually on sale", () => {
  const result = matchTripRequest("take me to Tamale", trips, today);
  assert.equal(result.tripId, null);
  assert.match(result.reply, /Available:/);
  assert.match(result.reply, /Accra/);
  assert.match(result.reply, /Kumasi/);
});

test("a date alone picks the earliest coach that day", () => {
  const result = matchTripRequest("any coach on Saturday 26 September", trips, today);
  assert.equal(result.tripId, "4");
  assert.match(result.reply, /13:00/);
});

test("the model may choose an id, but the reply is always composed from the real trip", () => {
  const run = async () => "```json\n{\"tripId\": \"5\"}\n```";
  return tripSearchReply({ message: "the cheapest seat this weekend", trips, today, run }).then((result) => {
    assert.equal(result.tripId, "5");
    assert.match(result.reply, /Kumasi/);
    assert.match(result.reply, /GH₵ 60/);
    assert.ok(!result.reply.includes("```"), "model formatting must never reach the student");
  });
});

test("a hallucinated id, unusable answer or failing model falls back to the matcher", async () => {
  const message = "I want to go to Accra next Friday";
  const invented = await tripSearchReply({ message, trips, today, run: async () => '{"tripId":"999"}' });
  assert.equal(invented.tripId, "3", "an id outside the list must be refused");
  assert.match(invented.reply, /Accra/);

  const garbage = await tripSearchReply({ message, trips, today, run: async () => "Take the bus, my friend." });
  assert.equal(garbage.tripId, "3");

  const broken = await tripSearchReply({ message, trips, today, run: async () => { throw new Error("model down"); } });
  assert.equal(broken.tripId, "3");

  const refused = await tripSearchReply({ message, trips, today, run: async () => '{"tripId":null}' });
  assert.equal(refused.tripId, "3", "a confident deterministic match outranks the model saying nothing fits");
});

test("the choice parser only accepts the contract", () => {
  assert.equal(parseTripChoice('{"tripId":"3"}'), "3");
  assert.equal(parseTripChoice('Sure! {"tripId": "4"} hope that helps'), "4");
  assert.equal(parseTripChoice('{"tripId":null}'), null);
  assert.equal(parseTripChoice("no json here"), undefined);
  assert.equal(parseTripChoice('{"tripId":""}'), undefined);
  assert.equal(parseTripChoice("{not json}"), undefined);
});

test("with no trips the answer says so instead of inventing one", async () => {
  const result = await tripSearchReply({ message: "Accra on Friday", trips: [], today, run: async () => '{"tripId":"3"}' });
  assert.equal(result.tripId, null);
  assert.match(result.reply, /No coach is on sale/);
});
