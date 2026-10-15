import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { sqliteTurso } from "./helpers/sqlite-turso.mjs";

process.env.TURSO_DATABASE_URL = "https://cinema-events.test";
process.env.TURSO_AUTH_TOKEN = "test-token";
process.env.STUDENT_SESSION_SECRET = "cinema-audience-test-session-secret-32-characters";
const sql = sqliteTurso();
const originalFetch = globalThis.fetch;
globalThis.fetch = sql.fetch;
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => { await vite.close(); sql.db.close(); globalThis.fetch = originalFetch; });
const events = await vite.ssrLoadModule("/lib/cinema-engine/events.ts");
const rooms = await vite.ssrLoadModule("/lib/cinema-engine/rooms.ts");
const questions = await vite.ssrLoadModule("/lib/cinema-engine/questions.ts");
const stage = await vite.ssrLoadModule("/lib/cinema-engine/stage-requests.ts");
const accounts = await vite.ssrLoadModule("/lib/student-auth.ts");
const host = { id: "host", name: "Ama", email: "ama@st.umat.edu.gh" };
const guest = { id: "guest", name: "Kojo", email: "kojo@st.umat.edu.gh" };
const other = { id: "other", name: "Esi", email: "esi@st.umat.edu.gh" };
const video = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

test("a weekly series publishes together and capacity controls the actual room", async () => {
  const start = new Date(Date.now() + 15 * 60_000).toISOString();
  await assert.rejects(events.createCinemaEvents({ student: host, organizerName: "Mathematics Club", organizerType: "CLUB", title: "Weekly calculus", video, startsAt: start }), (error) => error.status === 403);
  const request = await events.requestCinemaOrganizer({ studentId: host.id, name: "Mathematics Club", type: "CLUB", affiliation: "Department adviser: adviser@umat.edu.gh" });
  assert.equal(request.status, "PENDING");
  await assert.rejects(events.decideCinemaOrganizer({ id: request.id, approve: true, actor: "admin@umat.edu.gh", verificationNote: "" }), (error) => error.status === 400);
  assert.equal((await events.decideCinemaOrganizer({ id: request.id, approve: true, actor: "admin@umat.edu.gh", verificationNote: "Confirmed with adviser@umat.edu.gh" })).status, "ACTIVE");
  const series = await events.createCinemaEvents({ student: host, organizerName: "Mathematics Club", organizerType: "CLUB", title: "Weekly calculus", description: "Worked examples", video, startsAt: start, durationMinutes: 60, capacity: 1, recurrenceCount: 2, certificatesEnabled: true });
  assert.equal(series.length, 2);
  assert.equal(series[0].seriesId, series[1].seriesId);
  assert.equal(series[0].recurrenceIndex, 1);
  assert.equal(series[1].recurrenceIndex, 2);
  assert.equal((await events.listPublicCinemaEvents({ section: "UPCOMING" })).length, 2);

  const first = series[0];
  await events.setCinemaEventRsvp({ id: first.id, student: guest, going: true });
  await assert.rejects(events.setCinemaEventRsvp({ id: first.id, student: other, going: true }), (error) => error.status === 409);
  await assert.rejects(rooms.joinRoom({ id: first.sessionId, student: other }), (error) => error.status === 403);
  await rooms.joinRoom({ id: first.sessionId, student: guest });
  await assert.rejects(events.setCinemaEventRsvp({ id: first.id, student: guest, going: false }), (error) => error.status === 409);

  // An RSVP and an early room entry do not establish event attendance. A live
  // heartbeat after the start does, and it is the only certificate source.
  assert.equal((await events.attendanceForCinemaEvent(first.id, guest.id)).attended, false);
  const startMs = Date.parse(first.startsAt);
  sql.db.prepare("UPDATE cinema_participants SET last_seen_at=?,attendance_seconds=120 WHERE session_id=? AND student_id=?").run(new Date(startMs + 2 * 60_000).toISOString(), first.sessionId, guest.id);
  sql.db.prepare("UPDATE cinema_sessions SET status='ENDED',ended_at=? WHERE id=?").run(new Date(startMs + 60 * 60_000).toISOString(), first.sessionId);
  assert.equal((await events.attendanceForCinemaEvent(first.id, guest.id)).attended, false, "a brief visit cannot earn a certificate");
  sql.db.prepare("UPDATE cinema_participants SET attendance_seconds=1800 WHERE session_id=? AND student_id=?").run(first.sessionId, guest.id);
  assert.equal((await events.attendanceForCinemaEvent(first.id, guest.id)).attended, true);
  assert.equal((await events.attendanceForCinemaEvent(first.id, other.id)).attended, false);
  await events.submitCinemaEventFeedback({ id: first.id, studentId: guest.id, rating: 5, comment: "Helpful" });
  await assert.rejects(events.submitCinemaEventFeedback({ id: first.id, studentId: other.id, rating: 5 }), (error) => error.status === 403);
  const replay = await events.readPublicCinemaEvent(first.slug);
  assert.equal(replay.state, "REPLAY");
  assert.equal(replay.replayVideoId, "dQw4w9WgXcQ");
  assert.equal(replay.averageRating, 5);
  sql.db.prepare("UPDATE cinema_organizers SET verified_at='' WHERE id=?").run(first.organizer.id);
  await assert.rejects(rooms.readRoom({ id: first.sessionId, studentId: guest.id }), (error) => error.status === 403);
});

