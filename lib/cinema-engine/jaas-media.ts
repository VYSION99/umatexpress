import type { CinemaMediaAdapter, CinemaDeviceKind } from "./media-controller";

export interface CinemaJitsiApi {
  addListener(event: string, listener: (data: unknown) => void): void;
  removeListener(event: string, listener: (data: unknown) => void): void;
  executeCommand(command: string, ...args: unknown[]): void;
  isAudioMuted(): Promise<boolean>;
  isVideoMuted(): Promise<boolean>;
  dispose(): void;
}
const COMMAND_TIMEOUT_MS = 8000;

/** Bounds the entire operation, including provider status queries and acknowledgement. */
export class CinemaJaasAdapter implements CinemaMediaAdapter {
  private alive = true;
  private pending = new Set<AbortController>();
  private listeners: Array<[string, (data: unknown) => void]> = [];
  private screen = false;
  constructor(private api: CinemaJitsiApi, private onDevice: (kind: CinemaDeviceKind | "screen", enabled: boolean) => void) {
    for (const [event, kind] of [["audioMuteStatusChanged", "audio"], ["videoMuteStatusChanged", "video"], ["screenSharingStatusChanged", "screen"]] as const) {
      const listener = (data: unknown) => {
        if (!this.alive) return;
        const state = data as { muted?: boolean; on?: boolean };
        const enabled = kind === "screen" ? state.on === true : state.muted === false;
        if (kind === "screen") this.screen = enabled;
        this.onDevice(kind, enabled);
      };
      this.api.addListener(event, listener); this.listeners.push([event, listener]);
    }
  }
  private async operation(work: (signal: AbortSignal) => Promise<void>) {
    if (!this.alive) return;
    const controller = new AbortController();
    this.pending.add(controller);
    const timer = setTimeout(() => controller.abort(new Error("The managed stage did not confirm the device change. Try again.")), COMMAND_TIMEOUT_MS);
    let abort: () => void = () => {};
    try {
      await Promise.race([
        Promise.resolve().then(() => { controller.signal.throwIfAborted(); return work(controller.signal); }),
        new Promise<never>((_, reject) => {
          abort = () => reject(controller.signal.reason);
          controller.signal.addEventListener("abort", abort, { once: true });
        }),
      ]);
    } catch (error) {
      if (this.alive) throw error;
    } finally {
      clearTimeout(timer); controller.signal.removeEventListener("abort", abort); this.pending.delete(controller);
    }
  }
  private command(event: string, matches: (state: { muted?: boolean; on?: boolean }) => boolean, command: string, signal: AbortSignal) {
    signal.throwIfAborted();
    return new Promise<void>((resolve, reject) => {
      const finish = (error?: unknown) => {
        this.api.removeListener(event, listener); signal.removeEventListener("abort", cancel);
        if (error) reject(error); else resolve();
      };
      const listener = (data: unknown) => { if (matches(data as { muted?: boolean; on?: boolean })) finish(); };
      const cancel = () => finish(signal.reason);
      signal.addEventListener("abort", cancel, { once: true }); this.api.addListener(event, listener);
      try { this.api.executeCommand(command); } catch (error) { finish(error); }
    });
  }
  async setDevice(kind: CinemaDeviceKind, enabled: boolean) {
    await this.operation(async signal => {
      const muted = await (kind === "audio" ? this.api.isAudioMuted() : this.api.isVideoMuted());
      // A late provider reply must not execute a command after timeout/disposal.
      signal.throwIfAborted();
      if (!this.alive) return;
      if (muted === !enabled) { this.onDevice(kind, enabled); return; }
      await this.command(kind === "audio" ? "audioMuteStatusChanged" : "videoMuteStatusChanged", state => state.muted === !enabled, kind === "audio" ? "toggleAudio" : "toggleVideo", signal);
    });
  }
  async setScreen(enabled: boolean) {
    await this.operation(async signal => {
      if (this.screen === enabled) { this.onDevice("screen", enabled); return; }
      await this.command("screenSharingStatusChanged", state => state.on === enabled, "toggleShareScreen", signal);
    });
  }
  cancelCapture() { /* The managed provider owns permission requests. Hangup cancels the session. */ }
  releaseDevices() { this.dispose(); }
  dispose() {
    if (!this.alive) return;
    this.alive = false;
    for (const controller of this.pending) controller.abort(new Error("The managed media session ended."));
    this.pending.clear();
    for (const [event, listener] of this.listeners) this.api.removeListener(event, listener);
    this.listeners = [];
    try { this.api.executeCommand("hangup"); } finally { this.api.dispose(); }
  }
}
