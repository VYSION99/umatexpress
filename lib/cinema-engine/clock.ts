/** A monotonic clock calibrated from server timestamps; device wall-clock skew is irrelevant. */
export function createCinemaClock(monotonic: () => number = () => performance.now()) {
  let anchor: { server: number; local: number } | null = null;
  let bestRoundTrip = Infinity;
  return {
    ready: () => anchor !== null,
    sample(serverAt: number, sentAt?: number) {
      const received = monotonic();
      if (!Number.isFinite(serverAt) || serverAt <= 0) return;
      const roundTrip = sentAt === undefined ? Infinity : Math.max(0, received - sentAt);
      if (anchor && roundTrip > bestRoundTrip + 50) return;
      bestRoundTrip = roundTrip;
      anchor = { server: serverAt + (Number.isFinite(roundTrip) ? roundTrip / 2 : 0), local: received };
    },
    now() { return anchor ? anchor.server + Math.max(0, monotonic() - anchor.local) : Date.now(); },
  };
}
