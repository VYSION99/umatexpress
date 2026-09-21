# Collaborative Study & Watch Session Platform
## Architecture and Phased Implementation Plan

**Version:** 1.1
**Status:** Aligned for build. Architecture unchanged; every greenfield assumption rewritten against the platform that already exists.
**Scope:** Collaborative video study/watch rooms for 2+ users
**Primary video sources:** YouTube (Phase 1) + temporary direct uploads (Phase 2)
**Core infrastructure:** Cloudflare Workers, Durable Objects, R2, WebSockets, YouTube Embed/Player

---

# 0. Alignment revision (v1.1)

This plan was written as a standalone product. Cinema is not standalone: it is the
fourth service on a platform that already runs campusRide, vacationRide and Hostel
Finder, under one console and one account system. The architecture below survives
that contact; the plumbing around it does not. This section records the decisions,
and the sections after it were rewritten to match.

## 0.1 Fixed by the platform

| Area | Decision |
|------|----------|
| Identity | One account system. Participants are `student_accounts` rows — verified `@st.umat.edu.gh` students — and staff are `console_accounts`. Cinema adds no login, no `users` table and no `/api/auth/login`. |
| Naming | Internal name **Cinema**: tables `cinema_*`, APIs `/api/cinema/*`, client route `/cinema/[id]`, engine `lib/cinema-engine/`. The launcher already ships a disabled `OnlineCinema` card (`components/launcher/services.ts`); Phase 1 flips it to available, and whether the public label stays "OnlineCinema" is a copy decision, not a schema one. |
| Console | One console, every service: Cinema registers a service entry, a live-room list and the report/deletion queue. Staff surfaces are console routes; nothing staff-facing is public. |
| Audit | `consoleAudit(...)` and the platform audit tables. Cinema writes no `audit_logs` of its own. |
| Trust | Reports feed the existing moderation desk (the `hostel_risk_signals` pattern), not a bespoke takedown mechanism. |
| Limits and toggles | `platform_settings` keys — `cinema_room_idle_minutes` and `cinema_retention_hours` live now, read with `platformSettingNumber()` and edited on the console settings page; `cinema_uploads_enabled` and `cinema_max_upload_bytes` ship with Phase 2. Nothing is hard-coded. |
| Types and vocabulary | TEXT ISO-8601 timestamps, INTEGER booleans, UPPERCASE status values, `crypto.randomUUID()` ids. |
| Scheduled work | Cleanup rides an existing cron trigger. The Worker already runs four, and Cloudflare collapses triggers that share a minute (see `lib/campus-engine/crons.ts`). |
| Durable Object | One new class, `CinemaRoom`, exported from `worker/index.ts` with its binding and a `v2` migration in `build/cloudflare-binding-plan.ts`. Hibernatable WebSockets, so an idle room costs storage rather than wall-clock duration. |
| Rate limiting | The existing `rateLimit()` helper and the `RATE_LIMITER` binding, with the same fixed-window arithmetic as every other service. |
| Tests | `tests/*.test.mjs` on the shared fake-Turso harness. Sync arithmetic, membership, the state machine and cleanup are pure enough to test the same way the payout and hostel engines are. |

## 0.2 Open decisions

1. **Direct-upload transport (Phase 2, blocking).** A private R2 bucket here is a
   binding; there is no S3 credential or presign code in the repo. Choose one:
   R2 S3 keys plus presigned PUT (new secret, true direct-to-bucket upload), a
   Worker-proxied multipart upload (no new secret, chunked through the Worker), or
   Cloudflare Stream (transcodes and deletes for you, priced per stored and
   delivered minute — verify current rates).
2. **Duration validation (Phase 2).** R2 object metadata carries size and MIME, not
   duration. Either trust a client-declared value, parse the MP4 `mvhd` atom when
   it sits in the object head, or let Stream report it.
3. **Retention default.** `cinema_retention_hours` ships at 2; the R2 lifecycle
   safety net ships at 48 hours.
4. **Room membership default.** Recommended: any signed-in UMaT student holding
   the link may join, and the host may lock the room. Explicit invite lists are a
   later feature.

## 0.3 What this revision changes

- Uploads become **Phase 2**; Phase 1 is YouTube-only and carries no copyright,
  lifecycle or transcoding surface (§4, §17, §22, §23, §24).
- §6 gains the membership rule, WebSocket authentication and signed-URL refresh.
- §7 collapses the undefined `INACTIVE` state.
- §8 and §10 gain the cron, binding and hibernation constraints.
- §11–§12 gain the actual reconciliation arithmetic.
- §14 keeps chat on the room socket and gives it retention and a report path.
- §15 replaces the greenfield schema with `cinema_*` tables over `student_accounts`.
- §16 drops the invented auth endpoints and prefixes every route with `/api/cinema`.
- §18 points the frontend at this repository's structure instead of a new `src/` tree.

---

## 1. Purpose

The platform allows two or more authenticated users to enter a shared study/watch session where they can watch a video together, synchronize playback, communicate through chat, and take part in collaborative discussion.

The platform supports two video-source models:

1. **YouTube Integration** — the platform stores only the YouTube video ID/link and uses the official YouTube player. The platform does not store or copy the video.
2. **Temporary Direct Upload** — a user uploads a video specifically for a study session. The video is stored privately and temporarily, is accessible only to authorized session participants, and is automatically deleted after the session or defined retention period.

Students remain responsible for ensuring that they have the legal right to share any directly uploaded video. Copyrighted material without appropriate authorization is prohibited.

Model 1 is Phase 1; model 2 is Phase 2 (§22). Everything before that split — the
room, the socket, presence, chat and cleanup — is shared by both, which is why the
order matters less than it looks: Phase 1 builds the room and Phase 2 fills one
corner of it.

---

# 2. High-Level Architecture

