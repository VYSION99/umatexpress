import { CampusEngineError } from '@/lib/campus-engine/errors';
import { privateBucket } from '@/lib/cloudflare-bindings';
import { envValue } from '@/lib/runtime-env';
import type { PhotoBucket } from './photos';
import { MAX_MAINTENANCE_PHOTOS, MAX_MAINTENANCE_PHOTO_BYTES } from './maintenance-types';

export type MaintenanceActor = { kind: 'STUDENT'; email: string; name: string } | { kind: 'STAFF'; email: string; name: string; landlordId: string; isOwner: boolean };
export type MaintenanceUpload = { name: string; type: string; body: ArrayBuffer };
export type StagedMaintenanceFile = { id: string; objectKey: string; name: string; type: string; bytes: number };
const encoder = new TextEncoder();
export async function maintenanceHash(value: string | ArrayBuffer) {
 const digest = await crypto.subtle.digest('SHA-256', typeof value === 'string' ? encoder.encode(value) : value);
 return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
export function validateMaintenancePhotos(files: MaintenanceUpload[]) {
 if (files.length > MAX_MAINTENANCE_PHOTOS) throw new CampusEngineError('VALIDATION_ERROR', 'Add up to three photos at a time.', 400);
 for (const file of files) {
  if (!file.body.byteLength || file.body.byteLength > MAX_MAINTENANCE_PHOTO_BYTES) throw new CampusEngineError('VALIDATION_ERROR', 'Each photo must be between 1 byte and 6 MB.', 400);
  const b = new Uint8Array(file.body);
  const png = [137,80,78,71,13,10,26,10].every((n,i) => b[i] === n);
  const jpeg = b[0] === 255 && b[1] === 216 && b[2] === 255;
  const webp = String.fromCharCode(...b.slice(0,4)) === 'RIFF' && String.fromCharCode(...b.slice(8,12)) === 'WEBP';
  if (!(file.type === 'image/png' && png || file.type === 'image/jpeg' && jpeg || file.type === 'image/webp' && webp)) {
   throw new CampusEngineError('VALIDATION_ERROR', 'Choose a valid JPEG, PNG, or WebP photo. Other file formats are not supported.', 400);
  }
 }
}
export async function maintenanceBucket(bucket?: PhotoBucket) {
 const result = bucket ?? await privateBucket() as PhotoBucket | undefined;
 if (!result) throw new CampusEngineError('CONFIG_REQUIRED', 'Photo storage is unavailable. You can submit the report without photos and add them later.', 503);
 return result;
}
export async function stageMaintenancePhotos(requestId: string, files: MaintenanceUpload[], bucket?: PhotoBucket, namespace: "maintenance" | "conditions" = "maintenance") {
 validateMaintenancePhotos(files);
 const staged: StagedMaintenanceFile[] = [];
 if (!files.length) return staged;
 const store = await maintenanceBucket(bucket);
 try {
  for (const file of files) {
   const id = crypto.randomUUID(), objectKey = `hostel-${namespace}/${requestId}/${id}`;
   // Record before put: a timed-out upload may have reached R2 and still needs cleanup.
   staged.push({ id, objectKey, name: file.name.replace(/[\x00-\x1f/\\]/g, '').slice(0,80) || 'Photo', type: file.type, bytes: file.body.byteLength });
   await store.put(objectKey, file.body, { httpMetadata: { contentType: file.type } });
  }
  return staged;
 } catch (error) { await discardMaintenancePhotos(staged, store); throw error; }
}
export async function discardMaintenancePhotos(files: StagedMaintenanceFile[], bucket?: PhotoBucket) {
 if (!files.length) return;
 try { await (await maintenanceBucket(bucket)).delete(files.map(file => file.objectKey)); } catch { /* A storage outage may defer orphan cleanup; no database URL is exposed. */ }
}
async function signingKey() {
 const secret = await envValue('CONSOLE_SESSION_SECRET', ['ADMIN_SESSION_SECRET', 'STUDENT_SESSION_SECRET']);
 if (secret.length < 32) throw new CampusEngineError('CONFIG_REQUIRED', 'Private photo access is not configured.', 503);
 return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign','verify']);
}
function accessMessage(actor: MaintenanceActor, id: string, expires: number, namespace: "maintenance" | "conditions" = "maintenance") {
 return encoder.encode(JSON.stringify([...(namespace === "conditions" ? [namespace] : []), actor.kind, actor.email.toLowerCase(), actor.kind === 'STAFF' ? actor.landlordId : '', id, expires]));
}
export async function maintenancePhotoUrl(actor: MaintenanceActor, id: string, namespace: "maintenance" | "conditions" = "maintenance") {
 const expires = Date.now() + 5 * 60_000;
 const signature = await crypto.subtle.sign('HMAC', await signingKey(), accessMessage(actor, id, expires, namespace));
 const token = `${expires}.` + Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2,'0')).join('');
 const prefix = actor.kind === "STAFF" ? `/api/console/hostel/${namespace}` : `/api/hostel/${namespace}`;
 return `${prefix}/files/${encodeURIComponent(id)}?token=${encodeURIComponent(token)}`;
}
export async function verifyMaintenancePhotoToken(actor: MaintenanceActor, id: string, token: string, namespace: "maintenance" | "conditions" = "maintenance") {
 const [expiry, signature] = token.split('.'), expires = Number(expiry);
 if (!Number.isSafeInteger(expires) || expires <= Date.now() || expires > Date.now() + 5 * 60_000 || !/^[a-f0-9]{64}$/.test(signature || '')) return false;
 const bytes = Uint8Array.from(signature.match(/../g)!, part => parseInt(part,16));
 return crypto.subtle.verify('HMAC', await signingKey(), bytes, accessMessage(actor,id,expires,namespace));
}

