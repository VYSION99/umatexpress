import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Exercise the real hook with deterministic browser and React lifecycle doubles.
// No device permission, network service, or Vite bootstrap is involved.

function harness(options = {}) {
  let index = 0, dirty = false, result, signalHandler, resolvePolicy;
  const slots = [], effects = [], connections = [], sent = [], captures = [], timers = new Map();
  let now = 0, timerId = 0;
  const timeout = (fn, delay) => { const id = ++timerId; timers.set(id, { fn, at: now + delay }); return id; };
  const changed = (old, next) => !old || !next || old.length !== next.length || next.some((v, i) => !Object.is(v, old[i]));
  const react = {
    useState(initial) {
      const i = index++;
      slots[i] ??= { value: typeof initial === "function" ? initial() : initial };
      return [slots[i].value, (next) => { const value = typeof next === "function" ? next(slots[i].value) : next; if (!Object.is(value, slots[i].value)) { slots[i].value = value; dirty = true; } }];
    },
    useRef(initial) { const i = index++; slots[i] ??= { current: initial }; return slots[i]; },
    useCallback(fn, deps) { const i = index++; if (!slots[i] || changed(slots[i].deps, deps)) slots[i] = { value: fn, deps }; return slots[i].value; },
    useEffect(fn, deps) {
      const i = index++;
      if (!slots[i] || changed(slots[i].deps, deps)) {
        const previous = slots[i];
        slots[i] = { deps, cleanup: previous?.cleanup };
        effects.push(() => { previous?.cleanup?.(); slots[i].cleanup = fn(); });
      }
    },
  };
  class Stream {
    constructor(tracks = []) { this.tracks = [...tracks]; }
    getTracks() { return [...this.tracks]; }
    getAudioTracks() { return this.tracks.filter(t => t.kind === "audio"); }
    getVideoTracks() { return this.tracks.filter(t => t.kind === "video"); }
    addTrack(track) { if (!this.tracks.includes(track)) this.tracks.push(track); }
    removeTrack(track) { this.tracks = this.tracks.filter(t => t !== track); }
  }
  const track = (kind) => ({ kind, id: `${kind}-${Math.random()}`, readyState: "live", stop() { this.readyState = "ended"; } });
  class Peer {
    constructor(config) { this.config = config; this.transceivers = []; this.signalingState = "stable"; connections.push(this); }
    addTransceiver(kind) { const sender = { track: null, async replaceTrack(t) { this.track = t; } }; this.transceivers.push({ receiver: { track: track(kind) }, sender }); }
    getTransceivers() { return this.transceivers; }
    async createOffer(options) { this.lastOfferOptions = options; return { type: "offer", sdp: "offer" }; }
    async createAnswer() { return { type: "answer", sdp: "answer" }; }
    async setLocalDescription(d) { this.localDescription = d; this.signalingState = d.type === "offer" ? "have-local-offer" : "stable"; }
    async setRemoteDescription(d) {
      this.remoteDescription = d; this.signalingState = d.type === "offer" ? "have-remote-offer" : "stable";
      if (options.newNegotiatedSlots && d.type === "offer") {
        this.addTransceiver("audio"); this.addTransceiver("video");
        for (const transceiver of this.transceivers.slice(-2)) transceiver.direction = "recvonly";
      }
    }
    async addIceCandidate(candidate) { (this.candidates ??= []).push(candidate); }
    close() { this.connectionState = "closed"; }
  }
  class AudioContext {
    async close() {}
    createMediaStreamSource() { return { connect() {} }; }
    createAnalyser() { return { disconnect() {}, getFloatTimeDomainData(samples) { samples.fill(0); } }; }
  }
  const policyPromise = new Promise(resolve => { resolvePolicy = resolve; });
  const root = fileURLToPath(new URL("..", import.meta.url));
  const cache = new Map();
  const globals = {
    MediaStream: Stream, RTCPeerConnection: Peer, AudioContext, DOMException, AbortController, crypto, console,
    setTimeout: timeout, clearTimeout: id => timers.delete(id),
    fetch: () => policyPromise,
    navigator: { mediaDevices: {
      getUserMedia: async constraints => {
        const kind = constraints.audio ? "audio" : "video";
        const stream = options.capture ? await options.capture(kind, Stream, track) : new Stream([track(kind)]);
        captures.push(stream); return stream;
      },
      getDisplayMedia: async () => {
        const stream = options.capture ? await options.capture("screen", Stream, track) : new Stream([track("video")]);
        captures.push(stream); return stream;
      },
    } },
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
  };
  function load(path) {
    if (cache.has(path)) return cache.get(path);
    const exports = {};
    cache.set(path, exports);
    const code = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    vm.runInNewContext(code, { ...globals, exports, require(name) {
      if (name === "react") return react;
      const target = name.startsWith("@/") ? resolve(root, name.slice(2)) : resolve(dirname(path), name);
      return load(`${target}.ts`);
    } }, { filename: path });
    return exports;
  }
  const exports = load(resolve(root, "components/cinema/useCinemaMedia.ts"));
  const input = { roomId: "room", enabled: true, selfId: "self", members: [{ studentId: "self" }, { studentId: "peer" }], send: message => sent.push(message), subscribeSignals: fn => { signalHandler = fn; return () => { signalHandler = null; }; } };
  function render() {
    do {
      dirty = false; index = 0;
      result = exports.useCinemaMedia(input);
      for (const effect of effects.splice(0)) effect();
    } while (dirty);
  }
  async function settle() { for (let i = 0; i < 150; i++) { await Promise.resolve(); if (dirty) render(); } }
  render();
  return {
    connections, sent, track, captures, load, root, now: () => now, get result() { return result; },
    signal: payload => signalHandler?.("peer", payload),
    async advance(ms) {
      const end = now + ms;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].fn(); await settle();
      }
      now = end; await settle();
    },
    async members(ids) { input.members = ids.map(studentId => ({ studentId })); render(); await settle(); },
    async mute() { await result.muteSelf(); await settle(); },
    async screen() { await result.toggleScreen(); await settle(); },
    async policy() { resolvePolicy({ ok: true, json: async () => ({ voice: true, camera: true, iceServers: [{ urls: "turn:relay.example.test", username: "test", credential: "test" }], turn: true }) }); await settle(); },
    async toggle(kind) { await result[kind === "audio" ? "toggleMic" : "toggleCamera"](); await settle(); },
    async disconnect() { input.enabled = false; render(); await settle(); },
    settle,
  };
}

