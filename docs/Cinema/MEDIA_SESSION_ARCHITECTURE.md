# Cinema media sessions

Camera, microphone, and screen sharing use a session-scoped controller. React renders snapshots; it does not own peer connections or pending device operations.

## Control and transport

- `lib/cinema-engine/media-controller.ts` defines the shared provider contract and command controller. Audio and video have independent serial queues; screen sharing uses the video queue. Disposing a session invalidates waiting commands. Confirmed device state is separate from requested state: a rejected camera command restores its intent without stopping a presentation.
- `lib/cinema-engine/mesh-media.ts` implements the small-room WebRTC transport. It owns capture versions, tracks, peer connections, signaling, recovery, and remote streams.
- `lib/cinema-engine/jaas-media.ts` implements the managed-stage adapter. Explicit mute checks the current provider state and waits for the provider's mute event. A single eight-second deadline covers both the state query and acknowledgement; timeout/disposal settles the command and prevents late replies from issuing toggles. Repeated mute commands never toggle a muted microphone back on. Releasing this adapter hangs up and disposes the managed conference.
- `components/cinema/useCinemaMedia.ts` fetches authorized media policy, buffers early signaling, owns the engine lifecycle, and renders its snapshots. It also computes speaking levels.
- `components/cinema/CinemaJaasStage.tsx` owns the managed iframe and routes the same room mute signal through its controller. Managed media events update the room's presence flags.

This is asynchronous coordination, not a new Web Worker for media transport. Browsers own WebRTC capture and transport execution.

## Device lifecycle

The controller serializes commands for each device independently. A camera permission prompt cannot block microphone mute. Turning off a device invalidates its pending capture; ending the session invalidates every capture. A late permission result has its tracks stopped without being published. Browser device termination clears capture flags and announces the change.

Device states (`off`, `requesting`, `ready`, `denied`, `failed`) describe capture. Connection states (`connecting`, `connected`, `reconnecting`, `failed`) describe transport. A ready device is not a claim that its bytes reached another participant. Track publication errors are shown separately, and the room offers a reconnect action.

## Negotiation and recovery

Signaling is serialized per participant while different participants proceed concurrently. Lexical participant IDs select the polite peer during simultaneous offers. After accepting an offer, the engine attaches local tracks to negotiated send/receive slots before answering; browser rollback can otherwise leave a connected call with media flowing in only one direction.

Signal payloads optionally carry `connectionId` and `replyTo`. The server validates and preserves these IDs. Replaced sessions reject stale replies and retired remote generations. Candidate queues are bounded and filtered by generation. Older clients without IDs remain supported, with weaker stale-message protection.

A stalled connection first attempts an ICE restart, then rebuilds its peer with bounded delays. Recovery stops after three attempts and stays exhausted across unchanged presence updates and old signaling. An explicit local reconnect, actual departure/rejoin, or a new generation from a previously negotiated remote session can begin a new budget. Membership removal and session disposal cancel the connection's recovery timer. Manual reconnect starts a fresh attempt without reopening the user's devices.

## Managed-stage ownership

Every join uses a fresh UUID as its ownership token. A delayed DELETE from an earlier join cannot release its successor. The initial access response includes `activeUntil`; `PUT /api/cinema/sessions/:id/jaas` renews ownership every minute after checking the account, stage role, event state, and matching unexpired token. Renewals do not mint another provider token or change monthly usage. The lease never extends beyond the entitlement deadline.

The client stops the conference immediately on an authoritative refusal, or at its last confirmed deadline when the network remains unavailable. Renewal requests have an eight-second timeout. Visibility/pageshow checks reject expired ownership after tab suspension, and late renewal results cannot revive a disposed lease.

Expiry alone no longer transfers device ownership: the database cannot infer that an old provider connection ended. Normal departure releases the token. After an unclean crash with no release, ownership remains reserved until explicit release, existing host demotion, or event end. This favors avoiding duplicate active devices over automatically admitting a replacement from another device.

## Playback ownership

Each participant has one stable remote stream containing both audio and video tracks. The camera strip keeps one audio player mounted for every remote participant, including collapsed camera tiles. Camera tiles, shared-screen views, and fullscreen copies are muted to avoid duplicate sound. Autoplay refusal presents an explicit audio-enable action.

The mesh remains limited to the existing six-person call policy. Managed stages retain their existing Jitsi transport and separate audience broadcast; this change does not automatically publish stage media to YouTube.

## Verification

Run deterministic lifecycle, signaling, generation, recovery, and provider tests:

```sh
node tests/cinema-media.test.mjs
node tests/cinema-socket.test.mjs
```

Run the real browser integration test, which requires Google Chrome, permission to listen on localhost, and Node 22:

```sh
node scripts/cinema-media-browser.mjs
```

Set `CHROME_BIN` to override the Chrome executable. The script creates two isolated tabs with synthetic camera and microphone inputs, relays signaling between them, and checks received RTP packets for both audio and video. It exercises simultaneous offers, microphone mute/resume, peer replacement, exact remote track counts, and captured-track release. Its temporary server, Chrome profile, and browser process are removed afterward.

The browser test verifies local WebRTC, not production TURN connectivity or a live managed-stage account. Managed-provider command acknowledgement is covered with a provider double; a production check should also cover participants on different networks and the configured Jitsi deployment.

Provider API references: [Jitsi functions](https://jitsi.github.io/handbook/docs/dev-guide/dev-guide-iframe-functions/), [commands](https://jitsi.github.io/handbook/docs/dev-guide/dev-guide-iframe-commands/), and [events](https://jitsi.github.io/handbook/docs/dev-guide/dev-guide-iframe-events/).