```text
                         ┌─────────────────────────┐
                         │       STUDENTS           │
                         │  2+ participants/room    │
                         └────────────┬────────────┘
                                      │
                         HTTPS / WebSocket
                                      │
                                      ▼
                    ┌────────────────────────────────┐
                    │        FRONTEND APPLICATION    │
                    │                                │
                    │  Watch Room                    │
                    │  ├── Video Player              │
                    │  ├── Chat                      │
                    │  ├── Participants              │
                    │  ├── Notes                      │
                    │  └── Session Controls           │
                    └───────────────┬────────────────┘
                                    │
                     ┌──────────────┴───────────────┐
                     │                              │
                     ▼                              ▼
          ┌───────────────────┐          ┌────────────────────┐
          │ Cloudflare Worker │          │ Durable Object     │
          │                   │          │ One per session    │
          │ Auth              │          │                    │
          │ API               │          │ Playback state     │
          │ Membership        │          │ WebSockets         │
          │ Signed URLs       │          │ Chat broadcast     │
          │ Upload handling   │          │ Participant state  │
          └─────────┬─────────┘          └─────────┬──────────┘
                    │                              │
          ┌─────────┴──────────┐                   │
          │                    │                   │
          ▼                    ▼                   ▼
 ┌─────────────────┐   ┌────────────────┐  ┌─────────────────┐
 │ Database        │   │ Cloudflare R2  │  │ Real-time Layer │
 │                 │   │                │  │ WebSocket       │
 │ Users           │   │ Temporary      │  │ communication   │
 │ Sessions        │   │ videos         │  └─────────────────┘
 │ Participants    │   │ Private files  │
 │ Upload metadata │   │ Lifecycle TTL  │
 │ Audit logs      │   └────────────────┘
 └─────────────────┘
                    │
                    ▼
          ┌─────────────────────┐
          │ YouTube             │
          │ Official Player     │
          │                     │
          │ External video is   │
          │ not stored by app   │
          └─────────────────────┘
```

---

# 3. Video Source Architecture

## 3.1 YouTube

YouTube is the primary low-storage option.

The platform stores:

```text
provider = youtube
video_id = <YouTube video ID>
```

The client loads the video using the official YouTube player.

The platform does **not**:

- download the YouTube video;
- store a copy;
- proxy the video through its own server;
- extract unauthorized direct-stream URLs.

The platform controls the study-room experience around the official player.

### YouTube Flow

```text
Student
   │
   ├── Creates session
   │
   ├── Provides YouTube URL/ID
   │
   ▼
Backend validates video reference
   │
   ▼
Session stores YouTube video ID
   │
   ▼
Participants join
   │
   ▼
Official YouTube player loads
   │
   ▼
Durable Object synchronizes playback actions
```

---

# 4. Temporary Direct Upload Architecture

Direct upload is intended for a video that the user is authorized to share for the
session. **It is Phase 2, not Phase 1.** Phase 1 rooms play YouTube only, which
means the first release ships with no upload endpoint, no temporary bucket traffic
and no copyright workflow to enforce; the room, the socket and the cleanup job are
the same objects Phase 2 later hangs uploads from.

Its one blocking unknown is transport (see §0.2 and §17): a private R2 bucket in
this repository is a *binding*, and there is no S3 credential or presigning code
anywhere yet. That choice is made before this section is built.

## 4.1 Upload Flow

```text
Student
   │
   ▼
Create Study Session
   │
   ▼
Select "Direct Upload"
   │
   ▼
Confirm ownership/permission
   │
   ▼
Backend authenticates user
   │
   ▼
Validate file type/size/duration
   │
   ▼
Generate unique temporary object key
   │
   ▼
Upload to private R2 bucket
   │
   ▼
Save temporary metadata
   │
   ▼
Session becomes ready
```

### Suggested limits for MVP

- Formats: MP4, MOV, WebM
- Maximum file size: 2 GB
- Maximum duration: 120 minutes
- One direct-upload video per session
- Temporary retention only
- No permanent public video library

These values should remain configurable rather than hard-coded.

---

# 5. Temporary Storage

The recommended storage model is a **private Cloudflare R2 bucket**.

Example object key:

```text
cinema/{session_id}/video/{upload_id}/original.mp4
```

The object must not have a public URL.

Two deployment facts belong with that key. First, the lifecycle rule that deletes
an abandoned object is set on the bucket, not by application code: the deploy
script creates `umatexpress-private` (see `scripts/deploy-cloudflare.sh`), so the
rule is added there or recorded as a runbook step, and the application cleanup is
the fast path with the rule as the safety net. Second, the bucket is the same
private bucket the hostel photos use, so the key prefix is what keeps Cinema's
objects separately routable and separately expirable.

## 5.1 Metadata

The row lives in `cinema_uploads` (§15), so this list is a description of that
table rather than a second schema:

```text
upload_id
session_id
uploader_id
r2_object_key
original_filename
file_size_bytes
mime_type
duration_seconds
uploaded_at
expires_at
deleted_at
status
```

Possible statuses:

```text
UPLOADING
READY
DELETING
DELETED
FAILED
```

`PROCESSING` is not one of them: nothing transcodes in this design, so there is no
window between uploaded and playable. If the transport chosen in §17 is Stream,
that stops being true and the vocabulary grows the state — which is exactly the
kind of change that should be visible in a plan rather than discovered in a queue.

Expiry is expressed by `expires_at`, not by a status: the cleanup job looks for
`READY` rows whose `expires_at` has passed, which is the same shape the payout
release job uses for `release_after`.

---

# 6. Access Control

Only authenticated participants belonging to the session may obtain playback access.

**How someone becomes a participant.** The account already exists: Cinema never
creates one. A signed-in `student_accounts` holder opens `/cinema/{room}` and joins;
membership is the row that join writes. The default rule is link-join for any
verified UMaT student, with the host able to lock the room once everyone expected
has arrived — an invite list is a later feature, and a console staff member may
always enter to moderate. A visitor who is not signed in is routed to the account
page, exactly as campusRide and vacationRide do, and returns to the room afterwards.