test("incoming offers wait for ICE policy and negotiate both media kinds", async () => {
  const h = harness();
  h.signal({ kind: "offer", sdp: "remote-offer" });
  assert.equal(h.connections.length, 0, "must not construct a peer with empty relay settings");
  await h.policy();
  assert.equal(h.connections.length, 1);
  const pc = h.connections[0];
  assert.equal(pc.config.iceServers[0].urls, "turn:relay.example.test");
  assert.deepEqual(pc.getTransceivers().map(t => t.receiver.track.kind), ["audio", "video"]);
  assert.ok(h.sent.some(m => m.payload?.kind === "answer"));
});

test("streamless audio and camera events preserve both tracks in one remote stream", async () => {
  const h = harness(); await h.policy();
  h.signal({ kind: "offer", sdp: "remote-offer" }); await h.settle();
  const pc = h.connections[0], audio = h.track("audio"), video = h.track("video");
  pc.ontrack({ streams: [], track: audio }); await h.settle();
  const original = h.result.remote[0].stream;
  pc.ontrack({ streams: [], track: video }); await h.settle();
  assert.equal(h.result.remote[0].stream, original);
  assert.deepEqual(original.getTracks(), [audio, video]);
  pc.ontrack({ streams: [], track: audio }); await h.settle();
  assert.equal(original.getTracks().length, 2, "duplicate events do not duplicate tracks");
});

