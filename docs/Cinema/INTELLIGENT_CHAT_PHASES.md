# Intelligent cinema chat

## Implemented milestone: Phases 1–6

Room chat supports immediate-parent replies and a stable root thread, reply previews, thread navigation, and paginated history. Each persisted message receives a monotonic sequence in `cinema_message_order`; messages and their ordering record are committed atomically. A reconnect reconciles from the oldest loaded sequence through a fixed snapshot boundary rather than relying only on the socket's 50-message replay. Client merges are ordered and deduplicated by message ID.

The composer preserves its text and original request ID, parent, video and timestamp until delivery is acknowledged. Retrying after a playlist change acknowledges an already stored message instead of creating a second message against the next video. If an unsaved reference no longer matches the current video, the sender can remove the video reference and submit a new request.

Video references contain the source type and video ID as well as the timestamp. The Durable Object stamps the source from the room snapshot and checks any client-supplied expected source. Existing messages without source context retain a static timestamp; they cannot accidentally seek into a different playlist file.

Hosts and co-hosts can open a stored message reference, including returning to an earlier ready upload. Presenters can seek within the current file. Viewers receive static reference chips. Navigation reads the stored message and validates room membership, role, active room status, source availability, and the current database selection. The room pauses at the referenced moment; it does not autoplay a different video unexpectedly.

## Phase 3: Ask Cinema

Members explicitly request an answer by mentioning `@Cinema` in a room message or using **Ask Cinema** in the composer. Ordinary chat does not invoke a model. The host must enable **Allow AI study and chat** in the transcript settings, and model-backed answers require the deployment’s existing intelligence or Workers AI provider to be configured. Host consent is off by default. Chat is acknowledged before background AI work begins; provider failures do not prevent message delivery.

Each question has one durable job and a deterministic answer ID. Atomic claims, expiring leases and claim tokens prevent overlapping workers from publishing duplicate answers. An invocation has a 35-second model deadline, at most three attempts, and one active request per member across rooms. New shared and private requests together are limited to six per member and thirty per room per hour. The active-request fence also spans both paths. Failed requests offer an explicit retry; requesters and hosts/co-hosts can cancel pending work. Cancellation prevents publication; a provider call that has already started may still complete. The existing reconciliation cron nudges queued or abandoned jobs through their room Durable Object.

The model receives a bounded selection of earlier messages and unexpired transcript passages from the same room. Replies include their chosen parent and a bounded thread window even when that parent is older than the last 100 room messages. Video-bound questions use matching source type and video ID. Newly stored captions carry video context; older captions with unknown context are excluded from video-bound answers. Caption submissions from the current UI reject a changed selected video instead of attaching an old import to the next playlist entry.

Answers are plainly labelled as AI-generated and reply within the question's thread. Source buttons retrieve the original passage through a membership-checked API, including its stored timestamp. The model may only cite supplied source keys; unknown citations or malformed answers fail without publishing. When evidence is insufficient, Cinema says so. These checks establish provenance, not factual certainty: participants should inspect the sources.

Consent, membership, question availability and all supplied sources are rechecked before publication, with final database guards inside the publication transaction. Removing a question, answer or any supplied message invalidates the derived response, including an input omitted from the model’s citations. Transcript clearing and expiry remove derived text in the same transaction as its evidence; source previews also reject expired or changed passages. Job evidence stores source IDs and digests rather than extra copies of transcript or message text.

## Phase 4: Chat overviews

Three composer actions prepare explicit requests for a report in the room chat. They preserve an existing draft by remaining disabled until it is sent or cleared. The participant sends the prepared message through the normal composer, with the usual delivery acknowledgement, retry identity and background job status.

- **Catch up** prepares `@Cinema catch up on the recent conversation`. Cinema produces up to six short highlights, each linked to one to three source messages. Statements and disagreements stay attributed to the conversation.
- **Repeated questions** prepares `@Cinema group repeated questions`. Cinema suggests up to four groups, each containing two to six distinct questions. Counts come from the cited message IDs; a question cannot appear in multiple groups. Original questions and threads remain intact.
- **Questions without replies** prepares `@Cinema show questions without replies`. A database query finds detected questions with no direct thread reply recorded by the request boundary. It shows the latest ten and the total within the selected window. This digest needs no model or provider configuration, while retaining the room’s AI study and chat consent gate.

