export type CinemaVideoReference = { sourceType: "YOUTUBE" | "UPLOAD"; videoId: string };

/** Unknown legacy context must never be inferred from today's selection. */
export function matchesCinemaVideo(reference: CinemaVideoReference | undefined, current: { sourceType: string; videoId: string } | undefined) {
  return Boolean(reference?.videoId && current?.videoId && reference.sourceType === current.sourceType && reference.videoId === current.videoId);
}
