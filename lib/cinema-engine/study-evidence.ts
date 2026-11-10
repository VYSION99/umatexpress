import { rowsToObjects, turso } from "@/lib/turso";
import type { CinemaVideoReference } from "./video-reference";

export type StudySourceRef = { kind: "TRANSCRIPT" | "BOOKMARK"; id: string };
export type StudySource = StudySourceRef & {
  key: string; text: string; speaker: string; at: number;
  video?: CinemaVideoReference; expiresAt: string; digest: string;
};

/** Dependencies contain hashes, never another retained copy of a transcript. */
export async function readStudySources(sessionId: string, references: StudySourceRef[]): Promise<StudySource[]> {
  if (references.length > 550) throw new Error("Too many study sources.");
  const refs = JSON.stringify(references);
  const result = await turso(`SELECT 'TRANSCRIPT' AS kind,t.id,t.text,COALESCE(NULLIF(t.speaker_name,''),'Speaker') AS speaker,t.at_seconds,t.expires_at,v.source_type,v.video_id
    FROM cinema_transcript_segments t LEFT JOIN cinema_transcript_video_context v ON v.segment_id=t.id AND v.session_id=t.session_id
    WHERE t.session_id=? AND t.id IN (SELECT json_extract(value,'$.id') FROM json_each(?) WHERE json_extract(value,'$.kind')='TRANSCRIPT') AND (t.expires_at='' OR t.expires_at>?)
    UNION ALL SELECT 'BOOKMARK',b.id,b.label,'',b.at_seconds,'',v.source_type,v.video_id
    FROM cinema_bookmarks b LEFT JOIN cinema_bookmark_video_context v ON v.bookmark_id=b.id AND v.session_id=b.session_id
    WHERE b.session_id=? AND b.id IN (SELECT json_extract(value,'$.id') FROM json_each(?) WHERE json_extract(value,'$.kind')='BOOKMARK')`,
  [sessionId, refs, new Date().toISOString(), sessionId, refs]);
  return Promise.all(rowsToObjects(result).map(async row => {
    const source = {
      kind: String(row.kind) as StudySourceRef["kind"], id: String(row.id), key: `${row.kind}:${row.id}`,
      text: String(row.text), speaker: String(row.speaker), at: Number(row.at_seconds), expiresAt: String(row.expires_at),
      video: row.video_id && ["YOUTUBE", "UPLOAD"].includes(String(row.source_type)) ? { sourceType: row.source_type as CinemaVideoReference["sourceType"], videoId: String(row.video_id) } : undefined,
    };
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(source)));
    return { ...source, digest: Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("") };
  }));
}

/** Used in the final database statement, closing races after the source read. */
export const studySourcesUnchanged = `NOT EXISTS(SELECT 1 FROM json_each(?) e WHERE
        (json_extract(e.value,'$.kind')='TRANSCRIPT' AND (p.transcript_enabled<>1 OR NOT EXISTS(
          SELECT 1 FROM cinema_transcript_segments t WHERE t.id=json_extract(e.value,'$.id') AND t.session_id=s.id
          AND t.text=json_extract(e.value,'$.text') AND t.at_seconds=json_extract(e.value,'$.at')
          AND COALESCE(NULLIF(t.speaker_name,''),'Speaker')=json_extract(e.value,'$.speaker') AND t.expires_at=json_extract(e.value,'$.expiresAt') AND (t.expires_at='' OR t.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
          AND COALESCE((SELECT source_type || ':' || video_id FROM cinema_transcript_video_context v WHERE v.segment_id=t.id AND v.session_id=s.id),'')=COALESCE(json_extract(e.value,'$.video.sourceType') || ':' || json_extract(e.value,'$.video.videoId'),''))))
        OR (json_extract(e.value,'$.kind')='BOOKMARK' AND NOT EXISTS(
          SELECT 1 FROM cinema_bookmarks b WHERE b.id=json_extract(e.value,'$.id') AND b.session_id=s.id
          AND b.label=json_extract(e.value,'$.text') AND b.at_seconds=json_extract(e.value,'$.at')
          AND COALESCE((SELECT source_type || ':' || video_id FROM cinema_bookmark_video_context v WHERE v.bookmark_id=b.id AND v.session_id=s.id),'')=COALESCE(json_extract(e.value,'$.video.sourceType') || ':' || json_extract(e.value,'$.video.videoId'),''))))`;
