import type { CinemaClientMessage, CinemaSignalPayload } from "./protocol";
import { MediaOperationQueue, type CinemaMediaAdapter, type CinemaConnectionStatus, type CinemaDeviceKind, type CinemaDeviceStatus } from "./media-controller";

export type MeshMediaPolicy = { voice: boolean; camera: boolean; iceServers: RTCIceServer[] };
export type MeshMediaSnapshot = {
  localStream: MediaStream | null;
  micOn: boolean; cameraOn: boolean; screenOn: boolean;
  devices: Record<CinemaDeviceKind, CinemaDeviceStatus>;
  connections: Record<string, CinemaConnectionStatus>;
  remote: Record<string, MediaStream>;
  error: string;
};
export const emptyMeshSnapshot = (): MeshMediaSnapshot => ({
  localStream: null, micOn: false, cameraOn: false, screenOn: false,
  devices: { audio: "off", video: "off" }, connections: {}, remote: {}, error: "",
});

type Peer = {
  pc: RTCPeerConnection; id: string; remoteId?: string; ignoreOffer: boolean;
  stream: MediaStream; timer?: ReturnType<typeof setTimeout>; attempts: number;
  attaching: Promise<void>;
};
type Candidate = { generation?: string; candidate: RTCIceCandidateInit };
const MAX_RECOVERY_ATTEMPTS = 3;

/** Session-scoped transport. React renders its snapshots; it never owns peers. */
export class CinemaMeshAdapter implements CinemaMediaAdapter {
  private snapshot = emptyMeshSnapshot();
  private peers = new Map<string, Peer>();
  private members = new Set<string>();
  private candidates = new Map<string, Candidate[]>();
  private retired = new Map<string, Set<string>>();
  private failedMembers = new Set<string>();
  private lastRemoteIds = new Map<string, string>();
  private signaling = new MediaOperationQueue();
  private publications = new MediaOperationQueue();
  private captures = { audio: 0, video: 0 };
  private alive = true;
  constructor(private options: {
    selfId: string; policy: MeshMediaPolicy;
    send: (message: CinemaClientMessage) => unknown;
    onChange: (state: MeshMediaSnapshot) => void;
    onDevice?: (kind: CinemaDeviceKind | "screen", enabled: boolean) => void;
  }) {}

