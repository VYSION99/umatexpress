# Cinema Discussion Mode

Discussion events use the existing public Cinema catalogue. A UMaT student organizer chooses **Student debate** or **Panel discussion**, sets a verified-audience threshold from 10 to 100, chooses two to six speaking-stage places, and attaches a YouTube live broadcast. The host uses one stage place. Public screenings and tutorials also have a 100-viewer reservation ceiling; older clients that send zero for an unlimited screening now receive the 100-viewer limit.

Any account with a verified email may RSVP and attend. Public audience accounts cannot use student-only booking or payment services. The event page remains visible without signing in. A confirmed RSVP is required to enter the room; a direct room link does not bypass that check. A full discussion puts later RSVPs on a first-in waitlist. Cancelling a reservation promotes the earliest waiting account and queues a notification.

Audience members watch the broadcast without opening a WebRTC room socket. They can submit questions for host/co-host approval, vote in polls, and request a speaking place. The host/co-host sees speaking requests, admits a person into an available stage slot, or declines them. On approval, the attendee switches to the small interactive stage call. Returning them to **Viewer** stops their device tracks and returns them to the broadcast audience. The server rejects viewer microphone, camera, screen-share and WebRTC signal attempts in discussion rooms.

## Broadcast setup and current boundary

The host must publish the stage audio/video to the attached YouTube live feed with their own broadcast setup. The in-app stage call does **not** automatically mix or transmit itself into that feed. The stage screen does not autoplay the delayed broadcast, which prevents feedback into the call. A public or unlisted YouTube URL can still be viewed outside UMaTeXPRESS if someone obtains the link: the host threshold limits **in-app admission and participation**, not all playback on YouTube. Do not advertise the event as a private, capped stream.

The 100-person discussion cap is an application limit, not a measured production guarantee. Load-test the audience polling, questions, polls, database and notification path on the deployed stack before advertising that capacity as proven. To enforce playback admission outside the app, replace the YouTube feed with signed viewer-specific live playback. A managed stage-to-broadcast pipeline would also remove the current external broadcast setup requirement.

## Organizer approval

Students may publish under a self-named student group. Club and department names require an admin-approved organizer request first. Existing club or department records created before this approval rule are unverified until reviewed; their events are withheld from the public catalogue. The Cinema console shows pending requests to admins, who must confirm that the student is authorized to represent the named organization before approval. The approval decision records the admin and time and writes a console audit entry.

Applicants provide their role and an affiliation reference. Admins record the contact or other source they checked, or the rejection reason, with each decision. Revoking an organizer also blocks existing attendees from direct room and stage access. The reference and reviewer note form an audit trail; staff must still perform the actual check outside the app.

Certificate eligibility accumulates live presence through consecutive heartbeats, crediting at most 90 seconds per heartbeat gap. A brief visit or a single heartbeat is insufficient. The required total is half the scheduled event, bounded to 10–30 minutes. Browser presence remains weaker than identity-verified attendance, so organizers should enable certificates only where that standard is appropriate.

## Approved managed-stage rollout

The next media path uses managed JaaS for host and panelist video. Standard
events stream directly from JaaS to YouTube or a configured Cloudflare Stream
RTMP input; OBS remains optional for organizer-operated productions. This is a
target architecture and remains disabled until server-issued JaaS tokens,
provider configuration and staged acceptance tests are complete. The existing
peer stage remains the fallback during rollout.

Free managed-stage access belongs to the event organizer, not the current host:
one public event per rolling 30-day reservation period, up to 60 minutes and
four unique verified stage identities including the host. A host transfer or
delegate never resets that allowance. The canonical controls, schema and
acceptance gates are in `HYBRID_STREAMING_IMPLEMENTATION_MAP.md`.

## Release validation still required

Browser speech recognition and imported WebVTT are the current caption sources; there is no server-side speech-to-text service. The stage call remains a small peer-to-peer mesh; LiveKit or another media server is not connected. Before advertising a single-click public broadcast or dependable 100-person event, implement the stage-to-broadcast path and run a deployed load test covering admission, questions, polls, reminders, and the database. Until then, event pages tell attendees that the YouTube feed is separate and may be viewed outside the in-app attendance limit.

## 100-person application rehearsal

Run `node scripts/cinema-audience-100.mjs` to repeat the local rehearsal. On 14 October 2026 it passed with 120 simultaneous RSVP attempts: 100 confirmed, 20 waitlisted. All 100 confirmed accounts entered, voted in a poll, and refreshed polls and questions. Thirty submitted questions at once; three audience members joined a four-person speaking stage alongside the host, and a fourth request was refused when the stage was full. A waitlisted account could neither enter nor obtain the broadcast ID. The rehearsal uses the application functions and their actual SQL against an in-memory SQLite adapter. Its timings do **not** represent hosted database, HTTP, device, YouTube, or campus-network performance. A deployed test must separately check 100 real playback clients and a working host-to-broadcast path.