Every overview inspects the latest 100 room chat entries before its request and uses at most 40 eligible messages or detected questions. A linked request filters to its exact video source and ID. Clearing **Link the current video and moment** includes eligible chat across the room. The report shows its request time, input count, scanned entry count and any earlier-history limit. A later reply or playlist change does not rewrite a saved snapshot.

Overviews use room chat. They exclude prior assistant output and overview requests, and do not pull in transcript passages or the separate Questions panel. Question detection recognizes question marks, common English question/opening verbs and explicit `@Cinema` questions. The digest describes recorded direct replies; participants can inspect the source and open its conversation to assess progress. Suggested duplicate groups require human judgment.

Reports reuse the existing consent, membership, job claim, cancellation, retry, hourly budget and retention controls. All supplied inputs become evidence dependencies, including those not quoted in an output. Dependency revalidation uses bounded batch reads. Removing an input cancels its dependent report and removes derived text; open clients also hide cached reports immediately on message-removal events. Source previews can open the original conversation after the same membership and evidence checks.

Structured overview data lives in the existing assistant message metadata; no additional database migration is needed for Phase 4. Ordinary chat still performs no automatic model calls. Summaries and suggested question groups invoke the configured provider only when explicitly requested and sufficient eligible input exists.

## Phase 5: Private study and personal notes

**Open private study** opens an account-only explanation panel inside chat. **Explain privately** on a human message selects that message as the source; the participant can review and edit the private question before choosing **Ask privately**. A private question can also use current-video sources or, with that filter cleared, room-wide evidence. Anchored questions keep the selected message’s original video context. A fixed sequence boundary excludes later chat from an already saved request.

Private questions, job states, answers and citations live in separate tables and owner-checked endpoints. They never enter room messages, message ordering, shared assistant job lists, summary inputs or socket broadcasts. Room hosts and co-hosts have no override for another participant’s private requests. The API uses the authenticated account; an optional expected-account header also rejects requests issued by a stale account view. Every read, mutation and source preview checks current membership and ownership.

The room’s AI consent gate and configured provider are required for private generation. The UI explains that the private question and selected room sources are sent to that provider. Jobs reuse bounded evidence collection, model deadlines, three-attempt claims, cancellation fences and the combined shared/private allowance. Unknown citations and changed sources fail without publishing. Private job recovery runs through the Durable Object without any room event callbacks. Owner polling retrieves results.

Private explanations expire after 24 hours and are unreadable after expiry, before physical cleanup runs. Room retention purges them sooner when applicable. Deleting a private request clears its question, answer, source links and claim immediately; a content-free usage tombstone remains until expiry to prevent deletion from resetting the hourly allowance. Removing an input message or clearing/expiring a transcript removes the derived private answer. Explicitly saved local notes and sent chat excerpts are user-created copies with their own storage and moderation lifecycle.

**My notes** remains browser-local. Pages are now keyed by account and room, and saving an explanation appends to that account’s local page. Notes are never included automatically in AI prompts or server requests. Storage failures are shown honestly; an append cannot overwrite unsaved edits or silently truncate a full page. Earlier device-wide notes require an explicit review and copy action because their original account ownership is unknown. The original device copy is preserved. PDF export, clipboard copy and clearing the current page remain available.

To share, the participant selects an excerpt from an explanation or note and chooses **Review selected … for sharing**. A review area shows exactly the chosen text, permits editing and enforces the normal 500-character chat limit. An existing room draft remains intact. **Use excerpt in composer** prepares a plain user-authored message; only the ordinary **Send** action publishes it. The private question, full explanation, private request ID and other notes are not attached. Shared explanation excerpts start with an editable AI explanation label. Normal chat behavior applies to the selected text once sent.

`sql/053_cinema_private_study.sql` adds private requests, owner/queue/expiry indexes and evidence references. The runtime schema and full consolidated migration include the same definitions. Private content is stored on the application backend for its stated lifetime.

## Phase 6: Host-reviewed assistance

Hosts and co-hosts can open **Host assistant** in room chat and explicitly request a poll draft, discussion prompt or moderation review. Each draft belongs to its requesting account. Current host/co-host authority is required on every draft read, source preview, retry, dismissal and approval; other hosts cannot open another account’s drafts. Draft generation and completion send no room socket events and do not appear in personal study history or shared assistant job lists.

