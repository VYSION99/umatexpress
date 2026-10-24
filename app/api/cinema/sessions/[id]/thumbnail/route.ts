import { CampusEngineError } from "@/lib/campus-engine/errors";
import { fail, ok } from "@/lib/campus-engine/responses";
import { imagesBinding, privateBucket } from "@/lib/cloudflare-bindings";
import { cinemaUploadsForRoom } from "@/lib/cinema-engine/uploads";
import { readRoom } from "@/lib/cinema-engine/rooms";
import { callIntelligence } from "@/lib/intelligence-api";
import { requireCinemaAccount } from "@/lib/student-auth";
import { rateLimitResponse, rateLimitSubject } from "@/lib/rate-limit";

type Candidate = { image: string; brightness: number; contrast: number };
const thumbnailKey = (roomId: string, uploadId: string) => `cinema/${roomId}/video/${uploadId}/thumbnail.webp`;

async function permittedUpload(request: Request, roomId: string, uploadId: string, hostOnly: boolean) {
  const account = await requireCinemaAccount(request);
  const room = await readRoom({ id: roomId, studentId: account.id });
  if (!room.isMember || hostOnly && !room.isHost) throw new CampusEngineError("FORBIDDEN", "Join this room to see its files.", 403);
  const upload = (await cinemaUploadsForRoom(room.id)).find((item) => item.id === uploadId && item.status === "READY");
  if (!upload) throw new CampusEngineError("NOT_FOUND", "This file is unavailable.", 404);
  return { account, room, upload };
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const uploadId = new URL(request.url).searchParams.get("uploadId") || "";
    await permittedUpload(request, id, uploadId, false);
    const bucket = await privateBucket();
    const object = await bucket?.get(thumbnailKey(id, uploadId)) as { body?: ReadableStream } | null | undefined;
    if (!object?.body) throw new CampusEngineError("NOT_FOUND", "No thumbnail is available yet.", 404);
    return new Response(object.body, { headers: { "Content-Type": "image/webp", "Cache-Control": "private, max-age=60", "X-Content-Type-Options": "nosniff" } });
  } catch (error) { return fail(error, request); }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const actor = await requireCinemaAccount(request);
    const limited = await rateLimitSubject("cinema-thumbnail", actor.id, { limit: 20, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    if (Number(request.headers.get("content-length") || 0) > 650_000) throw new CampusEngineError("VALIDATION_ERROR", "Thumbnail data is too large.", 413);
    const reader = request.body?.getReader();
    if (!reader) throw new CampusEngineError("VALIDATION_ERROR", "Thumbnail data is missing.", 400);
    const chunks: Uint8Array[] = [];
    let bytesRead = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > 650_000) {
        await reader.cancel();
        throw new CampusEngineError("VALIDATION_ERROR", "Thumbnail data is too large.", 413);
      }
      chunks.push(value);
    }
    const payload = new Uint8Array(bytesRead);
    let offset = 0;
    for (const chunk of chunks) { payload.set(chunk, offset); offset += chunk.byteLength; }
    let body: { uploadId?: unknown; candidates?: unknown };
    try { body = JSON.parse(new TextDecoder().decode(payload)); }
    catch { throw new CampusEngineError("VALIDATION_ERROR", "Thumbnail data is invalid.", 400); }
    const uploadId = String(body.uploadId || "");
    await permittedUpload(request, id, uploadId, true);
    const candidates = body.candidates;
    if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > 4 || candidates.some((candidate: Candidate) =>
      typeof candidate?.image !== "string" || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(candidate.image)
      || candidate.image.length > 180_000 || !Number.isFinite(candidate.brightness) || candidate.brightness < 0 || candidate.brightness > 1
      || !Number.isFinite(candidate.contrast) || candidate.contrast < 0 || candidate.contrast > 1)) {
      throw new CampusEngineError("VALIDATION_ERROR", "Choose a valid video thumbnail.", 400);
    }
    let index = 0;
    try {
      const choice = await callIntelligence<{ index: number }>("/v1/cinema/thumbnail/select", {
        frames: candidates.map(({ brightness, contrast }: Candidate) => ({ brightness, contrast })),
      }, 3000);
      if (Number.isInteger(choice.index) && choice.index >= 0 && choice.index < candidates.length) index = choice.index;
    } catch { /* Local development works without the private Python binding. */ }
    const bytes = Uint8Array.from(atob(candidates[index].image.split(",")[1]), (character) => character.charCodeAt(0));
    if (bytes.length < 4 || bytes.length > 135_000 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
      throw new CampusEngineError("VALIDATION_ERROR", "The thumbnail image is invalid.", 400);
    }
    const images = await imagesBinding();
    const bucket = await privateBucket();
    if (!images || !bucket) throw new CampusEngineError("CONFIG_REQUIRED", "Thumbnail processing is unavailable.", 503);
    let processed: ArrayBuffer;
    try {
      const image = await images.input(new Blob([bytes], { type: "image/jpeg" }).stream())
        .transform({ width: 320, height: 180, fit: "cover" }).output({ format: "image/webp", quality: 80 });
      processed = await image.response().arrayBuffer();
    } catch { throw new CampusEngineError("VALIDATION_ERROR", "The thumbnail could not be processed.", 400); }
    if (!processed.byteLength || processed.byteLength > 200_000) throw new CampusEngineError("VALIDATION_ERROR", "The thumbnail is too large.", 400);
    // A completed upload may be removed while image conversion is running.
    await permittedUpload(request, id, uploadId, true);
    await bucket.put(thumbnailKey(id, uploadId), processed, { httpMetadata: { contentType: "image/webp" } });
    return ok({ saved: true }, { headers: { "Cache-Control": "no-store" } }, request);
  } catch (error) { return fail(error, request); }
}
