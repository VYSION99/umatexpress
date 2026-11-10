/** Independent queues: a pending camera permission never blocks microphone mute. */
export class MediaOperationQueue {
  private tails = new Map<string, Promise<unknown>>();
  private epoch = 0;

  run<T>(key: string, operation: () => Promise<T>): Promise<T | undefined> {
    const epoch = this.epoch;
    const task = (this.tails.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => {
      if (epoch !== this.epoch) return undefined;
      return operation();
    });
    const tail = task.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => { if (this.tails.get(key) === tail) this.tails.delete(key); });
    return task;
  }

  cancel() { this.epoch++; this.tails.clear(); }
}

export type CinemaDeviceKind = "audio" | "video";
export type CinemaDeviceStatus = "off" | "requesting" | "ready" | "denied" | "failed";
export type CinemaConnectionStatus = "connecting" | "connected" | "reconnecting" | "failed";

/** Both providers implement explicit, idempotent commands rather than UI toggles. */
export interface CinemaMediaAdapter {
  setDevice(kind: CinemaDeviceKind, enabled: boolean): Promise<void>;
  setScreen(enabled: boolean): Promise<void>;
  cancelCapture(kind: CinemaDeviceKind): void;
  releaseDevices(): void;
  dispose(): void;
}

export class CinemaMediaController {
  private queue = new MediaOperationQueue();
  private desired = { audio: false, video: false, screen: false };
  private confirmed = { audio: false, video: false, screen: false };
  private revisions = { audio: 0, video: 0, screen: 0 };
  private pending = { audio: 0, video: 0, screen: 0 };
  private disposed = false;
  constructor(private adapter: CinemaMediaAdapter, private onError: (error: unknown) => void) {}

  setDevice(kind: CinemaDeviceKind, enabled: boolean) {
    if (this.disposed) return Promise.resolve();
    this.desired[kind] = enabled;
    const revision = ++this.revisions[kind];
    this.pending[kind]++;
    if (!enabled) this.adapter.cancelCapture(kind);
    return this.queue.run(kind, async () => {
      // Superseded requests need not ask for permission at all.
      if (revision !== this.revisions[kind]) return;
      try { await this.adapter.setDevice(kind, enabled); }
      catch (error) {
        if (!this.disposed && revision === this.revisions[kind]) {
          this.desired[kind] = this.confirmed[kind];
          this.onError(error);
        }
      }
    }).finally(() => {
      this.pending[kind]--;
      if (revision === this.revisions[kind]) this.desired[kind] = this.confirmed[kind];
    }).then(() => undefined);
  }
  toggleDevice(kind: CinemaDeviceKind) { return this.setDevice(kind, !this.desired[kind]); }
  setScreen(enabled: boolean) {
    if (this.disposed) return Promise.resolve();
    this.desired.screen = enabled;
    const revision = ++this.revisions.screen;
    this.pending.screen++;
    if (!enabled) this.adapter.cancelCapture("video");
    return this.queue.run("video", async () => {
      if (revision !== this.revisions.screen) return;
      try { await this.adapter.setScreen(enabled); }
      catch (error) {
        if (!this.disposed && revision === this.revisions.screen) {
          this.desired.screen = this.confirmed.screen;
          this.onError(error);
        }
      }
    }).finally(() => {
      this.pending.screen--;
      if (revision === this.revisions.screen) this.desired.screen = this.confirmed.screen;
    }).then(() => undefined);
  }
  toggleScreen() { return this.setScreen(!this.desired.screen); }
  /** Device/provider events keep subsequent toggles aligned with actual capture. */
  syncDevice(kind: CinemaDeviceKind | "screen", enabled: boolean) {
    this.confirmed[kind] = enabled;
    if (!this.pending[kind]) this.desired[kind] = enabled;
  }
  mute() { return this.setDevice("audio", false); }
  releaseDevices() {
    this.queue.cancel();
    this.desired = { audio: false, video: false, screen: false };
    this.confirmed = { audio: false, video: false, screen: false };
    this.revisions.audio++; this.revisions.video++; this.revisions.screen++;
    this.adapter.releaseDevices();
  }
  dispose() { this.disposed = true; this.releaseDevices(); this.adapter.dispose(); }
}