- **Poll draft** proposes one opinion or understanding poll with two to six distinct choices. The host edits the question and choices before choosing **Open reviewed poll**. AI suggestions do not set a quiz answer key.
- **Discussion prompt** proposes a source-linked message. The host can edit up to 500 characters before choosing **Post reviewed prompt**.
- **Moderation review** examines at most 40 eligible messages from the latest 100 shared chat entries. It excludes learner-private questions, explanations, local notes and transcript passages. Up to four observations link to original message evidence and suggest a neutral reminder. The host checks the conversation and edits a reminder before choosing **Post reviewed reminder**. Generation has no removal, muting, reporting, role-changing or penalty action path.

Polls and discussion prompts use the existing bounded room-message and transcript evidence collector, with an optional current-video filter. Drafts show their source count and snapshot time; a draft based on a previous video selection is labelled accordingly. All modes treat messages and the host brief as untrusted input, accept only supplied citation keys, and validate structured output before showing a review card. Empty evidence produces an explanation instead of an actionable suggestion.

Drafts reuse the owner-private background queue, three-attempt claims, cancellation fences, 24-hour expiry and the combined six-per-account/thirty-per-room hourly allowance. Purpose records are inserted atomically with the queued request. A host losing their role during model work cannot complete the draft, and normal private-study endpoints cannot bypass the host-purpose check. Every supplied source is a dependency, including uncited inputs.

Approval rechecks membership, role, room status, AI/transcript consent, expiry and source digests. Final existence, consent and role guards execute inside the same transaction as the published poll/message and its review record. The record captures the approving account, time and result ID. Concurrent approvals and retries after a lost acknowledgement return one committed artifact; the first approved version wins. Public artifact IDs do not expose private draft IDs, and a new request lifetime after expiry cannot accidentally acknowledge an older poll.

Only approval publishes. Reviewed messages carry the host’s identity and an **AI-assisted · Host reviewed** label; reviewed polls carry the same label and use normal voting and closing controls. Existing room update hints notify open chat and poll views after the transaction. Applied artifacts follow ordinary chat/poll moderation and room retention; removing a draft source or expiring the private draft does not retract a host-approved artifact. Before approval, source deletion or expiry clears generated draft text and prevents publication.

`sql/054_cinema_host_assistance.sql` adds content-free purpose and review records. Generated draft content remains in private study storage, so its existing deletion and transcript retention paths clear it. Room and request expiry also remove associated review records. The runtime schema and consolidated migration include the same table.

## Storage, permissions and retention

`sql/051_cinema_chat_threads.sql` creates the ordering/relationship table and backfills existing messages in their original timestamp/row order. The runtime schema pass performs the same idempotent migration. The table is also included in the full migration. `sql/052_cinema_chat_assistant.sql` adds durable assistant jobs, evidence references and transcript video context; runtime schema passes and the full migration include the same tables.

The existing message table holds content and optional video metadata. Moderation deletes that content. A content-free ordering row remains until room retention cleanup, allowing history and thread views to show a removed-message placeholder. Reply previews resolve their parent dynamically; they never embed a permanent copy of removed text. Tombstones received from the socket or history cannot be overwritten by stale pages.

The history API checks membership for every page and never resolves a parent from another room. Message IDs and thread IDs do not grant access. Existing message reports, delivery acknowledgements, rate limits and room retention continue to apply.

Room snapshots, socket caches and mounted tools are scoped to the signed-in account. An account change removes the previous room immediately and checks access again before mounting its stage or audience view. The Durable Object rechecks current database membership before processing valid frames, replaying chat or broadcasting room content; removal notifications only accelerate closure. If membership cannot be verified, sockets close with a retryable status. Chat persistence also fences membership and active-room status inside its write transaction.

Live authorization refreshes operational roles from the same database read. A missed role notification cannot preserve co-host privileges, and a demoted stage member's media flags are cleared. Authorization captures socket identities before awaiting external reads and rechecks attachments afterward, so concurrent removal does not reject another member's frame. Video-linked seeks require the database selection and Durable Object source to agree with the reference.

Caption playback uses the current source type and video ID, excludes unbound legacy rows, and clears its client cache immediately when the selected video changes. Transcript and caption reads enforce expiry before scheduled cleanup. Poll votes check open status, active-room status and membership in the write itself. Host dismissal and approval use transaction guards so exactly one action wins; a completed approval retains its draft, evidence and publication receipt.

The lobby also remounts its account-specific state on sign-in, sign-out and verification changes, clearing room lists and dialogs. Quiz normalization preserves the host's selected answer when empty choices are removed, and failed poll creation preserves the full draft. Interrupted uploads offer explicit cancellation after reload or transfer failure; cancellation identifies its upload so a stale tab cannot abort a replacement.

