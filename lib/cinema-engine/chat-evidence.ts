import type { CinemaAssistantCitation } from "./protocol";
import { readCinemaMessagesById } from "./messages";
import { rowsToObjects, turso } from "@/lib/turso";

export type CinemaAssistantSource = CinemaAssistantCitation & { text: string; digest: string };
export async function cinemaSourceDigest(source: Pick<CinemaAssistantSource, "id" | "kind" | "text" | "atSeconds" | "video">) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([source.kind, source.id, source.text, source.atSeconds, source.video])));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/** At most two reads, rather than a database request for each report dependency. */
export async function readCinemaAssistantSources(roomId: string, citations: Array<Pick<CinemaAssistantCitation, "kind" | "id" | "key">>): Promise<CinemaAssistantSource[]> {
  const messageIds = citations.filter(source => source.kind === "MESSAGE").map(source => source.id);
  const transcriptIds = [...new Set(citations.filter(source => source.kind === "TRANSCRIPT").map(source => source.id))];
  if (citations.length > 100) throw new Error("Too many assistant sources.");
  const messages = new Map((await readCinemaMessagesById(roomId, messageIds)).filter(message => !message.removed && !message.assistant).map(message => [message.id, message]));
  const transcripts = transcriptIds.length ? rowsToObjects(await turso(`SELECT t.id,t.text,t.at_seconds,v.source_type,v.video_id FROM cinema_transcript_segments t
    LEFT JOIN cinema_transcript_video_context v ON v.segment_id=t.id AND v.session_id=t.session_id
    WHERE t.session_id=? AND t.id IN (${transcriptIds.map(() => "?").join(",")}) AND (t.expires_at='' OR t.expires_at>?)`, [roomId, ...transcriptIds, new Date().toISOString()])) : [];
  const segments = new Map(transcripts.map(segment => [String(segment.id), segment]));
  const found: Omit<CinemaAssistantSource, "digest">[] = [];
  for (const citation of citations) {
    if (citation.kind === "MESSAGE") {
      const message = messages.get(citation.id);
      if (message) found.push({ ...citation, text: message.content, atSeconds: message.atSeconds, video: message.video, threadId: message.threadId });
    } else {
      const row = segments.get(citation.id); if (!row) continue;
      const video = row.video_id && ["YOUTUBE", "UPLOAD"].includes(String(row.source_type)) ? { sourceType: String(row.source_type) as "YOUTUBE" | "UPLOAD", videoId: String(row.video_id) } : undefined;
      found.push({ ...citation, text: String(row.text), atSeconds: Number(row.at_seconds || 0), video });
    }
  }
  return Promise.all(found.map(async source => ({ ...source, digest: await cinemaSourceDigest(source) })));
}
