"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CinemaClientMessage, CinemaPresenceMember, CinemaSignalPayload } from "@/lib/cinema-engine/protocol";
import { CinemaMediaController } from "@/lib/cinema-engine/media-controller";
import { CinemaMeshAdapter, emptyMeshSnapshot } from "@/lib/cinema-engine/mesh-media";

export type CinemaMediaPolicy = {
  voice: boolean; camera: boolean; recordings: boolean; maxRecordingMinutes: number;
  iceServers: RTCIceServer[]; turn: boolean;
};
export type CinemaRemotePeer = { studentId: string; stream: MediaStream };
export type CinemaMedia = ReturnType<typeof useCinemaMedia>;
const EMPTY_POLICY: CinemaMediaPolicy = { voice: false, camera: false, recordings: false, maxRecordingMinutes: 120, iceServers: [], turn: false };
const SPEAKING_THRESHOLD = 0.032;
const LEVEL_STEPS = 5;

/** React renders media state. The session engine owns devices, queues and peers. */
export function useCinemaMedia(input: {
  roomId: string; enabled: boolean; selfId: string; members: CinemaPresenceMember[];
  send: (message: CinemaClientMessage) => unknown;
  subscribeSignals: (handler: (from: string, payload: CinemaSignalPayload) => void) => () => void;
  muteAllSignal?: number;
}) {
  const { roomId, enabled, selfId, members, send, subscribeSignals, muteAllSignal = 0 } = input;
  const [policy, setPolicy] = useState<CinemaMediaPolicy>(EMPTY_POLICY);
  const [policyLoaded, setPolicyLoaded] = useState(false);
  const [snapshot, setSnapshot] = useState(emptyMeshSnapshot);
  const [error, setError] = useState("");
  const [levels, setLevels] = useState<Record<string, number>>({});
  const [attempt, setAttempt] = useState(0);
  const controllerRef = useRef<CinemaMediaController | null>(null);
  const adapterRef = useRef<CinemaMeshAdapter | null>(null);
  const membersRef = useRef(members);
  const handledMuteAllRef = useRef(muteAllSignal);
  const analysersRef = useRef(new Map<string, AnalyserNode>());
  const audioContextRef = useRef<AudioContext | null>(null);
  const { localStream, micOn, cameraOn, screenOn, remote } = snapshot;

  useEffect(() => {
    membersRef.current = members;
    adapterRef.current?.setMembers(members.map(member => member.studentId));
  }, [members]);

  useEffect(() => {
    if (!enabled || !roomId || !selfId) return;
    let disposed = false;
    const abort = new AbortController();
    const analysers = analysersRef.current;
    const pending: Array<{ from: string; payload: CinemaSignalPayload }> = [];
    const unsubscribe = subscribeSignals((from, payload) => {
      if (adapterRef.current) void adapterRef.current.receive(from, payload);
      else if (pending.length < 256) pending.push({ from, payload });
    });
    void (async () => {
      try {
        const response = await fetch(`/api/cinema/sessions/${encodeURIComponent(roomId)}/rtc`, { credentials: "same-origin", cache: "no-store", signal: abort.signal });
        const data = await response.json() as Partial<CinemaMediaPolicy> & { error?: string };
        if (disposed) return;
        if (!response.ok) throw new Error(data.error || "The room's voice settings could not be read.");
        const nextPolicy: CinemaMediaPolicy = {
          voice: data.voice === true, camera: data.camera === true, recordings: data.recordings === true,
          maxRecordingMinutes: Math.max(1, Math.floor(Number(data.maxRecordingMinutes) || 120)),
          iceServers: Array.isArray(data.iceServers) ? data.iceServers : [], turn: data.turn === true,
        };
        const adapter = new CinemaMeshAdapter({
          selfId, policy: nextPolicy, send,
          onChange: state => { if (!disposed) setSnapshot(state); },
          onDevice: (kind, active) => controllerRef.current?.syncDevice(kind, active),
        });
        const controller = new CinemaMediaController(adapter, problem => {
          if (!disposed) setError(problem instanceof Error ? problem.message : "The media command failed.");
        });
        controllerRef.current = controller; adapterRef.current = adapter;
        adapter.setMembers(membersRef.current.map(member => member.studentId));
        setPolicy(nextPolicy); setPolicyLoaded(true); setError("");
        for (const signal of pending.splice(0)) void adapter.receive(signal.from, signal.payload);
      } catch (problem) {
        if (!disposed) setError(problem instanceof Error ? problem.message : "The room's voice settings could not be read.");
      }
    })();
    return () => {
      disposed = true; abort.abort(); unsubscribe(); pending.length = 0;
      controllerRef.current?.dispose(); controllerRef.current = null; adapterRef.current = null;
      setSnapshot(emptyMeshSnapshot()); setPolicyLoaded(false); setLevels({});
      analysers.clear();
      void audioContextRef.current?.close().catch(() => undefined); audioContextRef.current = null;
    };
  }, [enabled, roomId, selfId, send, subscribeSignals, attempt]);

  const toggleMic = useCallback(async () => { setError(""); await controllerRef.current?.toggleDevice("audio"); }, []);
  const toggleCamera = useCallback(async () => { setError(""); await controllerRef.current?.toggleDevice("video"); }, []);
  const toggleScreen = useCallback(async () => { setError(""); await controllerRef.current?.toggleScreen(); }, []);
  const stopScreen = useCallback(() => { void controllerRef.current?.setScreen(false); }, []);
  const muteSelf = useCallback(async () => { await controllerRef.current?.mute(); }, []);
  const releaseDevices = useCallback(() => { controllerRef.current?.releaseDevices(); }, []);
  const reconnect = useCallback(() => {
    setError("");
    if (adapterRef.current) adapterRef.current.reconnect();
    else setAttempt(value => value + 1);
  }, []);
  useEffect(() => {
    if (!enabled || !policyLoaded || muteAllSignal === handledMuteAllRef.current) return;
    handledMuteAllRef.current = muteAllSignal;
    void muteSelf();
  }, [enabled, policyLoaded, muteAllSignal, muteSelf]);

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
    const local = localStream;
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
  }, [enabled, micOn, remote, localStream]);

  const states = Object.values(snapshot.connections);
  const connectionStatus = !enabled ? "off" : !policyLoaded ? "loading" : states.includes("failed") ? "failed"
    : states.includes("reconnecting") ? "reconnecting" : states.includes("connecting") ? "connecting"
    : states.length ? "connected" : "ready";
  return {
    policy, policyLoaded, micOn, cameraOn, screenOn, localStream,
    localLevel: levels.self ?? 0, levels,
    devices: snapshot.devices, connections: snapshot.connections, connectionStatus,
    remote: Object.entries(remote).map(([studentId, stream]) => ({ studentId, stream })) as CinemaRemotePeer[],
    error: error || snapshot.error,
    toggleMic, toggleCamera, toggleScreen, stopScreen, muteSelf, releaseDevices, reconnect,
  };
}