test("a legacy self-declared club needs staff approval before another event", async () => {
  const request = await events.requestCinemaOrganizer({ studentId: host.id, name: "Legacy Science Club", type: "CLUB", affiliation: "Faculty contact: science@umat.edu.gh" });
  sql.db.prepare("UPDATE cinema_organizers SET status='ACTIVE',verified_at='',verified_by='' WHERE id=?").run(request.id);
  const listed = await events.listMyCinemaOrganizers(host.id);
  assert.equal(listed.find((item) => item.id === request.id)?.status, "UNVERIFIED");
  const start = new Date(Date.now() + 30 * 60_000).toISOString();
  await assert.rejects(events.createCinemaEvents({ student: host, organizerName: "Legacy Science Club", organizerType: "CLUB", title: "Science forum", video, startsAt: start }), (error) => error.status === 403);
  assert.equal((await events.requestCinemaOrganizer({ studentId: host.id, name: "Legacy Science Club", type: "CLUB", affiliation: "Faculty contact: science@umat.edu.gh" })).status, "PENDING");
});

test("screening events also obey the 100-viewer ceiling", async () => {
  const startsAt = new Date(Date.now() + 30 * 60_000).toISOString();
  await assert.rejects(events.createCinemaEvents({ student: host, organizerName: "Screening Group", organizerType: "STUDENT_GROUP", title: "Oversized screening", video, startsAt, capacity: 101 }), (error) => error.status === 400);
  const [screening] = await events.createCinemaEvents({ student: host, organizerName: "Screening Group", organizerType: "STUDENT_GROUP", title: "Cinema screening", video, startsAt, capacity: 0 });
  assert.equal(screening.capacity, 100, "older clients sending zero receive the safe 100-viewer limit");
});

test("discussion capacity, waitlist, stage and moderated questions stay separate", async () => {
  const start = new Date(Date.now() + 20 * 60_000).toISOString();
  const [event] = await events.createCinemaEvents({ student: host, organizerName: "Debate Union", organizerType: "STUDENT_GROUP", title: "Housing policy debate", description: "A public debate", video, startsAt: start, capacity: 10, stageLimit: 2, format: "DEBATE" });
  assert.equal(event.format, "DEBATE");
  assert.equal(event.stageLimit, 2);
  const attendees = Array.from({ length: 11 }, (_, index) => ({ id: `debate-guest-${index}`, name: `Guest ${index}`, email: `guest${index}@example.com` }));
  for (const attendee of attendees) await events.setCinemaEventRsvp({ id: event.id, student: attendee, going: true });
  const full = await events.readPublicCinemaEvent(event.id, attendees[10].id);
  assert.equal(full.rsvpCount, 10);
  assert.equal(full.viewerRsvp, "WAITLIST");
  assert.equal(full.waitlistPosition, 1);
  assert.equal((await rooms.readRoom({ id: event.sessionId, studentId: attendees[10].id })).videoId, "", "waitlisted visitors must not receive the broadcast id");
  await assert.rejects(rooms.joinRoom({ id: event.sessionId, student: attendees[10] }), (error) => error.status === 403);
  await events.setCinemaEventRsvp({ id: event.id, student: attendees[0], going: false });
  assert.equal((await events.readPublicCinemaEvent(event.id, attendees[10].id)).viewerRsvp, "GOING");
  await rooms.joinRoom({ id: event.sessionId, student: attendees[10] });
  await rooms.joinRoom({ id: event.sessionId, student: attendees[1] });
  await stage.requestStage({ id: event.sessionId, studentId: attendees[10].id, displayName: attendees[10].name });
  await stage.requestStage({ id: event.sessionId, studentId: attendees[10].id, displayName: attendees[10].name });
  assert.equal((await stage.stageRequests(event.sessionId, host.id)).length, 1);
  await stage.decideStageRequest({ id: event.sessionId, studentId: host.id, guestId: attendees[10].id, action: "APPROVE" });
  assert.equal((await stage.discussionAudienceState(event.sessionId, attendees[10].id)).role, "PRESENTER");
  await assert.rejects(rooms.setRoomMemberRole({ id: event.sessionId, studentId: host.id, guestId: attendees[1].id, role: "PRESENTER" }), (error) => error.status === 409);
  const submitted = await questions.submitDiscussionQuestion({ id: event.sessionId, studentId: attendees[1].id, displayName: attendees[1].name, text: "What evidence supports this policy?" });
  assert.equal(submitted.status, "PENDING");
  assert.equal((await questions.listDiscussionQuestions(event.sessionId, attendees[10].id)).length, 0);
  await questions.moderateDiscussionQuestion({ id: event.sessionId, studentId: host.id, questionId: submitted.id, status: "APPROVED" });
  assert.equal((await questions.listDiscussionQuestions(event.sessionId, attendees[10].id))[0].text, submitted.text);
  sql.db.prepare("UPDATE cinema_organizers SET status='REJECTED' WHERE id=?").run(event.organizer.id);
  await assert.rejects(rooms.joinRoom({ id: event.sessionId, student: attendees[10] }), (error) => error.status === 403);
  await assert.rejects(rooms.readRoom({ id: event.sessionId, studentId: attendees[10].id }), (error) => error.status === 403);
  await assert.rejects(stage.discussionAudienceState(event.sessionId, attendees[10].id), (error) => error.status === 403);
});

test("a verified public account can attend Cinema but cannot use student-only services", async () => {
  const audience = await accounts.registerCinemaAudience({ email: "visitor@example.com", name: "Public Visitor", password: "SecureAudience!2026" });
  const cookie = (await accounts.studentSessionCookie(audience.id, new Request("https://example.com/"))).split(";")[0];
  const request = new Request("https://example.com/api/cinema/events", { headers: { cookie } });
  await assert.rejects(accounts.requireCinemaAccount(request), (error) => error.status === 403);
  sql.db.prepare("UPDATE student_accounts SET email_verified=1 WHERE id=?").run(audience.id);
  assert.equal((await accounts.requireCinemaAccount(request)).email, "visitor@example.com");
  await assert.rejects(accounts.requireStudent(request), (error) => error.status === 403);
});
