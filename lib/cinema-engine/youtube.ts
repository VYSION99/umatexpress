/**
 * Turning whatever a student pasted into a YouTube video id.
 *
 * The room stores the id, never the URL: an id cannot carry a redirect, a
 * tracking parameter or a second video, and it is the only thing the embed
 * needs. Everything here is pure, so the cases below are cheap to test and the
 * route only has to decide what to do with a refusal.
 */

/** YouTube ids are eleven characters of the URL-safe alphabet. */
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** The hosts that actually serve a watch page, so a lookalike domain is refused. */
const HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtube-nocookie.com", "www.youtube-nocookie.com"]);

export type YouTubeLookup = { ok: true; id: string } | { ok: false; reason: string };

/**
 * Reads a video id out of a bare id, a share link (`youtu.be/…`), a watch link
 * (`?v=…`), an embed link or a Shorts link. A playlist link with no video in it
 * is refused rather than guessed at, because a room has to play one thing.
 */
export function parseYouTubeId(input: unknown): YouTubeLookup {
  const value = String(input ?? "").trim();
  if (!value) return { ok: false, reason: "Paste a YouTube link." };
  if (VIDEO_ID.test(value)) return { ok: true, id: value };

  // A pasted link without a scheme is what a phone's share sheet usually gives,
  // so it is completed rather than refused.
  const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, reason: "That does not look like a YouTube link." };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, reason: "That does not look like a YouTube link." };

  const host = url.hostname.toLowerCase();
  if (host === "youtu.be") {
    const id = url.pathname.split("/").filter(Boolean)[0] || "";
    return VIDEO_ID.test(id) ? { ok: true, id } : { ok: false, reason: "That share link has no video id in it." };
  }
  if (!HOSTS.has(host)) return { ok: false, reason: "Only YouTube links can be attached to a room." };

  const query = url.searchParams.get("v") || "";
  if (VIDEO_ID.test(query)) return { ok: true, id: query };

  // /embed/{id}, /shorts/{id}, /live/{id} and /v/{id} all put the id first.
  const [, first, second] = url.pathname.split("/");
  if (["embed", "shorts", "live", "v"].includes(String(first || "")) && VIDEO_ID.test(String(second || ""))) {
    return { ok: true, id: String(second) };
  }
  return { ok: false, reason: "That link does not point at a single video." };
}
