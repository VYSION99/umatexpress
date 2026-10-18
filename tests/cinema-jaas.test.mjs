import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { sqliteTurso } from "./helpers/sqlite-turso.mjs";

process.env.TURSO_DATABASE_URL = "https://cinema-jaas.test";
process.env.TURSO_AUTH_TOKEN = "test-token";
process.env.CINEMA_JAAS_ENABLED = "true";
process.env.CINEMA_JAAS_FREE_EVENTS_ENABLED = "true";
process.env.JAAS_APP_ID = "vpaas-magic-cookie-test";
process.env.JAAS_KEY_ID = "vpaas-magic-cookie-test/key";
process.env.JAAS_PRIVATE_KEY_BASE64 = btoa("-----BEGIN PRIVATE KEY-----\nconfigured-for-event-reservation\n-----END PRIVATE KEY-----");
const sql = sqliteTurso();
const originalFetch = globalThis.fetch;
globalThis.fetch = sql.fetch;
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => { await vite.close(); sql.db.close(); globalThis.fetch = originalFetch; });

const events = await vite.ssrLoadModule("/lib/cinema-engine/events.ts");
const rooms = await vite.ssrLoadModule("/lib/cinema-engine/rooms.ts");
const stage = await vite.ssrLoadModule("/lib/cinema-engine/stage-requests.ts");
const jaas = await vite.ssrLoadModule("/lib/cinema-streaming/jaas.ts");
const host = { id: "jaas-host", name: "Ama Host", email: "host@st.umat.edu.gh" };
const speaker = { id: "jaas-speaker", name: "Kojo Speaker", email: "speaker@example.com" };
const viewer = { id: "jaas-viewer", name: "Esi Viewer", email: "viewer@example.com" };
const video = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