## Access Flow

```text
Participant
    │
    ▼
Join Session
    │
    ▼
Authenticate
    │
    ▼
Verify session membership
    │
    ▼
Check session status
    │
    ▼
Check video status
    │
    ▼
Generate short-lived signed playback URL
    │
    ▼
Return URL to authorized client
    │
    ▼
Video player requests temporary object
```

### Security rules

- R2 bucket remains private.
- No permanent public video URLs.
- Signed URLs should be short-lived.
- Membership is checked before issuing a URL.
- Expired sessions cannot obtain new playback URLs.
- Direct video access is not exposed through the application's public API.
- WebSocket connections must also verify session membership.

A suggested signed URL lifetime is **15–30 minutes**.

**WebSocket authentication.** Browsers cannot set headers on `new WebSocket()`, so
the socket is authorised the way the rest of the platform authorises requests: the
session cookie, read on the upgrade request before `CinemaRoom` is ever reached. A
query-string identity (`?userId=…`) is never trusted. For clients where a cookie is
awkward, `POST /api/cinema/sessions/{id}/ws-ticket` mints a single-use ticket bound
to the account and the room, valid for a minute, and the socket carries that.

**Playback URL refresh.** A signed URL that lives 15–30 minutes expires inside a
two-hour room, which is intended: the player asks `GET
/api/cinema/sessions/{id}/video-url` again when a range request is refused, and the
room is none the wiser. The signed URL is a lease, not a session credential, which
is also why ending a room does not pretend to revoke one already issued (§9).

---

# 7. Session Lifecycle

```text
CREATED
   │
   ▼
LIVE
   │
   ▼
ENDED
   │
   ▼
EXPIRED
   │
   ▼
DELETED
```

## Session states

### CREATED
The room exists with its video reference attached and its share link live, but the
host has not opened it. It accepts joins and refuses playback actions.

### LIVE
The host has opened the room. Participants watch, chat and appear in the presence
list; playback actions are accepted from the host.

### ENDED
The host ended it, or `cinema_room_idle_minutes` passed with nobody connected. The
socket closes, joins are refused, and no new playback URL is issued.

### EXPIRED
The retention window (`cinema_retention_hours`) has passed. Nothing is served from
the room any more and its temporary payloads are due for deletion.

### DELETED
Cleanup finished: uploads are gone from R2 and their rows are gone, chat is purged,
membership is closed. The room row itself stays as a tombstone — id, host, times,
nothing playable — so the audit trail and the counters do not lie about what
happened.

Two clarifications this revision makes. `INACTIVE` is gone: it appeared in the
earlier diagram after `READY` and was never defined, and inactivity is already the
second way a room reaches `ENDED`. And `CLEANUP` is a job, not a state: it runs on a
cron, moves `cinema_uploads.status` from `DELETING` to `DELETED`, and leaves the
room at `EXPIRED` until the work is done and the room itself is marked `DELETED`.
`READY` is likewise gone from the room: a Phase 1 room is ready the moment its
video reference validates, and in Phase 2 the upload's own `READY` carries that
meaning where it has to be waited on.

---

# 8. Automatic Deletion

Deletion should use two layers.

The work runs on the Worker's existing schedule rather than a fifth trigger. The
platform already runs four (`lib/campus-engine/crons.ts`) and Cloudflare collapses
triggers that share a minute, so Cinema's cleanup rides the reconciliation trigger
the way hostel refunds do, bounded to a handful of rooms per run so one invocation's
subrequest budget is not spent in one place. Phase 1 rooms hold no video object at
all, so their cleanup is chat and membership; the same job grows the R2 step in
Phase 2 without changing shape.

## Layer 1: Application Cleanup

When a session ends:

```text
Session → ended
       ↓
Stop issuing new signed URLs
       ↓
Close the socket, revoke nothing that was already issued
       ↓
Retention window passes (EXPIRED)
       ↓
Mark upload DELETING, delete the R2 object (Phase 2)
       ↓
Delete temporary metadata, purge chat
       ↓
Write the audit row
       ↓
Mark upload and room DELETED
```

## Layer 2: R2 Lifecycle Safety Net

A lifecycle rule should automatically remove temporary objects after a maximum retention period.

Example:

```text
Temporary object created
        ↓
Session ends
        ↓
Application attempts deletion
        ↓
If application fails:
        ↓
R2 lifecycle rule eventually deletes object
```

A practical MVP safety period can be **48 hours**, while the application's normal cleanup target can be much shorter.

The rule itself is an operator step, not application code: it is configured on the
bucket (the same `umatexpress-private` bucket hostel photos use, under the `cinema/`
prefix), and the deploy script that creates the bucket is where it is either applied
or documented as a runbook check.

---

# 9. Important Deletion Behavior

When the session ends, the application should immediately:

1. Mark the session as `ended`.
2. Prevent new playback URLs from being generated.
3. Close the session's WebSocket connections.
4. Mark the temporary upload for deletion.
5. Delete the R2 object.
6. Remove temporary database metadata.
7. Record the deletion in the audit log.

Short-lived signed URLs naturally reduce the lifetime of existing access. The application should not claim that an already-issued URL can be cryptographically revoked unless the architecture actually provides that capability.

---

# 10. Real-Time Synchronization

Use **one Durable Object per active study session**.

That object is a new class in a Worker that already exports one. Registering it is
three edits: the class and its SQLite storage in `worker/index.ts` (`export {
CinemaRoom }`), its binding and a `v2` migration tag carrying
`new_sqlite_classes: ["CinemaRoom"]` in `build/cloudflare-binding-plan.ts`, and a
route that forwards `/api/cinema/sessions/{id}/ws` to
`env.CINEMA_ROOM.idFromName(roomId)`. The existing `RateLimiter` object is migrated
by `v1`, so Cinema's migration is additive.

