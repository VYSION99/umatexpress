"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CinemaClientMessage, CinemaPresenceMember, CinemaSignalPayload } from "@/lib/cinema-engine/protocol";

/**
 * The room's voice and video, as a peer-to-peer mesh.
 *
 * The server never touches the media. Each pair of members builds one
 * RTCPeerConnection, the SDP and ICE legs travel through the room's socket, and
 * the audio and video flow directly between browsers — or through the TURN
 * relay when two networks cannot meet. That is what keeps a study room from
 * turning into a recording server, and it is also why a room is capped in
 * practice: a mesh of five people is fine, twenty is not, and the docs say so.
 *
 * Negotiation follows the browser's own rules rather than inventing new ones.
 * Both peers may open a connection when they have something to send; when two
 * offers collide, the member with the larger id yields (rolls back) and the
 * smaller keeps its offer. Candidates that arrive before the description they
 * belong to are held, not dropped, because that race is ordinary on a slow link.
 *
 * A camera and a microphone are only requested when a person turns them on.
 * Nothing here opens a device on mount, and a switch that goes off stops the
 * track it started — a lit camera light is a promise the platform must keep.
 */

export type CinemaMediaPolicy = {
  voice: boolean;
  camera: boolean;
  recordings: boolean;
  maxRecordingMinutes: number;
  iceServers: RTCIceServer[];
  turn: boolean;
};

export type CinemaRemotePeer = { studentId: string; stream: MediaStream };

const EMPTY_POLICY: CinemaMediaPolicy = {
  voice: false,
  camera: false,
  recordings: false,
  maxRecordingMinutes: 120,
  iceServers: [],
  turn: false,
};

/** Above this RMS a speaker is shown as talking; below it the meter rests. */
const SPEAKING_THRESHOLD = 0.032;
/** The meter is shown in five steps, so a quiet room does not re-render per frame. */
const LEVEL_STEPS = 5;