test("mic and camera publish independently and disconnect releases captured devices", async () => {
  const h = harness(); await h.policy();
  await h.toggle("audio"); await h.toggle("video");
  const pc = h.connections[0];
  assert.deepEqual(pc.getTransceivers().map(t => t.sender.track?.kind), ["audio", "video"]);
  const tracks = h.result.localStream.getTracks();
  await h.toggle("audio");
  assert.equal(pc.getTransceivers()[0].sender.track, null);
  assert.equal(pc.getTransceivers()[1].sender.track.kind, "video");
  await h.disconnect();
  assert.ok(tracks.every(t => t.readyState === "ended"));
  assert.equal(pc.connectionState, "closed");
  assert.equal(h.result.remote.length, 0);
});

test("every remote peer has one audio player even when its camera tile is collapsed", () => {
  const Video = () => null;
  const exports = {};
  const jsx = (type, props) => ({ type, props });
  const stripCode = ts.transpileModule(readFileSync(new URL("../components/cinema/CinemaMediaStrip.tsx", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  vm.runInNewContext(stripCode, { exports, require(name) {
    if (name === "react") return { useState: initial => [initial, () => {}], useEffect() {} };
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
    if (name === "./CinemaMediaVideo") return { MediaStreamVideo: Video };
    return {};
  } });
  const members = Array.from({ length: 7 }, (_, i) => ({ studentId: `peer-${i}`, camera: i % 2 === 0, mic: true }));
  const remote = members.map(m => ({ studentId: m.studentId, stream: { getVideoTracks: () => [] } }));
  const tree = exports.CinemaMediaStrip({ selfId: "self", members, media: { remote, levels: {}, cameraOn: false, micOn: false } });
  const players = [];
  function walk(node) {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== "object") return;
    if (node.type === Video) players.push(node.props);
    walk(node.props?.children);
  }
  walk(tree);
  assert.equal(players.filter(p => p.audioOnly).length, 7, "audio must survive camera overflow and muted placeholder tracks");
  assert.ok(players.filter(p => !p.audioOnly).every(p => p.muted), "camera tiles must not play duplicate sound");
});

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test("a pending camera permission does not block microphone mute", async () => {
  const permission = deferred();
  const h = harness({ capture: async (kind, Stream, track) => kind === "video" ? permission.promise : new Stream([track(kind)]) });
  await h.policy(); await h.toggle("audio");
  const camera = h.toggle("video"); await h.settle();
  assert.equal(h.result.devices.video, "requesting");
  await h.mute();
  assert.equal(h.result.micOn, false);
  assert.equal(h.result.localStream.getAudioTracks().length, 0);
  permission.resolve({ getTracks: () => [h.track("video")] }); await camera;
  assert.equal(h.result.cameraOn, true);
  await h.disconnect();
});

test("ending the session stops a camera or screen returned by a late permission prompt", async () => {
  for (const kind of ["video", "screen"]) {
    const permission = deferred();
    const h = harness({ capture: async () => permission.promise });
    await h.policy();
    const pending = kind === "screen" ? h.screen() : h.toggle("video");
    await h.settle(); await h.disconnect();
    const track = h.track("video"); permission.resolve({ getTracks: () => [track] });
    await pending;
    assert.equal(track.readyState, "ended");
    assert.equal(h.result.cameraOn, false);
    assert.equal(h.result.screenOn, false);
    assert.equal(h.connections.length, 0);
  }
});

test("a second microphone click cancels a pending capture without leaking its track", async () => {
  const permission = deferred();
  const h = harness({ capture: async () => permission.promise }); await h.policy();
  const on = h.toggle("audio"); await h.settle();
  const off = h.toggle("audio"); await h.settle();
  const track = h.track("audio"); permission.resolve({ getTracks: () => [track] });
  await Promise.all([on, off]); await h.settle();
  assert.equal(track.readyState, "ended");
  assert.equal(h.result.micOn, false);
  assert.equal(h.connections.length, 0);
});

test("a failed peer restarts ICE, rebuilds with bounded backoff and offers manual recovery", async () => {
  const h = harness(); await h.policy(); await h.toggle("audio");
  const first = h.connections[0];
  first.connectionState = "failed"; first.onconnectionstatechange();
  await h.advance(0);
  assert.equal(first.lastOfferOptions.iceRestart, true);
  assert.equal(h.result.connectionStatus, "reconnecting");
  await h.advance(8000);
  assert.equal(first.connectionState, "closed");
  assert.equal(h.connections.length, 2);
  await h.advance(16000);
  assert.equal(h.connections.length, 3);
  await h.advance(32000);
  assert.equal(h.connections.length, 3, "recovery must stop after its retry budget");
  assert.equal(h.result.connectionStatus, "failed");
  assert.match(h.result.error, /delivery failed/);
  h.result.reconnect(); await h.settle();
  assert.equal(h.connections.length, 4);
  assert.equal(h.result.error, "");
  await h.disconnect();
});

test("leaving or losing a peer cancels its scheduled recovery", async () => {
  const h = harness(); await h.policy(); await h.toggle("audio");
  const pc = h.connections[0]; pc.connectionState = "failed"; pc.onconnectionstatechange();
  await h.members(["self"]); await h.advance(120000);
  assert.equal(h.connections.length, 1);
  assert.equal(h.result.connections.peer, undefined);
  await h.disconnect();
});

test("a connected peer cancels the connection timeout", async () => {
  const h = harness(); await h.policy(); await h.toggle("audio");
  const pc = h.connections[0]; pc.connectionState = "connected"; pc.onconnectionstatechange(); await h.settle();
  assert.equal(h.result.connectionStatus, "connected");
  await h.advance(120000);
  assert.equal(h.connections.length, 1);
  assert.equal(pc.lastOfferOptions, undefined);
  await h.disconnect();
});

test("sender failures remain visible while device readiness remains separate", async () => {
  const h = harness(); await h.policy();
  h.signal({ kind: "offer", sdp: "offer", connectionId: "remote-1" }); await h.settle();
  h.connections[0].getTransceivers()[0].sender.replaceTrack = async () => { throw new Error("sender failed"); };
  await h.toggle("audio");
  assert.equal(h.result.devices.audio, "ready");
  assert.equal(h.result.micOn, true);
  assert.match(h.result.error, /sending its track failed/);
  await h.disconnect();
});

test("device termination updates presence and permits opening it again", async () => {
  const h = harness(); await h.policy(); await h.toggle("audio");
  const track = h.result.localStream.getAudioTracks()[0];
  track.readyState = "ended"; track.onended(); await h.settle();
  assert.equal(h.result.micOn, false);
  assert.equal(h.result.devices.audio, "off");
  assert.equal(h.sent.filter(m => m.type === "media_state").at(-1).mic, false);
  await h.toggle("audio");
  assert.equal(h.result.micOn, true);
  assert.equal(h.result.localStream.getAudioTracks().length, 1);
  await h.disconnect();
});

test("candidate messages arriving before an offer are applied only to the matching generation", async () => {
  const h = harness(); await h.policy();
  h.signal({ kind: "candidate", candidate: "old", connectionId: "old" });
  h.signal({ kind: "candidate", candidate: "new", connectionId: "new" });
  h.signal({ kind: "offer", sdp: "offer", connectionId: "new" }); await h.settle();
  assert.equal(h.connections[0].candidates.length, 1);
  assert.equal(h.connections[0].candidates[0].candidate, "new");
  const localId = h.sent.find(m => m.payload?.kind === "answer").payload.connectionId;
  h.signal({ kind: "candidate", candidate: "stale-answer", connectionId: "new", replyTo: "replaced-local-id" }); await h.settle();
  assert.equal(h.connections[0].candidates.length, 1);
  h.signal({ kind: "candidate", candidate: "valid", connectionId: "new", replyTo: localId }); await h.settle();
  assert.equal(h.connections[0].candidates.length, 2);
  await h.disconnect();
});

test("remote replacement discards old generations and preserves queued new candidates", async () => {
  const h = harness(); await h.policy();
  h.signal({ kind: "offer", sdp: "first", connectionId: "first" }); await h.settle();
  h.signal({ kind: "offer", sdp: "second", connectionId: "second" });
  h.signal({ kind: "candidate", candidate: "second-candidate", connectionId: "second" }); await h.settle();
  assert.equal(h.connections.length, 2);
  assert.equal(h.connections[1].candidates[0].candidate, "second-candidate");
  h.signal({ kind: "offer", sdp: "stale-first", connectionId: "first" }); await h.settle();
  assert.equal(h.connections.length, 2);
  await h.disconnect();
});

test("a simultaneous offer yields on the polite peer and produces an answer", async () => {
  const h = harness(); await h.policy(); await h.toggle("audio");
  assert.equal(h.connections[0].signalingState, "have-local-offer");
  h.signal({ kind: "offer", sdp: "collision", connectionId: "remote-1" }); await h.settle();
  assert.equal(h.connections[0].signalingState, "stable");
  assert.ok(h.sent.some(m => m.payload?.kind === "answer" && m.payload.replyTo === "remote-1"));
  await h.disconnect();
});

test("signal parser preserves validated generation IDs and supports older clients", () => {
  const h = harness();
  const { parseClientMessage } = h.load(resolve(h.root, "lib/cinema-engine/protocol.ts"));
  const parse = payload => parseClientMessage(JSON.stringify({ type: "signal", to: "peer", payload }));
  const tagged = parse({ kind: "offer", sdp: "offer", connectionId: "generation-1", replyTo: "generation-2" });
  assert.equal(tagged.payload.connectionId, "generation-1");
  assert.equal(tagged.payload.replyTo, "generation-2");
  assert.equal(parse({ kind: "offer", sdp: "offer" }).payload.connectionId, undefined);
  assert.equal(parse({ kind: "offer", sdp: "offer", connectionId: "x".repeat(81) }), null);
});

test("managed-stage mute is idempotent, waits for acknowledgement and releases the provider", async () => {
  const h = harness();
  const { CinemaJaasAdapter } = h.load(resolve(h.root, "lib/cinema-engine/jaas-media.ts"));
  const { CinemaMediaController } = h.load(resolve(h.root, "lib/cinema-engine/media-controller.ts"));
  const events = new Map(), commands = [], errors = [];
  let muted = false, disposed = false;
  const api = {
    addListener(event, fn) { const listeners = events.get(event) ?? new Set(); listeners.add(fn); events.set(event, listeners); },
    removeListener(event, fn) { events.get(event)?.delete(fn); },
    isAudioMuted: async () => muted, isVideoMuted: async () => true,
    executeCommand(command) { commands.push(command); }, dispose() { disposed = true; },
  };
  let controller;
  const adapter = new CinemaJaasAdapter(api, (kind, enabled) => controller.syncDevice(kind, enabled));
  controller = new CinemaMediaController(adapter, error => errors.push(error));
  let finished = false;
  const mute = controller.mute().then(() => { finished = true; }); await h.settle();
  assert.equal(finished, false);
  assert.deepEqual(commands, ["toggleAudio"]);
  muted = true; for (const listener of [...events.get("audioMuteStatusChanged")]) listener({ muted: true });
  await mute;
  await controller.mute();
  assert.deepEqual(commands, ["toggleAudio"], "repeated mute must never unmute a participant");
  controller.dispose();
  assert.equal(disposed, true);
  assert.ok(commands.includes("hangup"));
  assert.ok([...events.values()].every(listeners => listeners.size === 0));
  assert.equal(errors.length, 0);
});

test("answering attaches local tracks to slots created by remote negotiation", async () => {
  const h = harness({ newNegotiatedSlots: true }); await h.policy();
  await h.toggle("audio"); await h.toggle("video");
  h.signal({ kind: "offer", sdp: "glare-offer", connectionId: "remote" }); await h.settle();
  const negotiated = h.connections[0].getTransceivers().slice(-2);
  assert.deepEqual(negotiated.map(t => t.direction), ["sendrecv", "sendrecv"]);
  assert.deepEqual(negotiated.map(t => t.sender.track.kind), ["audio", "video"]);
  await h.disconnect();
});

test("a rejected operation does not poison its queue and session cancellation skips waiting work", async () => {
  const h = harness();
  const { MediaOperationQueue } = h.load(resolve(h.root, "lib/cinema-engine/media-controller.ts"));
  const queue = new MediaOperationQueue();
  await assert.rejects(queue.run("audio", async () => { throw new Error("failed"); }), /failed/);
  assert.equal(await queue.run("audio", async () => "recovered"), "recovered");
  const permission = deferred(), calls = [];
  const first = queue.run("video", async () => { calls.push("first"); await permission.promise; });
  await h.settle();
  const waiting = queue.run("video", async () => { calls.push("waiting"); });
  assert.equal(await queue.run("audio", async () => "independent"), "independent");
  queue.cancel(); permission.resolve(); await Promise.all([first, waiting]);
  assert.deepEqual(calls, ["first"]);
});

test("exhausted recovery survives unchanged presence and stale signaling until explicit reconnect", async () => {
  const h = harness(); await h.policy(); await h.toggle("audio");
  const pc = h.connections[0]; pc.connectionState = "failed"; pc.onconnectionstatechange();
  await h.advance(56000);
  assert.equal(h.result.connectionStatus, "failed");
  for (let i = 0; i < 4; i++) {
    await h.members(["self", "peer"]);
    h.signal({ kind: "offer", sdp: "stale", connectionId: `stale-${i}` }); await h.settle();
  }
  assert.equal(h.connections.length, 3);
  assert.equal(h.result.connectionStatus, "failed");
  h.result.reconnect(); await h.settle();
  assert.equal(h.connections.length, 4);
  await h.disconnect();
});

test("a departed participant can begin a new recovery budget when they rejoin", async () => {
  const h = harness(); await h.policy(); await h.toggle("audio");
  const pc = h.connections[0]; pc.connectionState = "failed"; pc.onconnectionstatechange();
  await h.advance(56000); await h.members(["self"]);
  assert.equal(h.result.connections.peer, undefined);
  await h.members(["self", "peer"]);
  assert.equal(h.connections.length, 4);
  await h.disconnect();
});

test("repeated rejected camera clicks preserve screen sharing and restore requested state", async () => {
  const h = harness(); await h.policy(); await h.screen();
  const presentation = h.result.localStream.getVideoTracks()[0];
  for (let i = 0; i < 3; i++) {
    await h.toggle("video");
    assert.ok(h.result.error);
    assert.equal(h.result.screenOn, true);
    assert.equal(h.result.cameraOn, false);
    assert.equal(presentation.readyState, "live");
  }
  h.result.stopScreen(); await h.settle();
  assert.equal(h.result.screenOn, false);
  await h.toggle("video");
  assert.equal(h.result.cameraOn, true);
  await h.disconnect();
});

function managed(h, query) {
  const { CinemaJaasAdapter } = h.load(resolve(h.root, "lib/cinema-engine/jaas-media.ts"));
  const { CinemaMediaController } = h.load(resolve(h.root, "lib/cinema-engine/media-controller.ts"));
  const events = new Map(), commands = [], errors = [];
  const api = {
    addListener(event, fn) { const set = events.get(event) ?? new Set(); set.add(fn); events.set(event, set); },
    removeListener(event, fn) { events.get(event)?.delete(fn); },
    isAudioMuted: query, isVideoMuted: async () => true,
    executeCommand(command) { commands.push(command); }, dispose() {},
  };
  let controller;
  const adapter = new CinemaJaasAdapter(api, (kind, enabled) => controller.syncDevice(kind, enabled));
  controller = new CinemaMediaController(adapter, error => errors.push(error));
  return { controller, adapter, events, commands, errors };
}

test("managed mute times out its status query and ignores late replies", async () => {
  const h = harness(), reply = deferred();
  let queries = 0;
  const m = managed(h, () => ++queries === 1 ? reply.promise : Promise.resolve(true));
  let completed = false;
  const first = m.controller.mute().then(() => { completed = true; });
  await h.settle(); await h.advance(8000); await first;
  assert.equal(completed, true);
  assert.equal(m.errors.length, 1);
  reply.resolve(false); await h.settle();
  assert.equal(m.commands.length, 0, "late status replies must not unmute or toggle the provider");
  await m.controller.mute();
  assert.equal(queries, 2, "a timed-out query must not poison the command queue");
  m.controller.dispose();
});

test("disposal settles a managed command whose status query never replies", async () => {
  const h = harness(), m = managed(h, () => new Promise(() => {}));
  let completed = false;
  const pending = m.controller.mute().then(() => { completed = true; }); await h.settle();
  m.controller.dispose(); await h.settle(); await pending;
  assert.equal(completed, true);
  assert.equal(m.errors.length, 0);
  assert.deepEqual(m.commands, ["hangup"]);
  await h.advance(30000);
  assert.equal(m.errors.length, 0);
});

test("managed acknowledgement shares the status query deadline", async () => {
  const h = harness(), reply = deferred(), m = managed(h, () => reply.promise);
  const command = m.controller.mute(); await h.settle(); await h.advance(6000);
  reply.resolve(false); await h.settle();
  assert.deepEqual(m.commands, ["toggleAudio"]);
  await h.advance(2000); await command;
  assert.equal(m.errors.length, 1);
  // Only the adapter's permanent observer remains, not the expired command listener.
  assert.equal(m.events.get("audioMuteStatusChanged").size, 1);
  m.controller.dispose();
});

test("stage ownership renews during long sessions and disposal stops renewal", async () => {
  const h = harness();
  const { CinemaStageLease } = h.load(resolve(h.root, "lib/cinema-engine/stage-lease.ts"));
  let renewals = 0; const lost = [];
  const lease = new CinemaStageLease({ activeUntil: new Date(300000).toISOString(), now: h.now,
    renew: async () => { renewals++; return { activeUntil: new Date(h.now() + 300000).toISOString() }; }, onLost: reason => lost.push(reason) });
  lease.start(); await h.advance(20 * 60000);
  assert.equal(renewals, 20); assert.equal(lost.length, 0);
  lease.dispose(); await h.advance(10 * 60000);
  assert.equal(renewals, 20);
});

test("a network outage cannot extend a stage lease or publish late renewal results", async () => {
  const h = harness();
  const { CinemaStageLease } = h.load(resolve(h.root, "lib/cinema-engine/stage-lease.ts"));
  const reply = deferred(), lost = []; let renewals = 0;
  const lease = new CinemaStageLease({ activeUntil: new Date(300000).toISOString(), now: h.now,
    renew: () => { renewals++; return reply.promise; }, onLost: reason => lost.push(reason) });
  lease.start(); await h.advance(300000);
  assert.equal(lost.length, 1);
  const count = renewals;
  reply.resolve({ activeUntil: new Date(900000).toISOString() }); await h.settle(); await h.advance(600000);
  assert.equal(lost.length, 1); assert.equal(renewals, count);
});

test("an authoritative ownership refusal stops the stage before the deadline", async () => {
  const h = harness();
  const { CinemaStageLease, StageLeaseLostError } = h.load(resolve(h.root, "lib/cinema-engine/stage-lease.ts"));
  const lost = [];
  const lease = new CinemaStageLease({ activeUntil: new Date(300000).toISOString(), now: h.now,
    renew: async () => { throw new StageLeaseLostError("Session was released."); }, onLost: reason => lost.push(reason) });
  lease.start(); await h.advance(60000);
  assert.deepEqual(lost, ["Session was released."]);
});

test("a known remote peer's explicit new session can recover without presence churn", async () => {
  const h = harness(); await h.policy(); await h.toggle("audio");
  const id = h.sent.find(m => m.payload?.kind === "offer").payload.connectionId;
  h.signal({ kind: "answer", sdp: "answer", connectionId: "previous-session", replyTo: id }); await h.settle();
  const pc = h.connections[0]; pc.connectionState = "failed"; pc.onconnectionstatechange();
  await h.advance(56000);
  assert.equal(h.result.connectionStatus, "failed");
  h.signal({ kind: "offer", sdp: "stale", connectionId: "previous-session" }); await h.settle();
  assert.equal(h.connections.length, 3);
  h.signal({ kind: "offer", sdp: "rejoined", connectionId: "genuinely-new-session" }); await h.settle();
  assert.equal(h.connections.length, 4);
  assert.ok(h.sent.some(m => m.payload?.kind === "answer" && m.payload.replyTo === "genuinely-new-session"));
  await h.disconnect();
});