The object accepts sockets with the **hibernatable** API (`state.acceptWebSocket`)
rather than keeping a live handler for the room's lifetime. A two-hour study room
would otherwise be billed for two hours of duration; hibernating means an idle
participant costs storage and wakes the object on the next message. Presence comes
from the socket attachments, not from a polling loop.

The Durable Object acts as the authoritative coordination point for:

- play
- pause
- seek
- playback position
- participant join/leave
- chat messages
- session state

## Architecture

```text
Student A ─────┐
Student B ─────┼── WebSocket ──► Session Durable Object
Student C ─────┘                       │
                                       │
                              Current playback state
                                       │
                            ┌──────────┼──────────┐
                            ▼          ▼          ▼
                         Student A  Student B  Student C
```

---

# 11. Playback State

Example state:

```typescript
interface RoomState {
  roomId: string;
  videoSourceType: "YOUTUBE" | "UPLOAD";
  videoId?: string;
  /** Where playback was, in seconds, at the instant below. */
  positionSeconds: number;
  isPlaying: boolean;
  /** Epoch milliseconds of the last authoritative action, not of the last message. */
  updatedAt: number;
  hostStudentId: string;
  participants: string[];
}
```

`updatedAt` is the whole trick. A client never treats it as "the position now"; it
derives the position itself:

```text
expected = positionSeconds + (isPlaying ? (now - updatedAt) / 1000 : 0)
```

and seeks only when its own player has drifted past a threshold — about a second —
from `expected`. A late message is then harmless, two clients' clocks never have to
agree, and a reconnecting client is correct on its first frame. `updatedAt` is
stamped by the object when it accepts an action, never by the sender.

---

# 12. Playback Synchronization

## Play

```json
{
  "type": "play",
  "payload": {
    "time": 124.5
  }
}
```

## Pause

```json
{
  "type": "pause",
  "payload": {
    "time": 124.5
  }
}
```

## Seek

```json
{
  "type": "seek",
  "payload": {
    "time": 240.0
  }
}
```

The Durable Object receives the action, validates the sender, updates the
authoritative state, and broadcasts the change to every participant — including
the sender, whose own `updatedAt` is how it learns whether the object accepted
what it asked for.

Validation is small and strict, because this is the only place a client's word is
taken for the room's state:

- The sender must be the room's host; a participant's playback action is dropped
  and counted, not broadcast. Phase 2 may relax this to shared control.
- `positionSeconds` must be a finite number inside the video's known duration when
  one is known, and merely non-negative when it is not. Anything else is dropped.
- Actions carry the room's `updatedAt` as observed by the sender; an action that
  arrives older than the current state is dropped, which is what stops a
  reconnecting client's stale frame from rewinding the room.
- Chat and actions both pass `rateLimit()`, so a socket cannot be used to flood.

---

# 13. Host Controls

For the MVP, the host should control synchronized playback.

```text
Host
 ├── Play
 ├── Pause
 ├── Seek
 ├── Change video
 └── End session
```

Participants can:

```text
 ├── Watch
 ├── Chat
 └── Ask at a timestamp
```

Asking at a timestamp is a chat message carrying the video position, not a second
feature — see §14. Reactions, polls and shared notes stay in §27, and shared
playback control is the first thing a later version revisits.

Who counts as host is decided once, here: the student who created the room. A
console staff member entering to moderate is not the host and does not take the
controls; they can end the room from the console, which is the moderation action
the platform already understands.

---

# 14. Chat Architecture

Chat messages should use the same WebSocket connection as playback synchronization.

Example:

```json
{
  "type": "chat_message",
  "payload": {
    "message": "Pause at 05:20. I have a question.",
    "timestamp": 320.0
  }
}
```

The `timestamp` allows students to associate a discussion message with a point in the video.

Three platform decisions this section previously left open:

**Delivery is the socket; storage is the table.** The hostel thread is a bounded
server-sent event stream because it is a two-party conversation that must survive
a reload. A room is different: the live path is the socket, and the table exists
only so a student who reconnects — or joins late — sees the last fifty messages
instead of a blank wall. Messages are rows in `cinema_messages`, written the same
way `hostel_messages` are (sender type, sender id, display name, content, metadata
for the timestamp), capped in length, and purged when the room is deleted. Nothing
here is a permanent archive, which is what §26 promises.

**The timestamp travels in `metadata`.** `{ "atSeconds": 320.0 }` on the row, and
the client renders it as a chip that seeks the room when the host clicks it. That is
the whole "timestamped discussion" feature; a separate notes surface is not in
Phase 1.

**Reporting rides the trust desk.** A report is a `hostel_risk_signals`-style row
against the room and the message, with the evidence attached, and it appears in the
console queue the moderators already work. The room does not grow its own takedown
machinery: an admin can end the room and remove a message, and repeated reports
count against the student's standing the same way they do elsewhere.

---

# 15. Database Architecture

## Reused, not rebuilt

| Need | The thing that already exists |
|------|-------------------------------|
| Students | `student_accounts` — verified `@st.umat.edu.gh` holders |
| Staff | `console_accounts` behind `lib/console-auth.ts` |
| Audit | `consoleAudit(...)` and the platform audit tables |
| Moderation | the risk-signal pattern behind `hostel_risk_signals` |
| Limits and toggles | `platform_settings` |

So there is no `users` table here, no `groups` table, and no `audit_logs` table.
`groups` was a table with a membership column and no flow that ever created a row;
sharing in Phase 1 is the room link. Groups return only if a cohort feature is
actually specified.

## Rooms

