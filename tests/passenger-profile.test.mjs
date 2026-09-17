import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true } });
after(async () => vite.close());

const {
  clearProfile,
  forgetTicket,
  normalizeProfile,
  profileName,
  readProfile,
  readSavedTickets,
  rememberTicket,
  ticketHref,
  writeProfile,
} = await vite.ssrLoadModule("/lib/passenger-profile.ts");

const PROFILE_KEY = "umatexpress.passenger.v1";
const TICKETS_KEY = "umatexpress.tickets.v1";
const LEGACY_KEY = "umx_campus_rider";

function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
    read: (key) => (map.has(key) ? map.get(key) : null),
    has: (key) => map.has(key),
  };
}

function blockedStorage() {
  return {
    getItem() { throw new Error("storage blocked"); },
    setItem() { throw new Error("storage blocked"); },
    removeItem() { throw new Error("storage blocked"); },
  };
}

test("a saved profile round-trips and retires the legacy campusRide key", () => {
  const store = fakeStorage({ [LEGACY_KEY]: JSON.stringify({ passengerName: "Old Rider", phone: "0244", email: "old@umat.edu.gh" }) });
  assert.equal(writeProfile({ name: "  Ama Mensah ", email: " ama@umat.edu.gh", phone: " 0555000111 " }, store), true);
  assert.deepEqual(
    { name: readProfile(store).name, email: readProfile(store).email, phone: readProfile(store).phone },
    { name: "Ama Mensah", email: "ama@umat.edu.gh", phone: "0555000111" },
  );
  assert.equal(store.has(LEGACY_KEY), false, "the old key should not survive a write");
  assert.ok(store.read(PROFILE_KEY), "the profile is stored under the versioned key");
});

test("details saved by the older campusRide form are still read", () => {
  const store = fakeStorage({ [LEGACY_KEY]: JSON.stringify({ passengerName: "Kofi Boateng", phone: "0200000000", email: "kofi@umat.edu.gh" }) });
  assert.equal(readProfile(store).name, "Kofi Boateng");
  assert.equal(readProfile(store).phone, "0200000000");
});

test("junk is never treated as a profile", () => {
  assert.equal(normalizeProfile(null), null);
  assert.equal(normalizeProfile("Ama"), null);
  assert.equal(normalizeProfile([]), null);
  assert.equal(normalizeProfile({}), null);
  assert.equal(normalizeProfile({ name: "   " }), null);
  assert.equal(normalizeProfile({ name: 42, email: {}, phone: ["x"] }), null);
  const store = fakeStorage({ [PROFILE_KEY]: "{not json" });
  assert.equal(readProfile(store), null, "unparseable storage is ignored, not thrown");
});

test("fields are trimmed and capped so a pasted blob cannot grow storage", () => {
  const profile = normalizeProfile({ name: ` ${"a".repeat(400)} `, email: " e@x.gh " });
  assert.equal(profile.name.length, 120);
  assert.equal(profile.email, "e@x.gh");
});

test("blocked storage fails closed instead of throwing", () => {
  const store = blockedStorage();
  assert.equal(writeProfile({ name: "Ama" }, store), false);
  assert.equal(readProfile(store), null);
  assert.equal(clearProfile(store), false);
  assert.equal(rememberTicket({ reference: "CR-1", kind: "campus" }, store), false);
  assert.deepEqual(readSavedTickets(store), []);
});

test("no storage at all (server render) reads empty and writes nothing", () => {
  assert.equal(readProfile(null), null);
  assert.deepEqual(readSavedTickets(null), []);
  assert.equal(writeProfile({ name: "Ama" }, null), false);
  assert.equal(profileName(null), "");
});

test("clearing removes both the profile and any legacy copy", () => {
  const store = fakeStorage({ [LEGACY_KEY]: JSON.stringify({ passengerName: "Old Rider" }) });
  assert.equal(clearProfile(store), true);
  assert.equal(readProfile(store), null);
  assert.equal(store.has(LEGACY_KEY), false);
});

test("the greeting name is the first word of the saved name", () => {
  assert.equal(profileName({ name: "Ama Serwaa Mensah" }), "Ama");
  assert.equal(profileName({ name: "  " }), "");
});

test("ticket references are de-duplicated, newest first", () => {
  const store = fakeStorage();
  assert.equal(rememberTicket({ reference: "CR-AAA", kind: "campus" }, store), true);
  assert.equal(rememberTicket({ reference: "CR-BBB", kind: "vacation" }, store), true);
  assert.equal(rememberTicket({ reference: "CR-AAA", kind: "campus" }, store), true);
  const tickets = readSavedTickets(store);
  assert.equal(tickets.length, 2);
  assert.equal(tickets[0].reference, "CR-AAA", "the re-opened ticket moves to the top");
  assert.equal(tickets[1].reference, "CR-BBB");
  assert.ok(tickets.every((ticket) => Number.isFinite(Date.parse(ticket.savedAt))));
});

test("the ticket list is capped and junk rows are dropped", () => {
  const store = fakeStorage();
  for (let index = 0; index < 15; index += 1) rememberTicket({ reference: `CR-${index}`, kind: "campus" }, store);
  assert.equal(readSavedTickets(store).length, 12);
  const junk = fakeStorage({ [TICKETS_KEY]: JSON.stringify([{ reference: "CR-KEEP", kind: "campus" }, { reference: "CR-DROP", kind: "other" }, { kind: "campus" }, "nope", null]) });
  assert.deepEqual(readSavedTickets(junk).map((ticket) => ticket.reference), ["CR-KEEP"]);
});

test("a ticket can be forgotten from the device without touching the others", () => {
  const store = fakeStorage();
  rememberTicket({ reference: "CR-AAA", kind: "campus" }, store);
  rememberTicket({ reference: "CR-BBB", kind: "vacation" }, store);
  assert.equal(forgetTicket("CR-AAA", store), true);
  assert.deepEqual(readSavedTickets(store).map((ticket) => ticket.reference), ["CR-BBB"]);
  assert.equal(forgetTicket("", store), false);
});

test("saved references link back to the page that can verify them", () => {
  assert.equal(ticketHref({ reference: "CR 1/2", kind: "campus" }), "/campus/ticket?reference=CR%201%2F2");
  assert.equal(ticketHref({ reference: "PSK-9", kind: "vacation" }), "/payment/callback?reference=PSK-9");
});
