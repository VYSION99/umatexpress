/** Keep the same key across network retries; successful checkout starts a new intent next time. */
export async function checkoutFetch(url: string, init: RequestInit) {
  const body = String(init.body || '');
  const storageKey = `umx-checkout:${url}`;
  let entry: { body: string; key: string } | undefined;
  try { entry = JSON.parse(sessionStorage.getItem(storageKey) || 'null') || undefined; } catch { /* Storage may be unavailable. */ }
  if (!entry || entry.body!==body) entry = { body, key: crypto.randomUUID() };
  try { sessionStorage.setItem(storageKey,JSON.stringify(entry)); } catch { /* Server fallback is scoped to account and payload. */ }
  const headers = new Headers(init.headers);
  headers.set('Idempotency-Key',entry.key);
  const response = await fetch(url,{...init,headers});
  if (response.ok || (response.status>=400 && response.status<500 && response.status!==409 && response.status!==429)) {
    try { sessionStorage.removeItem(storageKey); } catch { /* Optional storage. */ }
  }
  return response;
}
