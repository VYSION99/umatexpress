/** An authoritative refusal ends capture immediately; transport failures use the remaining lease. */
export class StageLeaseLostError extends Error {}

export class CinemaStageLease {
  private alive = false;
  private deadline = 0;
  private deadlineTimer?: ReturnType<typeof setTimeout>;
  private renewalTimer?: ReturnType<typeof setTimeout>;
  private request?: AbortController;
  private lastRenewed = 0;
  constructor(private options: {
    activeUntil: string;
    renew: (signal: AbortSignal) => Promise<{ activeUntil: string }>;
    onLost: (reason: string) => void;
    now?: () => number;
  }) {}
  private now() { return this.options.now?.() ?? Date.now(); }
  start() {
    if (this.alive) return;
    this.alive = true; this.lastRenewed = this.now();
    this.accept(this.options.activeUntil);
    this.schedule();
  }
  private accept(activeUntil: string) {
    const deadline = Date.parse(activeUntil);
    if (!Number.isFinite(deadline) || deadline <= this.now()) { this.lose(); return; }
    this.deadline = deadline;
    clearTimeout(this.deadlineTimer);
    this.deadlineTimer = setTimeout(() => this.lose(), deadline - this.now());
  }
  private schedule() {
    clearTimeout(this.renewalTimer);
    if (this.alive) this.renewalTimer = setTimeout(() => void this.renew(), 60_000);
  }
  /** Called on visibility/pageshow so a suspended tab cannot revive an expired lease. */
  check() {
    if (!this.alive) return;
    if (this.now() >= this.deadline) { this.lose(); return; }
    if (this.now() - this.lastRenewed >= 30_000) void this.renew();
  }
  private async renew() {
    if (!this.alive || this.request) return;
    if (this.now() >= this.deadline) { this.lose(); return; }
    const controller = new AbortController(); this.request = controller;
    const timeout = setTimeout(() => controller.abort(new Error("Stage renewal timed out.")), 8000);
    let abort: () => void = () => {};
    try {
      const aborted = new Promise<never>((_, reject) => {
        abort = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", abort, { once: true });
      });
      const lease = await Promise.race([this.options.renew(controller.signal), aborted]);
      if (this.alive && !controller.signal.aborted) {
        this.lastRenewed = this.now(); this.accept(lease.activeUntil);
      }
    } catch (error) {
      if (this.alive && error instanceof StageLeaseLostError) this.lose(error.message);
      // Network/provider failures may retry, but never extend the existing deadline.
    } finally {
      clearTimeout(timeout); controller.signal.removeEventListener("abort", abort);
      if (this.request === controller) this.request = undefined;
      this.schedule();
    }
  }
  private lose(reason = "Your stage session could not be renewed. Rejoin to continue.") {
    if (!this.alive) return;
    this.dispose(); this.options.onLost(reason);
  }
  dispose() {
    this.alive = false;
    clearTimeout(this.deadlineTimer); clearTimeout(this.renewalTimer);
    this.request?.abort(new Error("Stage session ended.")); this.request = undefined;
  }
}
