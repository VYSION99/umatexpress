declare global {
  interface Window {
    __umxGoogleMapsPromise?: Promise<typeof google>;
  }
}

export function loadGoogleMaps(apiKey: string) {
  if (window.google?.maps) return Promise.resolve(window.google);
  if (window.__umxGoogleMapsPromise) return window.__umxGoogleMapsPromise;
  window.__umxGoogleMapsPromise = new Promise((resolve, reject) => {
    const callbackName = `__umxGoogleMapsInit_${Date.now()}`;
    const script = document.createElement("script");
    const globalWindow = window as unknown as Window & Record<string, unknown>;
    globalWindow[callbackName] = () => {
      delete globalWindow[callbackName];
      if (window.google?.maps) resolve(window.google);
      else reject(new Error("Google Maps initialized without a maps API."));
    };
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&callback=${callbackName}&v=weekly&loading=async`;
    script.async = true;
    script.defer = true;
    script.onerror = () => reject(new Error("Google Maps could not load."));
    document.head.append(script);
  });
  return window.__umxGoogleMapsPromise;
}