```sql
CREATE TABLE IF NOT EXISTS cinema_sessions (
  id                TEXT PRIMARY KEY,
  host_student_id   TEXT NOT NULL,                  -- student_accounts.id
  title             TEXT NOT NULL DEFAULT '',
  video_source_type TEXT NOT NULL,                  -- YOUTUBE | UPLOAD
  video_id          TEXT NOT NULL DEFAULT '',       -- the YouTube id in Phase 1
  status            TEXT NOT NULL DEFAULT 'CREATED',-- CREATED | LIVE | ENDED | EXPIRED | DELETED
  join_locked       INTEGER NOT NULL DEFAULT 0,     -- the host can close the door
  started_at        TEXT NOT NULL DEFAULT '',
  ended_at          TEXT NOT NULL DEFAULT '',
  expired_at        TEXT NOT NULL DEFAULT '',
  deleted_at        TEXT NOT NULL DEFAULT '',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cinema_sessions_host ON cinema_sessions(host_student_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cinema_sessions_due ON cinema_sessions(status, ended_at);
```

`cinema_sessions` is the name of record even though the product copy says "room":
the same split campusRide uses, where `campus_rides` carry the word "ride" in the
UI. `video_id` is the YouTube video id for Phase 1 and the upload's id for Phase 2,
which is why the source type is a column rather than an assumption.

## Participants

```sql
CREATE TABLE IF NOT EXISTS cinema_participants (
  session_id     TEXT NOT NULL,
  student_id     TEXT NOT NULL,                     -- student_accounts.id
  display_name   TEXT NOT NULL DEFAULT '',
  joined_at      TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL DEFAULT '',
  left_at        TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (session_id, student_id)
);

CREATE INDEX IF NOT EXISTS idx_cinema_participants_session ON cinema_participants(session_id, joined_at);
```

The Durable Object is authoritative for presence while the room is live; this table
is how a join survives a restart, and how a moderator can answer "who was in the
room" after it ended. A row here is membership, so it is also what playback access
is checked against.

## Chat

```sql
CREATE TABLE IF NOT EXISTS cinema_messages (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  sender_id     TEXT NOT NULL,                      -- student_accounts.id
  sender_name   TEXT NOT NULL DEFAULT '',
  content       TEXT NOT NULL,
  metadata      TEXT NOT NULL DEFAULT '{}',         -- { "atSeconds": 320.0 }
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cinema_messages_session ON cinema_messages(session_id, created_at DESC);
```

Rows exist so a reconnect or a late join is not a blank wall, capped at the last
fifty per room, purged when the room is deleted. This is not an archive.

## Temporary uploads (Phase 2)

```sql
CREATE TABLE IF NOT EXISTS cinema_uploads (
  id                TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL,
  uploader_id       TEXT NOT NULL,                  -- student_accounts.id
  r2_object_key     TEXT NOT NULL,
  original_filename TEXT NOT NULL DEFAULT '',
  file_size_bytes   INTEGER NOT NULL DEFAULT 0,
  mime_type         TEXT NOT NULL DEFAULT '',
  duration_seconds  INTEGER NOT NULL DEFAULT 0,     -- see §0.2 on how it is known
  status            TEXT NOT NULL DEFAULT 'UPLOADING', -- UPLOADING | READY | DELETING | DELETED | FAILED
  expires_at        TEXT NOT NULL DEFAULT '',
  deleted_at        TEXT NOT NULL DEFAULT '',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cinema_uploads_session ON cinema_uploads(session_id);
```

One upload per room, which the unique index enforces rather than trusting the API
layer to remember it. The status vocabulary is the platform's uppercase one, and the
retention dates come from `cinema_retention_hours` at creation time.

---

# 16. API Architecture

## REST API

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/cinema/sessions` | Create a room |
| GET | `/api/cinema/sessions/:id` | Read a room — the public fields only |
| PATCH | `/api/cinema/sessions/:id` | Open, end, lock, retitle (host only) |
| POST | `/api/cinema/sessions/:id/join` | Join, which writes the membership row |
| POST | `/api/cinema/sessions/:id/ws-ticket` | Mint a single-use socket ticket (§6) |
| GET | `/api/cinema/sessions/:id/messages` | The last fifty messages |
| GET | `/api/cinema/sessions/:id/video-url` | Short-lived playback URL (Phase 2) |
| POST | `/api/cinema/sessions/:id/report` | Report a room or a message |

There is no `/api/auth/login`: the account cookie the rest of the client uses is the
only credential, and every route above calls the same `requireStudent`-style guard
that `POST /api/payments/initialize` does. A route that answers with a room also
answers 404 for a room whose status the caller may not see — the same "not yours is
not there" rule the organizer trips follow.

Staff routes follow the house pattern instead of a second surface:

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/console/cinema/sessions` | Live and recent rooms, with filters |
| GET | `/api/console/cinema/signals` | The moderation queue |
| POST | `/api/console/cinema/sessions/:id` | End a room, remove a message |

## WebSocket

```text
wss://umatexpress.acmdevelopers2020.workers.dev/api/cinema/sessions/{session_id}/ws
```

Events:

```text
client → room   play | pause | seek | chat_message | heartbeat
room → client   state | play | pause | seek | chat_message | user_joined | user_left | session_ended | error
```

The socket is same-origin, so the session cookie rides the upgrade and no public
origin has to be allowed for it. Every frame is JSON with a `type` and a `payload`,
the same shape whether it came from the host or the room, and an unknown `type` is
ignored rather than fatal — an old client must not be able to break a room.

---

# 17. Recommended Upload Method

For large videos, do not route the complete file through the Worker.

**This is Phase 2, and the transport is still a decision (§0.2).** What the
diagram below assumes — that the backend can mint an "authorized upload URL" — is
true of an R2 bucket reached over the S3 API with an access-key pair, and this
repository has neither the credential nor the signing code today. The three
honest options, with what each costs:

1. **Presigned PUT (S3 keys).** The diagram as drawn. Uploads never touch a Worker,
   which is what makes a 2 GB file practical; the price is a new secret pair and a
   new failure mode (a leaked key is a bucket-wide key), mitigated by a
   bucket-scoped token and short expiry.
