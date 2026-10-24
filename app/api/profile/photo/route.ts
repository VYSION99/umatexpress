import { readProfilePhoto, removeProfilePhoto, saveProfilePhoto, profileScope } from "@/lib/account-profile-photo";
import { fail } from "@/lib/campus-engine/responses";
import { CampusEngineError } from "@/lib/campus-engine/errors";
import { rateLimitSubject, rateLimitResponse } from "@/lib/rate-limit";

const NO_STORE = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const MAX_BYTES = 4 * 1024 * 1024;
function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) throw new CampusEngineError("FORBIDDEN", "Cross-origin profile update refused.", 403);
}

async function limitedBody(request: Request) {
  if (Number(request.headers.get("content-length") || 0) > MAX_BYTES) throw new CampusEngineError("VALIDATION_ERROR", "Choose a photo smaller than 4 MB.", 413);
  if (!request.body) throw new CampusEngineError("VALIDATION_ERROR", "Choose a photo to upload.", 400);
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new CampusEngineError("VALIDATION_ERROR", "Choose a photo smaller than 4 MB.", 413);
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return bytes.buffer;
}

export async function GET(request: Request) {
  try {
    const scope = profileScope(new URL(request.url).searchParams.get("scope"));
    const photo = await readProfilePhoto(request, scope);
    return new Response(photo.body, { headers: { ...NO_STORE, "Content-Type": photo.type, "Last-Modified": new Date(photo.updatedAt).toUTCString() } });
  } catch (error) { return fail(error, request); }
}

export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const scope = profileScope(new URL(request.url).searchParams.get("scope"));
    const limited = await rateLimitSubject("profile-photo-upload", `${scope}:${request.headers.get("cf-connecting-ip") || "local"}`, { limit: 12, windowMs: 60 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const type = String(request.headers.get("content-type") || "").split(";")[0].trim();
    const updatedAt = await saveProfilePhoto(request, scope, await limitedBody(request), type);
    return Response.json({ updatedAt }, { status: 201, headers: NO_STORE });
  } catch (error) { return fail(error, request); }
}

export async function DELETE(request: Request) {
  try {
    sameOrigin(request);
    const scope = profileScope(new URL(request.url).searchParams.get("scope"));
    await removeProfilePhoto(request, scope);
    return Response.json({ removed: true }, { headers: NO_STORE });
  } catch (error) { return fail(error, request); }
}