export function useCinemaMedia(input: {
  roomId: string;
  enabled: boolean;
  selfId: string;
  members: CinemaPresenceMember[];
  send: (message: CinemaClientMessage) => void;
  subscribeSignals: (handler: (from: string, payload: CinemaSignalPayload) => void) => () => void;
}) {
  const { roomId, enabled, selfId, members, send, subscribeSignals } = input;
  const [policy, setPolicy] = useState<CinemaMediaPolicy>(EMPTY_POLICY);
  const [policyLoaded, setPolicyLoaded] = useState(false);
  const [micOn, setMicOn] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remote, setRemote] = useState<Record<string, MediaStream>>({});
  const [levels, setLevels] = useState<Record<string, number>>({});
  const [error, setError] = useState("");

  const peersRef = useRef(new Map<string, RTCPeerConnection>());
  const pendingCandidatesRef = useRef(new Map<string, RTCIceCandidateInit[]>());
  const negotiatingRef = useRef(new Set<string>());
  const localStreamRef = useRef<MediaStream | null>(null);
  const policyRef = useRef<CinemaMediaPolicy>(EMPTY_POLICY);
  const selfIdRef = useRef("");
  const membersRef = useRef<CinemaPresenceMember[]>([]);
  const analysersRef = useRef(new Map<string, AnalyserNode>());
  const audioContextRef = useRef<AudioContext | null>(null);

  useEffect(() => { policyRef.current = policy; }, [policy]);
  useEffect(() => { selfIdRef.current = selfId; }, [selfId]);
  useEffect(() => { membersRef.current = members; }, [members]);
  useEffect(() => { localStreamRef.current = localStream; }, [localStream]);
  useEffect(() => () => {
    // A room that unmounts must release every device it opened and every
    // connection it half-built; a leaked peer would keep a camera light on.
    for (const socket of [...peersRef.current.keys()]) {
      const pc = peersRef.current.get(socket);
      if (pc) { pc.onicecandidate = null; pc.ontrack = null; pc.close(); }
    }
    peersRef.current.clear();
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    const context = audioContextRef.current;
    if (context) void context.close().catch(() => undefined);
    audioContextRef.current = null;
  }, []);

  /** The room's switches and relay credentials; asked once per open room. */
  useEffect(() => {
    if (!enabled || !roomId) return;
    let disposed = false;
    void (async () => {
      try {
        const response = await fetch(`/api/cinema/sessions/${encodeURIComponent(roomId)}/rtc`, { credentials: "same-origin", cache: "no-store" });
        const data = await response.json() as Partial<CinemaMediaPolicy> & { error?: string };
        if (disposed) return;
        if (!response.ok) { setError(data.error || "The room's voice settings could not be read."); return; }
        setPolicy({
          voice: data.voice === true,
          camera: data.camera === true,
          recordings: data.recordings === true,
          maxRecordingMinutes: Math.max(1, Math.floor(Number(data.maxRecordingMinutes) || 120)),
          iceServers: Array.isArray(data.iceServers) ? data.iceServers : [],
          turn: data.turn === true,
        });
        setPolicyLoaded(true);
      } catch {
        if (!disposed) setError("The room's voice settings could not be read.");
      }
    })();
    return () => { disposed = true; };
  }, [enabled, roomId]);

  const sendFrame = useCallback((message: CinemaClientMessage) => { send(message); }, [send]);

  /** Attaches whatever local tracks exist to one connection's transceivers. */
  const attachLocalTracks = useCallback((pc: RTCPeerConnection) => {
    const stream = localStreamRef.current;
    for (const transceiver of pc.getTransceivers()) {
      const kind = transceiver.receiver.track?.kind;
      const track = kind ? stream?.getTracks().find((entry) => entry.kind === kind) ?? null : null;
      void transceiver.sender.replaceTrack(track).catch(() => undefined);
    }
  }, []);

  const negotiate = useCallback(async (peerId: string) => {
    const pc = peersRef.current.get(peerId);
    if (!pc || pc.signalingState !== "stable" || negotiatingRef.current.has(peerId)) return;
    negotiatingRef.current.add(peerId);
    try {
      const offer = await pc.createOffer();
      if (pc.signalingState !== "stable") return;
      await pc.setLocalDescription(offer);
      const sdp = pc.localDescription?.sdp ?? offer.sdp ?? "";
      if (sdp) sendFrame({ type: "signal", to: peerId, payload: { kind: "offer", sdp } });
    } catch {
      // A connection that cannot offer is reported by its own state below.
    } finally {
      negotiatingRef.current.delete(peerId);
    }
  }, [sendFrame]);

  const flushCandidates = useCallback(async (peerId: string, pc: RTCPeerConnection) => {
    const queued = pendingCandidatesRef.current.get(peerId) ?? [];
    pendingCandidatesRef.current.delete(peerId);
    for (const candidate of queued) {
      try { await pc.addIceCandidate(candidate); } catch { /* a candidate the browser rejects is one it does not need */ }
    }
  }, []);

  const closePeer = useCallback((peerId: string) => {
    const pc = peersRef.current.get(peerId);
    if (pc) {
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.onconnectionstatechange = null;
      pc.close();
      peersRef.current.delete(peerId);
    }
    pendingCandidatesRef.current.delete(peerId);
    analysersRef.current.delete(peerId);
    setRemote((current) => {
      if (!(peerId in current)) return current;
      const next = { ...current };
      delete next[peerId];
      return next;
    });
    setLevels((current) => {
      if (!(peerId in current)) return current;
      const next = { ...current };
      delete next[peerId];
      return next;
    });
  }, []);

  /** One connection to one peer, created the first time either side needs it. */
  const ensurePeer = useCallback((peerId: string) => {
    const existing = peersRef.current.get(peerId);
    if (existing) { attachLocalTracks(existing); return existing; }
    const active = policyRef.current;
    const pc = new RTCPeerConnection({
      ...(active.iceServers.length ? { iceServers: active.iceServers } : {}),
      bundlePolicy: "max-bundle",
    });
    peersRef.current.set(peerId, pc);
    // The transceivers exist before any track does. Toggling a track on later
    // is then a replace, not a renegotiation, which is what keeps a mic switch
    // from re-running the whole handshake.
    pc.addTransceiver("audio", { direction: "sendrecv" });
    if (active.camera) pc.addTransceiver("video", { direction: "sendrecv" });
    attachLocalTracks(pc);

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      sendFrame({
        type: "signal",
        to: peerId,
        payload: {
          kind: "candidate",
          candidate: event.candidate.candidate,
          ...(event.candidate.sdpMid ? { sdpMid: event.candidate.sdpMid } : {}),
          ...(event.candidate.sdpMLineIndex === null ? {} : { sdpMLineIndex: event.candidate.sdpMLineIndex }),
        },
      });
    };
    pc.ontrack = (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      setRemote((current) => (current[peerId] === stream ? current : { ...current, [peerId]: stream }));
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") closePeer(peerId);
    };
    return pc;
  }, [attachLocalTracks, closePeer, sendFrame]);

  /** One inbound signaling leg, routed by its `from` — never by its payload. */
  const handleSignal = useCallback(async (from: string, payload: CinemaSignalPayload) => {
    if (!from || from === selfIdRef.current) return;
    let pc = peersRef.current.get(from);
    if (payload.kind === "candidate") {
      if (!pc || !pc.remoteDescription) {
        const queue = pendingCandidatesRef.current.get(from) ?? [];
        queue.push({
          candidate: payload.candidate,
          ...(payload.sdpMid ? { sdpMid: payload.sdpMid } : {}),
          ...(payload.sdpMLineIndex === undefined ? {} : { sdpMLineIndex: payload.sdpMLineIndex }),
        });
        pendingCandidatesRef.current.set(from, queue);
        return;
      }
      try { await pc.addIceCandidate({ candidate: payload.candidate, sdpMid: payload.sdpMid, sdpMLineIndex: payload.sdpMLineIndex }); } catch { /* one candidate, not the call */ }
      return;
    }
    if (!pc) pc = ensurePeer(from);
    const polite = selfIdRef.current > from;
    if (payload.kind === "offer") {
      const collision = pc.signalingState !== "stable";
      if (collision && !polite) return;
      try {
        if (collision) await pc.setLocalDescription({ type: "rollback" } as RTCSessionDescriptionInit);
        await pc.setRemoteDescription({ type: "offer", sdp: payload.sdp });
        await flushCandidates(from, pc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        const sdp = pc.localDescription?.sdp ?? answer.sdp ?? "";
        if (sdp) sendFrame({ type: "signal", to: from, payload: { kind: "answer", sdp } });
      } catch {
        closePeer(from);
      }
      return;
    }
    if (payload.kind === "answer" && pc.signalingState === "have-local-offer") {
      try {
        await pc.setRemoteDescription({ type: "answer", sdp: payload.sdp });
        await flushCandidates(from, pc);
      } catch {
        closePeer(from);
      }
    }
  }, [closePeer, ensurePeer, flushCandidates, sendFrame]);

  useEffect(() => {
    if (!enabled) return;
    return subscribeSignals((from, payload) => { void handleSignal(from, payload); });
  }, [enabled, subscribeSignals, handleSignal]);

  /**
   * The room's shape changed. A peer who left loses their connection; a peer
   * who is here while this browser has something to send gets one opened.
   */
  useEffect(() => {
    if (!enabled) return;
    const present = new Set(members.map((member) => member.studentId));
    for (const peerId of [...peersRef.current.keys()]) if (!present.has(peerId)) closePeer(peerId);
    if ((!micOn && !cameraOn) || !selfId) return;
    for (const member of members) {
      if (member.studentId === selfId) continue;
      const pc = peersRef.current.get(member.studentId) ?? ensurePeer(member.studentId);
      if (!pc.localDescription && !negotiatingRef.current.has(member.studentId)) void negotiate(member.studentId);
    }
  }, [enabled, members, micOn, cameraOn, selfId, closePeer, ensurePeer, negotiate]);

  /** Pushes one local track to every connection, or null when it stops. */
  const publishTrack = useCallback((kind: "audio" | "video", track: MediaStreamTrack | null) => {
    for (const pc of peersRef.current.values()) {
      for (const transceiver of pc.getTransceivers()) {
        if (transceiver.receiver.track?.kind !== kind) continue;
        void transceiver.sender.replaceTrack(track).catch(() => undefined);
      }
    }
  }, []);

  const setTrack = useCallback(async (kind: "audio" | "video", on: boolean): Promise<boolean> => {
    setError("");
    const stream = localStreamRef.current ?? new MediaStream();
    if (localStreamRef.current === null) {
      localStreamRef.current = stream;
      setLocalStream(stream);
    }
    if (!on) {
      for (const track of stream.getTracks().filter((entry) => entry.kind === kind)) {
        publishTrack(kind, null);
        track.stop();
        stream.removeTrack(track);
      }
      return true;
    }
    const active = policyRef.current;
    if (kind === "audio" && !active.voice) { setError("Voice is switched off in this room."); return false; }
    if (kind === "video" && !active.camera) { setError("Camera is switched off in this room."); return false; }
    if (stream.getTracks().some((entry) => entry.kind === kind)) return true;
    try {
      const captured = await navigator.mediaDevices.getUserMedia(
        kind === "audio"
          ? { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }
          : { video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24, max: 30 } } },
      );
      for (const track of captured.getTracks()) {
        stream.addTrack(track);
        publishTrack(kind, track);
      }
      setLocalStream(stream);
      return true;
    } catch (captureError) {
      const name = captureError instanceof DOMException ? captureError.name : "";
      setError(name === "NotAllowedError"
        ? `The browser refused the ${kind === "audio" ? "microphone" : "camera"}. Allow it in the address bar and try again.`
        : `The ${kind === "audio" ? "microphone" : "camera"} could not be opened.`);
      return false;
    }
  }, [publishTrack]);

  const toggleMic = useCallback(async () => {
    const next = !micOn;
    const ok = await setTrack("audio", next);
    if (!ok) return;
    setMicOn(next);
    sendFrame({ type: "media_state", mic: next, camera: cameraOn });
  }, [cameraOn, micOn, sendFrame, setTrack]);

  const toggleCamera = useCallback(async () => {
    const next = !cameraOn;
    const ok = await setTrack("video", next);
    if (!ok) return;
    setCameraOn(next);
    sendFrame({ type: "media_state", mic: micOn, camera: next });
  }, [cameraOn, micOn, sendFrame, setTrack]);

  /**
   * The speaking meter. One analyser per audible stream, sampled on animation
   * frames and quantised to five steps, so a room of five re-renders only when
   * somebody actually starts or stops talking.
   */
  useEffect(() => {
    if (!enabled) return;
    const context = audioContextRef.current ?? new AudioContext();
    audioContextRef.current = context;
    const analysers = analysersRef.current;
    const wanted = new Map<string, MediaStream>();
    const local = localStreamRef.current;
    if (micOn && local) wanted.set("self", local);
    for (const [peerId, stream] of Object.entries(remote)) wanted.set(peerId, stream);
    for (const [key, analyser] of analysers) {
      if (wanted.has(key)) continue;
      analyser.disconnect();
      analysers.delete(key);
    }
    for (const [key, stream] of wanted) {
      if (analysers.has(key)) continue;
      try {
        const source = context.createMediaStreamSource(stream);
        const analyser = context.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        analysers.set(key, analyser);
      } catch { /* a stream without an audio track has nothing to measure */ }
    }
    if (!analysers.size) return;

    let frame = 0;
    let stopped = false;
    const samples = new Float32Array(512);
    const tick = () => {
      if (stopped) return;
      const next: Record<string, number> = {};
      for (const [key, analyser] of analysers) {
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) sum += sample * sample;
        const rms = Math.sqrt(sum / samples.length);
        next[key] = rms >= SPEAKING_THRESHOLD ? Math.min(LEVEL_STEPS - 1, 1 + Math.round((rms - SPEAKING_THRESHOLD) * 20)) : 0;
      }
      setLevels((current) => {
        const changed = Object.keys(next).length !== Object.keys(current).length
          || Object.keys(next).some((key) => current[key] !== next[key]);
        return changed ? next : current;
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => { stopped = true; cancelAnimationFrame(frame); };
  }, [enabled, micOn, remote]);

  return {
    policy,
    policyLoaded,
    micOn,
    cameraOn,
    localStream,
    localLevel: levels.self ?? 0,
    levels,
    remote: Object.entries(remote).map(([studentId, stream]) => ({ studentId, stream })) as CinemaRemotePeer[],
    error,
    toggleMic,
    toggleCamera,
  };
}