function binaryBase64(bytes) {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64UrlBytes(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodeJwtPart(value) { return JSON.parse(new TextDecoder().decode(base64UrlBytes(value))); }

async function testCredentials() {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const privateDer = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  const pem = `-----BEGIN PRIVATE KEY-----\n${binaryBase64(privateDer).match(/.{1,64}/g).join("\n")}\n-----END PRIVATE KEY-----`;
  return {
    credentials: { domain: "8x8.vc", appId: "vpaas-magic-cookie-test", keyId: "vpaas-magic-cookie-test/key", privateKeyBase64: btoa(pem) },
    publicKey: pair.publicKey,
  };
}

test("managed event reservation, role claims and device enforcement stay server controlled", async () => {
  const startsAt = new Date(Date.now() + 20 * 60_000).toISOString();
  const [event] = await events.createCinemaEvents({
    student: host,
    organizerName: "Managed Debate Group",
    organizerType: "STUDENT_GROUP",
    title: "Managed policy debate",
    description: "A JaaS pilot event",
    video,
    startsAt,
    durationMinutes: 60,
    capacity: 100,
    recurrenceCount: 1,
    format: "DEBATE",
    stageLimit: 6,
    managedStage: true,
  });
  assert.equal(event.stageLimit, 4);
  const entitlement = sql.db.prepare("SELECT quota_key,max_stage_unique,max_duration_minutes FROM cinema_streaming_entitlements WHERE event_id=?").get(event.id);
  assert.equal(entitlement.quota_key, `STUDENT:${host.id}`);
  assert.equal(entitlement.max_stage_unique, 4);
  assert.equal(entitlement.max_duration_minutes, 60);

  await events.setCinemaEventRsvp({ id: event.id, student: speaker, going: true });
  await events.setCinemaEventRsvp({ id: event.id, student: viewer, going: true });
  await rooms.joinRoom({ id: event.sessionId, student: speaker });
  await rooms.joinRoom({ id: event.sessionId, student: viewer });
  await stage.requestStage({ id: event.sessionId, studentId: speaker.id, displayName: speaker.name });
  await stage.decideStageRequest({ id: event.sessionId, studentId: host.id, guestId: speaker.id, action: "APPROVE" });

  const signing = await testCredentials();
  const hostAccess = await jaas.issueJaasStageAccess({ sessionId: event.sessionId, account: host, deviceSessionId: "host-device-session-123456", credentials: signing.credentials });
  const speakerAccess = await jaas.issueJaasStageAccess({ sessionId: event.sessionId, account: speaker, deviceSessionId: "speaker-device-session-123", credentials: signing.credentials });
  assert.equal(hostAccess.roomName, speakerAccess.roomName);
  assert.equal(hostAccess.role, "HOST");
  assert.equal(speakerAccess.role, "PRESENTER");

  const [headerPart, payloadPart, signaturePart] = hostAccess.token.split(".");
  const header = decodeJwtPart(headerPart);
  const payload = decodeJwtPart(payloadPart);
  assert.equal(header.alg, "RS256");
  assert.equal(header.kid, signing.credentials.keyId);
  assert.equal(payload.room, hostAccess.roomName.split("/")[1]);
  assert.equal(payload.sub, signing.credentials.appId);
  assert.equal(payload.context.room.regex, false);
  assert.equal(payload.context.user.moderator, "true");
  assert.equal(payload.context.features.livestreaming, true);
  assert.equal(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", signing.publicKey, base64UrlBytes(signaturePart), new TextEncoder().encode(`${headerPart}.${payloadPart}`)), true);

  const speakerPayload = decodeJwtPart(speakerAccess.token.split(".")[1]);
  assert.equal(speakerPayload.context.user.moderator, "false");
  assert.equal(speakerPayload.context.features.livestreaming, false);
  await assert.rejects(
    jaas.issueJaasStageAccess({ sessionId: event.sessionId, account: viewer, deviceSessionId: "viewer-device-session-1234", credentials: signing.credentials }),
    (error) => error.status === 403 && /admit/.test(error.message),
  );
  await assert.rejects(
    jaas.issueJaasStageAccess({ sessionId: event.sessionId, account: speaker, deviceSessionId: "speaker-second-device-123", credentials: signing.credentials }),
    (error) => error.status === 409 && /another device/.test(error.message),
  );
  assert.deepEqual(await jaas.releaseJaasStageAccess({ sessionId: event.sessionId, accountId: speaker.id, deviceSessionId: "speaker-device-session-123" }), { released: true });
  await jaas.issueJaasStageAccess({ sessionId: event.sessionId, account: speaker, deviceSessionId: "speaker-second-device-123", credentials: signing.credentials });

  await rooms.patchRoom({ id: event.sessionId, studentId: host.id, action: "END" });
  assert.equal(sql.db.prepare("SELECT status FROM cinema_streaming_entitlements WHERE event_id=?").get(event.id).status, "ENDED");
  assert.equal(sql.db.prepare("SELECT active_device_id FROM cinema_stage_admissions WHERE entitlement_id=(SELECT id FROM cinema_streaming_entitlements WHERE event_id=?) AND student_id=?").get(event.id, speaker.id).active_device_id, "");
});

test("managed free quota cannot be reset by another student-group name", async () => {
  const startsAt = new Date(Date.now() + 25 * 60_000).toISOString();
  const before = Number(sql.db.prepare("SELECT COUNT(*) AS count FROM cinema_sessions").get().count);
  await assert.rejects(events.createCinemaEvents({
    student: host,
    organizerName: "A Different Group Name",
    organizerType: "STUDENT_GROUP",
    title: "Second managed event",
    video,
    startsAt,
    durationMinutes: 60,
    format: "PANEL",
    managedStage: true,
  }), (error) => error.status === 409 && /next free managed-stage event/.test(error.message));
  const after = Number(sql.db.prepare("SELECT COUNT(*) AS count FROM cinema_sessions").get().count);
  assert.equal(after, before, "a rejected reservation cleans up its unpublished room");
  assert.equal(Number(sql.db.prepare("SELECT COUNT(*) AS count FROM cinema_events WHERE status='PUBLISHING'").get().count), 0);
});
