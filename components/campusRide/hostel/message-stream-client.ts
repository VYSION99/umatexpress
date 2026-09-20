/**
 * Subscribes a browser to one hostel thread.
 *
 * The server sends a bounded event stream and the browser reconnects on its
 * own, so there is nothing to restart here; each event only means "the thread
 * changed", and the page re-reads through the ordinary endpoint. A browser
 * without EventSource simply keeps the existing refresh cadence.
 */
export function subscribeToHostelThread(url: string, onChange: () => void) {
  if (typeof window === "undefined" || typeof EventSource === "undefined") return () => undefined;
  const source = new EventSource(url, { withCredentials: true });
  let stopped = false;
  source.onmessage = () => {
    if (!stopped) onChange();
  };
  // Errors and reconnects are the EventSource's own business: the interval
  // refresh on the page still covers a stream that cannot be established.
  source.onerror = () => undefined;
  return () => {
    stopped = true;
    source.close();
  };
}