`sql/055_cinema_bookmark_video_context.sql` records new bookmarks' video source and ID atomically with each bookmark. The runtime schema and full migration include the same table, and room cleanup removes its rows. Legacy bookmarks remain unbound. Transcript archives expose their existing stored video context. Bookmark and transcript timestamp links require an exact current-video match, with an explanation for a different or unknown video; socket seeks also reject a changed video. Subtitle controls sit inside the playback surface below the room heading.

Upload cancellation claims the in-flight row before touching object storage. Completion atomically marks that row ready and selects it only when its transition succeeds. The loser cannot select a cancelled file or delete a ready file, and completion cleans up objects that arrive after cancellation.

Shared study packs recheck current AI consent, transcript permission, membership, host/co-host role, room status and all supplied source passages in the publication write. Deleted, changed or expired inputs prevent publication. Clearing a transcript deletes the shared pack, and revoked AI consent hides existing pack text and PDF actions. Source refresh hints reload the study panel. Automatic generation makes one attempt per ended room in a tab, with an in-memory fallback when session storage is blocked; failures require an explicit retry.

Shared packs also retain dependency IDs, SHA-256 hashes and transcript expiry times, without storing extra copies of source text. Reads validate every supplied source and hide or delete invalid packs before cleanup. Bookmark deletion, transcript clearing, transcript expiry cleanup and room deletion remove dependent packs and their evidence. The panel hides cached text and PDF export at the earliest source expiry, reloads on room hints and checks published packs every 30 seconds. Existing packs without dependency records require regeneration.

Study chapters cite a supplied source key. The server derives the timestamp and original video from that source; generated timestamps or video IDs are ignored. A jump requires an exact match with the room's current live video, and sends that context to the room socket. Chapters from unknown or different videos remain readable with disabled jump controls.

`sql/056_cinema_study_evidence_claims.sql` adds dependency records and job claims; runtime setup and the full migration include the same tables. Automatic ended-room generation and manual requests use the same queue and conditional claim. Each claim has a three-minute lease and a unique token; expired workers cannot publish or complete a replacement's job. Model work times out after 35 seconds. At most three claims are allowed before repeated lease expiry fails the job; a manual retry resets the attempt budget. Duplicate requests cannot reset an active lease.

## Verification

```sh
node tests/cinema-access-regressions.test.mjs
node tests/cinema-host-assistance.test.mjs
node tests/cinema-private-study.test.mjs
node tests/cinema-chat-overviews.test.mjs
node tests/cinema-chat-assistant.test.mjs
node tests/cinema-chat.test.mjs
node tests/cinema-chat-history.test.mjs
node tests/cinema-console.test.mjs
node tests/cinema-study-jobs.test.mjs
node tests/cinema-cleanup.test.mjs
node tests/cinema-uploads.test.mjs
node tests/cinema-socket.test.mjs
node scripts/cinema-chat-browser.mjs
node scripts/cinema-account-browser.mjs
node scripts/cinema-ui-browser.mjs
```

The chat browser test renders the real React panel against deterministic API fixtures. It checks older-history loading, reply context, deduplicated retries after lost acknowledgement, recovery of 75 missed messages, removal of parent text, stored-reference navigation, mobile overflow, explicit AI requests, labelled answers, source previews, retries, cancellation, cached-answer removal, all three overview actions, snapshot scope labels, group counts, draft preservation, room-wide scope selection, source-to-thread navigation, invalidation of uncited input dependencies, private delivery retries, source inspection, selected sharing, account isolation, explicit legacy import, unsaved-note preservation private cancellation/deletion, editable host drafts, source inspection, explicit approvals, lost-acknowledgement retries, reviewed labels and evidence invalidation. Host service tests exercise concurrent approvals, authorization and consent changes at transaction boundaries, purpose isolation and approval records. Private storage tests also exercise ownership restrictions, combined budgets, retention, stale claims and the absence of private socket events. Storage tests execute real SQLite queries; navigation tests exercise authorization and source validation. The browser test requires local Chrome and permission to listen on localhost. It does not publish or connect to production.

## Milestone status

All six planned chat phases are implemented locally. Model-backed features invoke the configured provider only for explicit, consented requests with available evidence. Automated tests use injected model responses and local fixtures; they do not call a paid provider or publish a deployment.
