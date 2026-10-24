"use client";

export type ThumbnailCandidate = { image: string; brightness: number; contrast: number };

function waitFor(video: HTMLVideoElement, event: string, timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => finish(new Error("Video frame timed out.")), timeoutMs);
    const finish = (error?: Error) => {
      window.clearTimeout(timeout);
      video.removeEventListener(event, onReady);
      video.removeEventListener("error", onError);
      if (error) reject(error);
      else resolve();
    };
    const onReady = () => finish();
    const onError = () => finish(new Error("This browser could not decode the video."));
    video.addEventListener(event, onReady, { once: true });
    video.addEventListener("error", onError, { once: true });
  });
}

/** The browser decodes local frames; the Python Worker ranks their visual metrics. */
export async function captureVideoThumbnails(file: File): Promise<ThumbnailCandidate[]> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  try {
    const metadata = waitFor(video, "loadedmetadata", 10_000);
    video.src = url;
    await metadata;
    if (!Number.isFinite(video.duration) || video.duration <= 0 || !video.videoWidth || !video.videoHeight) return [];
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return [];
    const candidates: ThumbnailCandidate[] = [];
    for (const fraction of [0.12, 0.4, 0.68]) {
      try {
        const seeked = waitFor(video, "seeked", 6_000);
        video.currentTime = Math.min(Math.max(0, video.duration - 0.05), video.duration * fraction);
        await seeked;
        context.fillStyle = "#101a16";
        context.fillRect(0, 0, canvas.width, canvas.height);
        const scale = Math.max(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
        const width = video.videoWidth * scale;
        const height = video.videoHeight * scale;
        context.drawImage(video, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let sum = 0;
        let squares = 0;
        let count = 0;
        for (let index = 0; index < pixels.length; index += 16) {
          const value = (pixels[index] * 0.2126 + pixels[index + 1] * 0.7152 + pixels[index + 2] * 0.0722) / 255;
          sum += value;
          squares += value * value;
          count += 1;
        }
        const brightness = sum / count;
        const contrast = Math.sqrt(Math.max(0, squares / count - brightness * brightness));
        candidates.push({ image: canvas.toDataURL("image/jpeg", 0.75), brightness, contrast });
      } catch { /* An unsupported seek can still leave other frames available. */ }
    }
    return candidates;
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}
