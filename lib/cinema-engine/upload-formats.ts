/** Shared browser/server upload policy; accepting a container does not transcode it. */
export const CINEMA_VIDEO_FORMATS: Record<string, string> = {
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime",
  webm: "video/webm", mkv: "video/x-matroska", avi: "video/x-msvideo",
  mpg: "video/mpeg", mpeg: "video/mpeg", ogv: "video/ogg",
  "3gp": "video/3gpp", "3g2": "video/3gpp2", ts: "video/mp2t",
  mts: "video/mp2t", m2ts: "video/mp2t", wmv: "video/x-ms-wmv", flv: "video/x-flv",
};
export const CINEMA_UPLOAD_TYPES = [...new Set(Object.values(CINEMA_VIDEO_FORMATS))];
export const CINEMA_UPLOAD_ACCEPT = [
  ...Object.keys(CINEMA_VIDEO_FORMATS).map((extension) => `.${extension}`),
  ...CINEMA_UPLOAD_TYPES,
].join(",");
export const CINEMA_UPLOAD_FORMAT_LABEL = "MP4, M4V, MOV, WebM, MKV, AVI, MPEG, OGV, 3GP, 3G2, TS, MTS, M2TS, WMV or FLV";

export function cinemaUploadContentType(filename: unknown, reportedType: unknown): string | null {
  const type = String(reportedType || "").split(";")[0].trim().toLowerCase();
  const aliases: Record<string, string> = {
    "video/matroska": "video/x-matroska", "video/avi": "video/x-msvideo",
    "video/msvideo": "video/x-msvideo", "video/x-m4v": "video/mp4",
  };
  const normalized = aliases[type] || type;
  if (CINEMA_UPLOAD_TYPES.includes(normalized)) return normalized;
  // Some operating systems provide no MIME type for otherwise known video files.
  if (type && type !== "application/octet-stream") return null;
  const extension = String(filename || "").split(".").pop()?.toLowerCase() || "";
  return Object.hasOwn(CINEMA_VIDEO_FORMATS, extension) ? CINEMA_VIDEO_FORMATS[extension] : null;
}

export function cinemaUploadExtension(contentType: string): string {
  return Object.entries(CINEMA_VIDEO_FORMATS).find(([, type]) => type === contentType)?.[0] || "mp4";
}