2. **Worker-proxied multipart.** No new secret: the client uploads parts to
   `/api/cinema/sessions/:id/upload/part`, the Worker writes them with its binding.
   Worker request-body limits mean the client does the chunking, and the room's
   upload window has to be generous.
3. **Cloudflare Stream.** The player, adaptive quality, signed playback tokens and
   automatic deletion all come with it. It replaces §4, §5, §8's R2 steps and §17
   entirely, at a per-minute stored and delivered price — worth pricing against one
   term of student uploads before choosing the cheaper-looking option.

Prefer:

```text
Frontend
   │
   ▼
Backend requests upload authorization
   │
   ▼
Backend generates authorized upload URL
   │
   ▼
Frontend uploads directly to R2
   │
   ▼
Frontend tells backend upload is complete
   │
   ▼
Backend verifies metadata/status
```

This reduces unnecessary Worker traffic and is more scalable.

Whichever transport wins, three rules hold: the object key is never returned to a
client, the upload's status is authoritative on the server (a client's "done" is a
claim, checked against the object's existence and size before the room becomes
playable), and a mismatch between declared and stored size fails the upload rather
than the room.

---

# 18. Frontend Architecture

React/Next.js is what the platform already runs; Cinema is a new route group inside
it, not a new application. The shape below mirrors how campusRide and vacationRide
are laid out, down to the `-engine` suffix for the server-only module:

```text
app/
├── cinema/
│   ├── page.tsx                  # create + join, the launcher's landing
│   └── [id]/page.tsx             # the room
├── api/cinema/sessions/…         # §16's routes, one folder per route
└── api/console/cinema/…          # staff routes, console boundary applies

components/cinema/
├── CinemaRoom.tsx                # the client shell: player + presence + chat
├── YouTubePlayer.tsx             # the official iframe, driven by the sync hook
├── SyncController.tsx            # derives position from RoomState (§11)
├── ChatBox.tsx
├── ParticipantsList.tsx
└── RoomControls.tsx              # host play/pause/seek/end

lib/cinema-engine/
├── rooms.ts                      # create, read, patch, join, end
├── youtube.ts                    # url/id validation, one function
├── sync.ts                       # the arithmetic in §11, pure and tested
├── messages.ts                   # the last fifty, the report path
└── cleanup.ts                    # the cron job in §8
```

The room's player is the only place a third-party script runs, so it is loaded the
way the map already is: one component owns the iframe and nothing else does. The
client never computes membership, never decides a status transition, and never
writes a state the server has not confirmed.

---

# 19. Main User Flows

## Flow A — Create Session with YouTube

```text
Login
  ↓
Dashboard
  ↓
Create Study Session
  ↓
Select YouTube
  ↓
Paste YouTube URL
  ↓
Validate video reference
  ↓
Create session
  ↓
Share session link
  ↓
Participants join
  ↓
Watch + discuss
```

## Flow B — Create Session with Temporary Upload

```text
Login
  ↓
Create Study Session
  ↓
Select Direct Upload
  ↓
Rights/permission confirmation
  ↓
Select video
  ↓
Upload directly to temporary R2 storage
  ↓
Validate upload
  ↓
Session ready
  ↓
Invite participants
  ↓
Watch + discuss
  ↓
Host ends session
  ↓
Cleanup
  ↓
Temporary video deleted
```

## Flow C — Join Session

```text
Open session link
  ↓
Authenticate
  ↓
Verify membership/access
  ↓
Connect WebSocket
  ↓
Load video
  ↓
Receive current playback state
  ↓
Watch + chat + discuss
```

---

# 20. Security and Abuse Prevention

## Authentication

Already solved, and not Cinema's business to solve again. A student signs in with
the platform's `student_accounts` credentials — `@st.umat.edu.gh` only — including
the OTP and recovery paths that already exist. Cinema adds no login screen, no
second session cookie and no identity of its own; a room link opened by a visitor
without an account lands on the same account page campusRide uses and comes back.

## Authorization

Every protected operation must verify:

```text
authenticated user
        +
membership row (cinema_participants)
        +
room status (a room that is ENDED, EXPIRED or DELETED serves nothing)
        +
requested resource
```

Two rules make that concrete. A room the caller may not see answers 404, never 403,
so room ids cannot be probed for existence. And the host is the only caller allowed
to mutate playback and state; the check lives in the Durable Object as well as the
route, because the socket is the wider door of the two. Staff access is the console's
existing role check — ADMIN or MODERATOR — and is audited like every other console
mutation.

## Upload Controls

Recommended MVP controls:

- maximum file size;
- maximum duration;
- allowed MIME types;
- upload rate limits;
- per-user upload limits;
- ownership/permission confirmation;
- audit logging;
- report mechanism.

These are Phase 2, and each is a `platform_settings` value rather than a constant:
`cinema_uploads_enabled` turns the whole surface off without a deploy,
`cinema_max_upload_bytes` is the size ceiling, and per-user upload counts are
enforced through `rateLimit()` with the account as the subject, not the IP.

## Storage Controls

- private R2 bucket;
- no public object URLs;
- short-lived signed URLs;
- lifecycle deletion;
- session-specific object keys.

The bucket is the platform's existing private one; the `cinema/` key prefix is what
keeps these objects out of the hostel photo namespace, and the lifecycle rule is
scoped to that prefix so a stray rule cannot expire a landlord's photos.

## Copyright Controls

The platform should require the uploader to confirm that they own the content or have the necessary permission to share it.

The platform should provide:

- reporting;
- takedown workflow;
- audit logs;
- content removal;
- account enforcement for repeated violations.

Temporary storage does not itself make unauthorized copyrighted material lawful.

