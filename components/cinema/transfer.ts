/** Multipart PUTs are idempotent: retry the same numbered part, never a create request. */
export async function putCinemaPart(url: string, body: Blob, signal?: AbortSignal): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(url, { method: "PUT", credentials: "same-origin", headers: { "content-type": "application/octet-stream" }, body, signal });
      if (attempt >= 2 || (response.status !== 429 && response.status < 500)) return response;
    } catch (error) {
      if (signal?.aborted || attempt >= 2) throw error;
    }
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason); return; }
      const abort = () => { clearTimeout(timer); reject(signal?.reason); };
      const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, 500 * 2 ** attempt);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
}
