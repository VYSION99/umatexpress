import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { sqliteTurso } from "./helpers/sqlite-turso.mjs";

process.env.TURSO_DATABASE_URL = "https://cinema-streaming-entitlements.test";
process.env.TURSO_AUTH_TOKEN = "test-token";
process.env.CINEMA_JAAS_MAU_STOP_FREE = "2";
const sql = sqliteTurso();
const originalFetch = globalThis.fetch;
globalThis.fetch = sql.fetch;
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({
  appType: "custom",
  configFile: false,
  root,
  resolve: { alias: { "@": root } },
  server: { middlewareMode: true, hmr: false },
});
after(async () => {
  await vite.close();
  sql.db.close();
  globalThis.fetch = originalFetch;
});

const entitlements = await vite.ssrLoadModule("/lib/cinema-streaming/entitlements.ts");
const policy = { enabled: true, maxStageUnique: 4, maxDurationMinutes: 60, periodDays: 30 };
const now = new Date("2026-10-17T12:00:00.000Z");
const startsAt = "2026-10-20T18:00:00.000Z";

function reservation(overrides = {}) {
  return {
    eventId: crypto.randomUUID(),
    organizerId: crypto.randomUUID(),
    organizerType: "STUDENT_GROUP",
    ownerStudentId: "student-owner",
    hostStudentId: "stage-host",
    startsAt,
    durationMinutes: 60,
    createdBy: "student-owner",
    policy,
    now,
    ...overrides,
  };
}

test("free quota belongs to the owner and an event reservation is idempotent", async () => {
  const firstInput = reservation({ eventId: "event-owner-first", organizerId: "student-group-one" });
  const first = await entitlements.reserveFreeJaasEntitlement(firstInput);
  const retry = await entitlements.reserveFreeJaasEntitlement(firstInput);
  assert.equal(retry.id, first.id);
  assert.equal(first.quotaKey, "STUDENT:student-owner");

  await assert.rejects(
    entitlements.reserveFreeJaasEntitlement(reservation({ eventId: "event-owner-second", organizerId: "renamed-student-group" })),
    (error) => error.status === 409 && /next free managed-stage event/.test(error.message),
  );

  const club = await entitlements.reserveFreeJaasEntitlement(reservation({
    eventId: "event-approved-club",
    organizerId: "approved-club-id",
    organizerType: "CLUB",
    ownerStudentId: "student-owner",
  }));
  assert.equal(club.quotaKey, "ORGANIZER:approved-club-id");
});

test("free stage counts four unique identities including the host", async () => {
  const eventId = "event-stage-limit";
  await entitlements.reserveFreeJaasEntitlement(reservation({
    eventId,
    organizerId: "approved-department-id",
    organizerType: "DEPARTMENT",
    ownerStudentId: "department-delegate",
  }));

  for (const [index, studentId] of ["speaker-a", "speaker-b", "speaker-c"].entries()) {
    const claim = await entitlements.claimFreeStageDevice({
      eventId,
      studentId,
      deviceSessionId: `device-session-${index}-1234567890`,
      now,
    });
    assert.equal(claim.uniqueStageParticipants, index + 2);
  }

  await assert.rejects(
    entitlements.claimFreeStageDevice({ eventId, studentId: "speaker-d", deviceSessionId: "device-session-four-123456", now }),
    (error) => error.status === 409 && /4 unique participants/.test(error.message),
  );
});

test("one account has one active device and releasing it does not restore a unique place", async () => {
  const eventId = "event-device-limit";
  await entitlements.reserveFreeJaasEntitlement(reservation({
    eventId,
    organizerId: "approved-club-device",
    organizerType: "CLUB",
    ownerStudentId: "club-delegate",
  }));
  const firstDevice = "device-session-primary-123456";
  await entitlements.claimFreeStageDevice({ eventId, studentId: "speaker-one", deviceSessionId: firstDevice, now });
  await entitlements.claimFreeStageDevice({ eventId, studentId: "speaker-one", deviceSessionId: firstDevice, now });
  await assert.rejects(
    entitlements.claimFreeStageDevice({ eventId, studentId: "speaker-one", deviceSessionId: "device-session-second-123456", now }),
    (error) => error.status === 409 && /another device/.test(error.message),
  );
  assert.deepEqual(await entitlements.releaseFreeStageDevice({ eventId, studentId: "speaker-one", deviceSessionId: firstDevice }), { released: true });
  await entitlements.claimFreeStageDevice({ eventId, studentId: "speaker-one", deviceSessionId: "device-session-second-123456", now });

  await entitlements.claimFreeStageDevice({ eventId, studentId: "speaker-two", deviceSessionId: "device-session-two-123456789", now });
  await entitlements.claimFreeStageDevice({ eventId, studentId: "speaker-three", deviceSessionId: "device-session-three-1234567", now });
  await entitlements.releaseFreeStageDevice({ eventId, studentId: "speaker-two", deviceSessionId: "device-session-two-123456789" });
  await assert.rejects(
    entitlements.claimFreeStageDevice({ eventId, studentId: "speaker-four", deviceSessionId: "device-session-four-123456", now }),
    (error) => error.status === 409 && /4 unique participants/.test(error.message),
  );
});

test("monthly JaaS guard keeps existing identities working and refuses a new identity at the stop threshold", async () => {
  const first = await entitlements.claimFreeJaasMonthlyIdentity({ studentId: "mau-one", now });
  const second = await entitlements.claimFreeJaasMonthlyIdentity({ studentId: "mau-two", now });
  assert.equal(first.count, 1);
  assert.equal(second.count, 2);
  assert.equal((await entitlements.claimFreeJaasMonthlyIdentity({ studentId: "mau-one", now })).count, 2);
  await assert.rejects(
    entitlements.claimFreeJaasMonthlyIdentity({ studentId: "mau-three", now }),
    (error) => error.status === 409 && /monthly allowance is full/.test(error.message),
  );
});