Phase 1 has none of this surface: a YouTube room embeds YouTube's player, and
YouTube's own reporting and takedown apply. The upload confirmation, reporting and
takedown steps below are Phase 2 work, and the takedown itself is the platform's
moderation desk acting on a signal — not a Cinema-specific workflow.

---

# 21. Failure Handling

## Upload Failure

If upload fails:

```text
Upload status = failed
Temporary incomplete object = cleaned
Session remains without video
User can retry
```

## Processing Failure

```text
Video status = processing
        ↓
Processing timeout
        ↓
Mark as failed
        ↓
Notify uploader
        ↓
Cleanup temporary object
```

## Deletion Failure

```text
Application deletion fails
        ↓
Retry cleanup
        ↓
Audit failure
        ↓
R2 lifecycle policy remains final safety net
```

## Session Abandonment

If the host disappears without ending the session:

```text
No activity
   ↓
Inactivity timeout
   ↓
Session marked ended
   ↓
Cleanup process
```

## Video That Refuses Embedding

YouTube answers `onError` with 101 or 150 when a video's owner has not allowed
embedding, and some videos are also region-restricted. The room cannot play what
YouTube will not serve, so the player reports the failure, keeps the room link
and the host's controls intact, and offers the watch page instead of pretending
to be broken. A room is not ended by it: the host may retitle or end the room
deliberately.

---

# 22. Phase 1 MVP Development Plan

## Goal

Build a working collaborative watch room for verified students, in two phases. The
split is deliberate: Phase 1 needs no new secret, no new bucket behaviour and no
copyright surface, and it is the whole of what "watch together" means. Phase 2 adds
the part with the unknowns.

### Phase 1 — the YouTube room

| # | Feature | Priority |
|---|---|---|
| 1 | Room create/read/patch routes on `requireStudent` | High | ✅ M1 |
| 2 | Join, membership row, link-join and host lock | High | ✅ M1 |
| 3 | YouTube URL/id validation and the official player | High | ✅ validation M1, player M3 |
| 4 | `CinemaRoom` Durable Object, hibernatable sockets, `/ws` route | High | ✅ M2 |
| 5 | Play/pause/seek with the §11 drift rule | High | ✅ M3 |
| 6 | Presence: join, leave, rejoin, "who is here" | High | ✅ M2 |
| 7 | Chat with `atSeconds`, last fifty on reconnect | Medium | ✅ M4 |
| 8 | Host controls: open, lock, end | High | ✅ M1 |
| 9 | Idle and end-of-room transitions, cleanup on the existing cron | High | ✅ M4 |
| 10 | The client room at `/cinema/[id]`, share link, signed-out hop, and the existing `OnlineCinema` launcher card flipped to `available` | High | ✅ M1 |
| 11 | Console service entry, live-room list, end-room action | Medium |
| 12 | Report into the moderation queue | Medium |
| 13 | `rateLimit()` on create, join, chat and socket connect | Medium | ✅ create/join/socket M1, chat M4 |
| 14 | Tests: sync arithmetic, state machine, membership, cleanup | High | ✅ M1–M4 |

**Status: M1, M2, M3 and M4 delivered.** A signed-in student creates a room, shares
the link, and everyone in it sees presence live; the `CinemaRoom` object accepts
hibernatable sockets at `/api/cinema/sessions/{id}/ws`, the Worker route
authenticates the cookie and checks membership before the upgrade, and the client
reconnects with backoff across a deploy. The room is in sync: the official
YouTube player is driven by the object's state, the host's play, pause and seek
carry the §11 arithmetic, a member's own pause is undone, and a refresh rejoins
mid-playback. The room is safe: chat travels the room socket, is stored in
`cinema_messages` with its `atSeconds` chip, is rate limited per student (eight
messages per ten seconds), and the last fifty are replayed to a reconnecting
student. A room nobody is in ends after `cinema_room_idle_minutes`, and an ended
room is purged of chat and membership after `cinema_retention_hours` by the
cleanup job on the five-minute reconcile trigger, leaving a tombstone row. Both
limits are console settings, not constants. Verified against workerd and in
headless Chrome locally: two sockets follow the host within a second, a new
socket catches up on connect, a browser page follows a seek to 120s and a pause,
and a member's pause is pulled back. The console list (M5) is not built yet.

### Phase 2 — temporary uploads

| # | Feature | Priority |
|---|---|---|
| 1 | Decide the transport (§17) and implement it | High |
| 2 | Upload row, one per room, server-side status | High |
| 3 | Signed playback URL, refresh on refusal, range playback | High |
| 4 | Size/MIME enforcement, duration question answered (§0.2) | High |
| 5 | Ownership confirmation before the upload starts | High |
| 6 | Cleanup of the object, and the bucket lifecycle rule | High |
| 7 | Report/takedown enrichment for uploaded video | Medium |

### Acceptance for Phase 1

A signed-in student creates a room, shares the link, and a second signed-in student
joins; the host's play, pause and seek land on both browsers within a second and
survive a refresh; a third student with the link but no account is sent to sign in
and returns to the room; a room whose host closes the tab ends itself and serves
nothing afterwards; and the console shows the room while it is live.

---

# 23. Build order

The earlier draft of this section was a six-to-eight-week greenfield schedule, and
its first week was "set up repository, Cloudflare account, database and
authentication" — all of which this platform finished months ago. What is left is
the order the work has to happen in, as milestones rather than calendar weeks, in
the same shape the Hostel Finder rollout used.