/** Bound multipart bytes even when the caller omits Content-Length. */
export async function readMaintenanceBody(request: Request): Promise<{ data: Record<string, unknown>; files: MaintenanceUpload[] }> {
 const limit = 19 * 1024 * 1024;
 if (Number(request.headers.get('content-length') || 0) > limit) throw new CampusEngineError('VALIDATION_ERROR', 'This upload is too large. Choose up to three photos of 6 MB each.', 413);
 const reader = request.body?.getReader();
 if (!reader) throw new CampusEngineError('VALIDATION_ERROR', 'Enter the report details.', 400);
 const chunks: Uint8Array[] = []; let length = 0;
 while (true) {
  const chunk = await reader.read(); if (chunk.done) break;
  length += chunk.value.byteLength;
  if (length > limit) { await reader.cancel(); throw new CampusEngineError('VALIDATION_ERROR', 'This upload is too large.', 413); }
  chunks.push(chunk.value);
 }
 const bytes = new Uint8Array(length); let offset = 0;
 for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.byteLength; }
 try {
  const type = request.headers.get('content-type') || '';
  if (type.startsWith('application/json')) {
   if (length > 12_000) throw new Error('Too much text');
   const data = JSON.parse(new TextDecoder().decode(bytes));
   if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid body');
   return { data, files: [] };
  }
  if (!type.startsWith('multipart/form-data')) throw new Error('Unsupported body');
  const form = await new Response(bytes, { headers: { 'content-type': type } }).formData();
  const raw = form.get('data'); if (typeof raw !== 'string' || raw.length > 12_000) throw new Error('Missing details');
  const data = JSON.parse(raw);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid details');
  const uploads = form.getAll('photos');
  if (uploads.length > 3 || uploads.some(file => !(file instanceof File))) throw new Error('Choose up to three photos');
  const files = await Promise.all((uploads as File[]).map(async file => ({ name: file.name, type: file.type, body: await file.arrayBuffer() })));
  validateMaintenancePhotos(files);
  return { data, files };
 } catch (error) {
  if (error instanceof CampusEngineError) throw error;
  throw new CampusEngineError('VALIDATION_ERROR', 'Check the report details and choose up to three supported photos.', 400);
 }
}