  private emit(change: Partial<MeshMediaSnapshot> = {}) {
    this.snapshot = { ...this.snapshot, ...change };
    if (this.alive) this.options.onChange(this.snapshot);
  }
  private device(kind: CinemaDeviceKind, status: CinemaDeviceStatus) {
    this.emit({ devices: { ...this.snapshot.devices, [kind]: status } });
  }
  private status(id: string, status: CinemaConnectionStatus) {
    this.emit({ connections: { ...this.snapshot.connections, [id]: status } });
  }
  private announce() {
    if (this.alive) this.options.send({ type: "media_state", mic: this.snapshot.micOn, camera: this.snapshot.cameraOn, screen: this.snapshot.screenOn });
  }
  private current(id: string, peer: Peer) { return this.alive && this.members.has(id) && this.peers.get(id) === peer; }
  private signal(id: string, peer: Peer, payload: CinemaSignalPayload) {
    if (this.current(id, peer)) this.options.send({ type: "signal", to: id, payload: { ...payload, connectionId: peer.id, ...(peer.remoteId ? { replyTo: peer.remoteId } : {}) } });
  }
  setMembers(ids: string[]) {
    this.members = new Set(ids.filter(id => id !== this.options.selfId));
    for (const id of this.peers.keys()) if (!this.members.has(id)) this.closePeer(id);
    for (const id of this.candidates.keys()) if (!this.members.has(id)) this.candidates.delete(id);
    for (const id of this.lastRemoteIds.keys()) if (!this.members.has(id)) this.lastRemoteIds.delete(id);
    for (const id of this.retired.keys()) if (!this.members.has(id)) this.retired.delete(id);
    for (const id of this.failedMembers) if (!this.members.has(id)) { this.failedMembers.delete(id); this.lastRemoteIds.delete(id); this.closePeer(id); }
    if (this.snapshot.micOn || this.snapshot.cameraOn || this.snapshot.screenOn) this.connectMembers();
  }
  private connectMembers() {
    for (const id of this.members) if (!this.peers.has(id) && !this.failedMembers.has(id)) {
      this.ensurePeer(id);
      void this.offer(id);
    }
  }
  private attach(peer: Peer) {
    return Promise.all(peer.pc.getTransceivers().map(transceiver => {
      const kind = transceiver.receiver.track.kind;
      const track = this.snapshot.localStream?.getTracks().find(t => t.kind === kind && t.readyState === "live") ?? null;
      return transceiver.sender.replaceTrack(track);
    })).then(() => undefined);
  }
  private ensurePeer(id: string): Peer {
    const existing = this.peers.get(id);
    if (existing) return existing;
    const pc = new RTCPeerConnection({ iceServers: this.options.policy.iceServers, bundlePolicy: "max-bundle" });
    const peer: Peer = { pc, id: crypto.randomUUID(), ignoreOffer: false, stream: new MediaStream(), attempts: 0, attaching: Promise.resolve() };
    this.peers.set(id, peer);
    pc.addTransceiver("audio", { direction: "sendrecv" });
    if (this.options.policy.camera) pc.addTransceiver("video", { direction: "sendrecv" });
    peer.attaching = this.attach(peer).catch(() => { if (this.current(id, peer)) this.emit({ error: "A device could not be attached to the call. Try reconnecting media." }); });
    this.status(id, "connecting");
    pc.onicecandidate = event => {
      if (!event.candidate) return;
      this.signal(id, peer, { kind: "candidate", candidate: event.candidate.candidate,
        ...(event.candidate.sdpMid != null ? { sdpMid: event.candidate.sdpMid } : {}),
        ...(event.candidate.sdpMLineIndex != null ? { sdpMLineIndex: event.candidate.sdpMLineIndex } : {}),
      });
    };
    pc.ontrack = event => {
      if (!this.current(id, peer)) return;
      if (!peer.stream.getTracks().some(t => t.id === event.track.id)) peer.stream.addTrack(event.track);
      this.emit({ remote: { ...this.snapshot.remote, [id]: peer.stream } });
    };
    pc.onconnectionstatechange = () => {
      if (!this.current(id, peer)) return;
      if (pc.connectionState === "connected") {
        clearTimeout(peer.timer); peer.timer = undefined; peer.attempts = 0;
        this.status(id, "connected");
      } else if (pc.connectionState === "failed" || pc.connectionState === "disconnected") this.recover(id, peer, pc.connectionState === "failed" ? 0 : 3000);
    };
    this.watch(id, peer, 12_000);
    return peer;
  }
  private watch(id: string, peer: Peer, delay: number) {
    clearTimeout(peer.timer);
    peer.timer = setTimeout(() => { peer.timer = undefined; this.recover(id, peer, 0); }, delay);
  }
  private recover(id: string, peer: Peer, delay: number) {
    if (!this.current(id, peer) || peer.timer && this.snapshot.connections[id] === "reconnecting") return;
    clearTimeout(peer.timer);
    this.status(id, "reconnecting");
    peer.timer = setTimeout(() => {
      peer.timer = undefined;
      if (!this.current(id, peer)) return;
      if (peer.attempts >= MAX_RECOVERY_ATTEMPTS) {
        this.failedMembers.add(id);
        const previous = peer.remoteId ?? this.lastRemoteIds.get(id);
        if (previous) {
          this.lastRemoteIds.set(id, previous);
          const retired = this.retired.get(id) ?? new Set<string>(); retired.add(previous);
          if (retired.size > 8) retired.delete(retired.values().next().value!);
          this.retired.set(id, retired);
        }
        this.closePeer(id, true);
        this.status(id, "failed");
        this.emit({ error: "Camera or microphone delivery failed. Check your network, then reconnect media." });
        return;
      }
      const attempts = peer.attempts + 1;
      if (attempts === 1) {
        peer.attempts = attempts;
        void this.offer(id, true);
        this.watch(id, peer, 8000);
      } else {
        this.closePeer(id);
        const next = this.ensurePeer(id);
        next.attempts = attempts;
        this.status(id, "reconnecting");
        void this.offer(id);
        this.watch(id, next, 4000 * 2 ** (attempts - 1));
      }
    }, delay);
  }
  private offer(id: string, restart = false) {
    return this.signaling.run(id, async () => {
      const peer = this.peers.get(id);
      if (!peer || !this.current(id, peer)) return;
      const pc = peer.pc;
      await peer.attaching;
      if (!this.current(id, peer)) return;
      if (restart && pc.signalingState === "have-local-offer") await pc.setLocalDescription({ type: "rollback" });
      if (pc.signalingState !== "stable") return;
      const offer = await pc.createOffer(restart ? { iceRestart: true } : undefined);
      if (!this.current(id, peer)) return;
      await pc.setLocalDescription(offer);
      this.signal(id, peer, { kind: "offer", sdp: pc.localDescription?.sdp || offer.sdp || "" });
    }).catch(() => { const peer = this.peers.get(id); if (peer) this.recover(id, peer, 1000); });
  }
  receive(id: string, payload: CinemaSignalPayload) {
    if (!this.alive || !this.members.has(id) || payload.connectionId && this.retired.get(id)?.has(payload.connectionId)) return Promise.resolve();
    if (this.failedMembers.has(id)) {
      // A remote user's explicit reconnect starts a genuinely new generation.
      // Ordinary presence, retries from the old peer and untagged offers do not.
      const previous = this.lastRemoteIds.get(id);
      if (payload.kind !== "offer" || !previous || !payload.connectionId || payload.connectionId === previous || payload.replyTo) return Promise.resolve();
      this.failedMembers.delete(id); this.lastRemoteIds.delete(id);
    }
    // Capture the session peer before queuing: never apply work to a replacement.
    const expected = this.peers.get(id);
    return this.signaling.run(id, async () => {
      if (!this.alive || !this.members.has(id) || this.failedMembers.has(id) || payload.connectionId && this.retired.get(id)?.has(payload.connectionId)) return;
      let peer = this.peers.get(id);
      if (expected && peer !== expected && (!payload.connectionId || payload.connectionId !== peer?.remoteId)) return;
      if (payload.replyTo && payload.replyTo !== peer?.id) return;
      if (payload.kind === "candidate") {
        if (peer?.ignoreOffer) return;
        const candidate = { candidate: payload.candidate, sdpMid: payload.sdpMid, sdpMLineIndex: payload.sdpMLineIndex };
        if (!peer?.pc.remoteDescription || payload.connectionId && payload.connectionId !== peer.remoteId) {
          const pending = this.candidates.get(id) ?? [];
          if (pending.length < 64) pending.push({ generation: payload.connectionId, candidate });
          this.candidates.set(id, pending);
        } else { try { await peer.pc.addIceCandidate(candidate); } catch { /* ICE may reject an obsolete candidate after restart. */ } }
        return;
      }
      if (payload.kind === "answer" && (!peer || peer.pc.signalingState !== "have-local-offer")) return;
      if (payload.kind === "offer" && peer?.remoteId && payload.connectionId && peer.remoteId !== payload.connectionId) {
        const pending = this.candidates.get(id);
        this.closePeer(id, true);
        if (pending) this.candidates.set(id, pending.filter(entry => entry.generation === payload.connectionId));
        peer = undefined;
      }
      peer ??= this.ensurePeer(id);
      await peer.attaching;
      if (!this.current(id, peer)) return;
      const pc = peer.pc;
      if (payload.kind === "offer") {
        const collision = pc.signalingState !== "stable";
        peer.ignoreOffer = collision && this.options.selfId < id;
        if (peer.ignoreOffer) return;
        if (collision) await pc.setLocalDescription({ type: "rollback" });
      }
      peer.ignoreOffer = false;
      peer.remoteId = payload.connectionId;
      if (payload.connectionId) this.lastRemoteIds.set(id, payload.connectionId);
      await pc.setRemoteDescription({ type: payload.kind, sdp: payload.sdp });
      if (!this.current(id, peer)) return;
      if (payload.kind === "offer") {
        // Rollback may leave our old transceivers unassociated while the
        // incoming offer creates new recvonly ones. Attach to the negotiated
        // slots before answering, including when this side has no devices yet.
        for (const transceiver of pc.getTransceivers()) {
          const kind = transceiver.receiver.track.kind;
          if (kind === "audio" || kind === "video" && this.options.policy.camera) transceiver.direction = "sendrecv";
        }
        await this.attach(peer);
        if (!this.current(id, peer)) return;
      }
      const pending = this.candidates.get(id) ?? [];
      this.candidates.delete(id);
      for (const entry of pending) if (!entry.generation || entry.generation === peer.remoteId) {
        try { await pc.addIceCandidate(entry.candidate); } catch { /* one rejected candidate is not a failed call */ }
        if (!this.current(id, peer)) return;
      }
      if (payload.kind === "offer") {
        const answer = await pc.createAnswer();
        if (!this.current(id, peer)) return;
        await pc.setLocalDescription(answer);
        this.signal(id, peer, { kind: "answer", sdp: pc.localDescription?.sdp || answer.sdp || "" });
      }
    }).catch(() => { const peer = this.peers.get(id); if (peer) this.recover(id, peer, 1000); }).then(() => undefined);
  }
  private closePeer(id: string, retire = false) {
    const peer = this.peers.get(id);
    if (peer) {
      clearTimeout(peer.timer);
      peer.pc.ontrack = null; peer.pc.onicecandidate = null; peer.pc.onconnectionstatechange = null;
      peer.pc.close(); this.peers.delete(id);
      if (retire && peer.remoteId) {
        const retired = this.retired.get(id) ?? new Set<string>(); retired.add(peer.remoteId);
        if (retired.size > 8) retired.delete(retired.values().next().value!);
        this.retired.set(id, retired);
      }
    }
    this.candidates.delete(id);
    const remote = { ...this.snapshot.remote }; delete remote[id];
    const connections = { ...this.snapshot.connections }; delete connections[id];
    this.emit({ remote, connections });
  }
  reconnect() {
    if (!this.alive) return;
    this.signaling.cancel();
    this.failedMembers.clear(); this.lastRemoteIds.clear();
    for (const id of this.peers.keys()) this.closePeer(id);
    this.emit({ error: "" });
    for (const id of this.members) { this.ensurePeer(id); void this.offer(id); }
  }
  cancelCapture(kind: CinemaDeviceKind) { this.captures[kind]++; }
  private async publish(kind: CinemaDeviceKind, track: MediaStreamTrack | null) {
    // Sender mutations are serialized per peer/kind, independently of SDP work.
    const outcomes = await Promise.allSettled([...this.peers].map(([id, peer]) => this.publications.run(`${id}:${kind}`, async () => {
      if (!this.current(id, peer)) return;
      for (const t of peer.pc.getTransceivers()) if (t.receiver.track.kind === kind) await t.sender.replaceTrack(track);
    })));
    if (outcomes.some(outcome => outcome.status === "rejected")) this.emit({ error: "A device is ready, but sending its track failed. Reconnect media to retry." });
  }
  private async removeTracks(kind: CinemaDeviceKind) {
    const stream = this.snapshot.localStream;
    for (const track of stream?.getTracks().filter(t => t.kind === kind) ?? []) {
      track.onended = null; track.stop(); stream?.removeTrack(track);
    }
    if (kind === "audio") this.emit({ micOn: false });
    else this.emit({ cameraOn: false, screenOn: false });
    this.device(kind, "off");
    this.options.onDevice?.(kind, false);
    if (kind === "video") this.options.onDevice?.("screen", false);
    this.announce();
    await this.publish(kind, null);
  }
  async setDevice(kind: CinemaDeviceKind, enabled: boolean) {
    if (!this.alive) return;
    if (!enabled) { await this.removeTracks(kind); return; }
    if (kind === "video" && this.snapshot.screenOn) throw new Error("Stop presenting before turning your camera on.");
    if (!(kind === "audio" ? this.options.policy.voice : this.options.policy.camera)) throw new Error(`${kind === "audio" ? "Voice" : "Camera"} is switched off in this room.`);
    if (this.snapshot.localStream?.getTracks().some(t => t.kind === kind && t.readyState === "live")) return;
    await this.capture(kind, false);
  }
  async setScreen(enabled: boolean) {
    if (!enabled) { if (this.snapshot.screenOn) await this.removeTracks("video"); return; }
    if (!this.alive) return;
    if (!this.options.policy.camera) throw new Error("Presenting is switched off in this room.");
    // Call getDisplayMedia before the first await to retain browser activation.
    await this.capture("video", true);
  }
  private async capture(kind: CinemaDeviceKind, screen: boolean) {
    const version = this.captures[kind];
    this.device(kind, "requesting"); this.emit({ error: "" });
    let captured: MediaStream | undefined;
    try {
      captured = await (screen ? navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 24 } }, audio: false }) : navigator.mediaDevices.getUserMedia(kind === "audio"
        ? { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }
        : { video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24, max: 30 } } }));
      if (!this.alive || version !== this.captures[kind]) { captured.getTracks().forEach(t => t.stop()); return; }
      if (!captured.getTracks().some(t => t.kind === kind)) throw new Error("The device returned no usable track.");
      if (kind === "video") await this.removeTracks("video");
      if (!this.alive || version !== this.captures[kind]) { captured.getTracks().forEach(t => t.stop()); return; }
      const stream = this.snapshot.localStream ?? new MediaStream();
      for (const track of captured.getTracks()) {
        stream.addTrack(track);
        track.onended = () => { if (this.alive) { this.cancelCapture(kind); void this.removeTracks(kind); } };
      }
      this.emit({ localStream: stream, ...(kind === "audio" ? { micOn: true } : { cameraOn: !screen, screenOn: screen }) });
      this.device(kind, "ready");
      this.options.onDevice?.(kind, !screen);
      if (kind === "video") this.options.onDevice?.("screen", screen);
      this.announce(); this.connectMembers();
      await this.publish(kind, captured.getTracks().find(t => t.kind === kind)!);
    } catch (error) {
      captured?.getTracks().forEach(t => t.stop());
      if (!this.alive || version !== this.captures[kind]) return;
      const denied = error instanceof DOMException && error.name === "NotAllowedError";
      this.device(kind, denied ? "denied" : "failed");
      this.options.onDevice?.(screen ? "screen" : kind, false);
      throw new Error(denied ? `Allow the ${screen ? "screen share" : kind === "audio" ? "microphone" : "camera"} in your browser and try again.` : `The ${screen ? "presentation" : kind === "audio" ? "microphone" : "camera"} could not be opened.`);
    }
  }
  releaseDevices() {
    this.captures.audio++; this.captures.video++;
    // Stop capture synchronously, including when queued publication is still pending.
    for (const track of this.snapshot.localStream?.getTracks() ?? []) { track.onended = null; track.stop(); this.snapshot.localStream?.removeTrack(track); }
    this.emit({ micOn: false, cameraOn: false, screenOn: false, devices: { audio: "off", video: "off" } });
    this.announce();
    void this.publish("audio", null); void this.publish("video", null);
  }
  dispose() {
    this.alive = false;
    this.releaseDevices(); this.signaling.cancel(); this.publications.cancel();
    for (const id of this.peers.keys()) this.closePeer(id);
    this.candidates.clear(); this.retired.clear(); this.failedMembers.clear(); this.lastRemoteIds.clear();
  }
}