| Milestone | What ships | What proves it |
|---|---|---|
| **M1 — the room exists** | `cinema_sessions`, `cinema_participants`, create/read/patch/join routes, the client room shell, share link, the launcher card switched on | two signed-in students are in the same row of the same room |
| **M2 — the room is live** | `CinemaRoom` Durable Object, `/ws` route with cookie auth, hibernatable sockets, presence | a socket survives a Worker deploy and presence empties when a tab closes |
| **M3 — the room is in sync** | YouTube player, play/pause/seek, the §11 arithmetic, host-only validation | host seeks, two browsers follow within a second, refresh rejoins mid-playback |
| **M4 — the room is safe** ✅ | chat with timestamps, rate limits, lock, end, idle expiry, cleanup job, tests | a flooded socket is limited, an abandoned room expires and serves nothing |
| **M5 — the room is watched** | console service entry, live-room list, end-room action, report queue | a moderator ends a reported room from the console and the sockets close |
| **M6 — Phase 2 opens** | the transport decision in §17, then uploads per §22 | a private upload plays for members only, and is gone after retention |

M1 through M5 are Phase 1 and are the gate for asking anyone outside the team to use
it. M6 is deliberately the first thing that needs a decision, not the first thing
that needs code.

---

# 24. MVP Success Criteria

Phase 1 is functional when everything below except *Direct Upload* holds. Direct
Upload is the Phase 2 gate, and the copyright line under Security is Phase 2's.

### Session

- A verified user can create a session.
- Another user can join.
- At least two participants can remain connected simultaneously.

### YouTube

- A valid YouTube video can be attached.
- Participants see the same video.
- Host play/pause/seek actions synchronize.

### Direct Upload (Phase 2)

- Authorized uploader can upload a permitted video.
- Video is stored privately in R2.
- Participants receive access only after membership verification.
- Signed playback URLs expire.
- Video is deleted after session cleanup.

### Collaboration

- Participants can chat.
- Participants can see who is present.
- Messages can reference video timestamps.

### Security

- Non-members cannot obtain playback URLs.
- Direct R2 URLs are never public.
- Expired sessions cannot generate new video access.
- Upload and deletion activities are audited.

---

# 25. Recommended Technology Stack

| Layer | Technology |
|---|---|
| Frontend | The platform's Next/app-router client, a new `/cinema` route group |
| API | The existing Worker, new `/api/cinema/*` routes behind `requireStudent` |
| Real-time | Durable Objects + hibernatable WebSockets (`CinemaRoom`) |
| Temporary video storage | R2 `PRIVATE_BUCKET` under a `cinema/` prefix, or Stream (§17) |
| External video | The official YouTube IFrame player |
| Database | The existing Turso database, `cinema_*` tables |
| Authentication | The existing `student_accounts` + `@st.umat.edu.gh` rule; no new login |
| Staff surfaces | The existing console, a new Cinema service entry |
| Scheduled cleanup | An existing cron trigger, not a new one (§8) |
| Limits | `platform_settings`, toggled from the console settings page |
| Monitoring | `logEvent`/`consoleAudit` and the existing observability path |

---

# 26. Cost-Control Strategy

The architecture is intentionally designed to avoid permanent storage of every student-uploaded video.

### YouTube

No platform video storage.

### Direct upload

Only temporary storage — and the cost that decides the transport in §17. R2 charges
for storage and operations but not egress, which is why it is the default; Stream
charges per minute stored and per minute delivered, which buys transcoding, adaptive
playback and deletion without a lifecycle rule. Price one term of real uploads
before choosing, and prefer whichever lets retention stay short.

### Durable Objects

Used only while sessions are active.

### R2

Stores temporary files and relies on lifecycle deletion.

### Database

Stores metadata rather than video files.

### What Phase 1 costs while idle

A Phase 1 room with nobody in it is one Durable Object with hibernated sockets: a
few storage operations and no duration. That is the property worth protecting in
review — a change that keeps a live handler awake for the room's lifetime would
turn an idle platform into a metered one.

This means the main platform data is:

```text
Users
Sessions
Participants
Video references
Temporary upload metadata
Chat
Audit logs
```

rather than a permanent movie/video library.

---

# 27. Future Extensions

These should remain outside the initial MVP:

- voice chat;
- video conferencing;
- screen sharing;
- polls;
- reactions;
- collaborative notes;
- AI video summarization;
- AI-generated quizzes;
- timestamped questions;
- session recordings;
- learning analytics;
- institutional administration;
- mobile applications;
- additional licensed video providers.

Two of those were previously listed twice, in the frontend diagram and again here:
notes and reactions. The diagram no longer shows a Notes panel, "reactions" is
absent from the participant list in §13, and both live here, unbuilt until asked
for. The same goes for groups, which this revision dropped from the schema rather
than carrying a table no flow creates.

---

# 28. Final Architecture Summary

The platform should operate as a **collaboration layer around authorized video content**, rather than as a permanent video-hosting or movie-distribution platform.

The preferred architecture is:

```text
                     COLLABORATIVE STUDY PLATFORM

       ┌─────────────────────────────────────────────┐
       │                 FRONTEND                    │
       │                                             │
       │  Video │ Chat │ Participants │ Notes       │
       └─────────────────────┬───────────────────────┘
                             │
                    HTTPS + WebSocket
                             │
              ┌──────────────┴──────────────┐
              │                             │
       Cloudflare Worker             Durable Object
              │                             │
       ┌──────┼──────┐              ┌───────┼──────┐
       │      │      │              │       │      │
      Auth   API   Upload         Sync    Chat   State
       │      │      │
       │      │      ▼
       │      │    R2 Private
       │      │    Temporary Video
       │      │
       │      ▼
       │    Database
       │
       ▼
   User/Session
    Management

             External video path
                    │
                    ▼
              YouTube Player
                    │
                    ▼
             Student Browser
```

The central principle is:

> **Permanent video hosting is avoided wherever possible. YouTube content remains with YouTube, while direct uploads are isolated to a specific study session, protected by authentication and signed access, and automatically removed after the session or retention period.**

And where it sits in the platform: Cinema is the fourth service behind the same
sign-in, on the same Worker, writing to the same database, watched from the same
console, and bound by the same rules that already govern campusRide, vacationRide
and Hostel Finder. Nothing in this plan is a reason to build a second one of
anything.
