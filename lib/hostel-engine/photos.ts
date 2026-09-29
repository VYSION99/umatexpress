import { CampusEngineError } from "@/lib/campus-engine/errors";
import { consoleAudit } from "@/lib/console-audit";
import { privateBucket } from "@/lib/cloudflare-bindings";
import { ensureHostelTables } from "@/lib/hostel-engine/landlord";
import { rowsToObjects, runSchemaPass, turso } from "@/lib/turso";

/**
 * Property photos.
 *
 * A listing nobody can see is a listing nobody trusts, so photos are the first
 * thing a reviewer looks at. The bytes live in the private R2 bucket under a
 * key nobody can guess; the row in `hostel_property_photos` decides who may
 * read them — approved photos are served to anyone, and a landlord or a
 * reviewer can preview the rest.
 *
 * Uploads are the landlord's; approval is staff's. Nothing a landlord uploads
 * becomes public on its own, which is what keeps an unmoderated photo off the
 * student map.
 */

export const HOSTEL_PHOTO_STATUSES = ["PENDING", "APPROVED", "REJECTED"] as const;
export type HostelPhotoStatus = (typeof HOSTEL_PHOTO_STATUSES)[number];

/** Formats a phone camera actually produces, and what browsers render. */
export const HOSTEL_PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
/** Six megabytes holds a full-resolution phone photo without holding a hostel back. */
export const MAX_HOSTEL_PHOTO_BYTES = 6 * 1024 * 1024;
/** A gallery is a first impression, not an album. */
export const MAX_HOSTEL_PHOTOS_PER_PROPERTY = 12;

const PHOTO_SCHEMA_STATEMENTS = [
  "ALTER TABLE hostel_property_photos ADD COLUMN landlord_id TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE hostel_property_photos ADD COLUMN room_id TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE hostel_property_photos ADD COLUMN content_type TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE hostel_property_photos ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE hostel_property_photos ADD COLUMN review_reason TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE hostel_property_photos ADD COLUMN reviewed_by TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE hostel_property_photos ADD COLUMN reviewed_at TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE hostel_property_photos ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''",
  "CREATE INDEX IF NOT EXISTS idx_hostel_photos_landlord ON hostel_property_photos(landlord_id, status, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_hostel_photos_status ON hostel_property_photos(status, created_at DESC)",
  // Rows uploaded before this pass carried no owner; the property owns them.
  `UPDATE hostel_property_photos SET landlord_id = COALESCE((SELECT p.landlord_id FROM hostel_properties p WHERE p.id = hostel_property_photos.property_id), '')
    WHERE landlord_id = ''`,
];

let photoTablesReady: Promise<void> | null = null;

/** Memoised per isolate; a gallery read must not run DDL. */
export function ensureHostelPhotoTables() {
  photoTablesReady ??= (async () => {
    await ensureHostelTables();
    await runSchemaPass({ metaTable: "campus_schema_meta", id: "hostelPhotos", version: "018_hostel_photos", statements: PHOTO_SCHEMA_STATEMENTS });
    await runSchemaPass({ metaTable: "campus_schema_meta", id: "hostelRoomMedia", version: "027_hostel_room_media", statements: ["ALTER TABLE hostel_property_photos ADD COLUMN media_kind TEXT NOT NULL DEFAULT 'PHOTO'"] });
    await runSchemaPass({ metaTable: "campus_schema_meta", id: "hostelPhotoScopes", version: "028_hostel_photo_scopes", statements: [
      "ALTER TABLE hostel_property_photos ADD COLUMN scope_type TEXT NOT NULL DEFAULT 'PROPERTY'",
      "ALTER TABLE hostel_property_photos ADD COLUMN scope_label TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE hostel_property_photos ADD COLUMN room_start_id TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE hostel_property_photos ADD COLUMN room_end_id TEXT NOT NULL DEFAULT ''",
      `UPDATE hostel_property_photos SET scope_type = CASE WHEN COALESCE(room_id,'') <> '' THEN 'ROOM' ELSE 'PROPERTY' END,
       scope_label = CASE WHEN COALESCE(room_id,'') <> '' THEN COALESCE((SELECT label FROM hostel_rooms WHERE id=hostel_property_photos.room_id),'Specific room') ELSE 'Whole property' END
       WHERE scope_label = ''`,
    ] });
  })().catch((error: unknown) => {
    photoTablesReady = null;
    throw error;
  });
  return photoTablesReady;
}

export type HostelPhoto = {
  id: string;
  propertyId: string;
  landlordId: string;
  roomId: string;
  scopeType: "PROPERTY" | "BUILDING_AREA" | "ROOM_RANGE" | "ROOM";
  scopeLabel: string;
  roomStartId: string;
  roomEndId: string;
  mediaKind: "PHOTO" | "FLOOR_PLAN";
  caption: string;
  sortOrder: number;
  status: HostelPhotoStatus;
  contentType: string;
  bytes: number;
  reviewReason: string;
  reviewedBy: string;
  reviewedAt: string;
  createdAt: string;
};

/** The shape a public page needs: an id it can point an <img> at, and a caption. */
export type PublicHostelPhoto = {
  id: string;
  roomId: string;
  scopeType: "PROPERTY" | "BUILDING_AREA" | "ROOM_RANGE" | "ROOM";
  scopeLabel: string;
  roomStartId: string;
  roomEndId: string;
  mediaKind: "PHOTO" | "FLOOR_PLAN";
  reviewedAt: string;
  caption: string;
  sortOrder: number;
};

/** Only what R2 promises a stored object has; the binding is typed loosely on purpose. */
export type PhotoBucket = {
  put(key: string, value: ArrayBuffer | ReadableStream | string, options?: Record<string, unknown>): Promise<unknown>;
  get(key: string): Promise<StoredPhotoObject | null>;
  delete(key: string | string[]): Promise<void>;
};

export type StoredPhotoObject = {
  body?: ReadableStream;
  size?: number;
  httpMetadata?: { contentType?: string };
};

const PHOTO_COLUMNS = `id,property_id,COALESCE(landlord_id,'') AS landlord_id,COALESCE(room_id,'') AS room_id,
  COALESCE(scope_type,CASE WHEN COALESCE(room_id,'') <> '' THEN 'ROOM' ELSE 'PROPERTY' END) AS scope_type,COALESCE(scope_label,'') AS scope_label,
  COALESCE(room_start_id,'') AS room_start_id,COALESCE(room_end_id,'') AS room_end_id,
  COALESCE(media_kind,'PHOTO') AS media_kind,COALESCE(caption,'') AS caption,COALESCE(sort_order,0) AS sort_order,COALESCE(status,'PENDING') AS status,
  COALESCE(content_type,'') AS content_type,COALESCE(bytes,0) AS bytes,COALESCE(review_reason,'') AS review_reason,
  COALESCE(reviewed_by,'') AS reviewed_by,COALESCE(reviewed_at,'') AS reviewed_at,created_at,COALESCE(updated_at,'') AS updated_at`;

function photoView(row: Record<string, unknown>): HostelPhoto {
  return {
    id: String(row.id || ""),
    propertyId: String(row.property_id || ""),
    landlordId: String(row.landlord_id || ""),
    roomId: String(row.room_id || ""),
    scopeType: String(row.scope_type || (row.room_id ? "ROOM" : "PROPERTY")) as HostelPhoto["scopeType"],
    scopeLabel: String(row.scope_label || (row.room_id ? "Specific room" : "Whole property")),
    roomStartId: String(row.room_start_id || ""),
    roomEndId: String(row.room_end_id || ""),
    mediaKind: String(row.media_kind || "PHOTO") as "PHOTO" | "FLOOR_PLAN",
    caption: String(row.caption || ""),
    sortOrder: Number(row.sort_order || 0),
    status: String(row.status || "PENDING") as HostelPhotoStatus,
    contentType: String(row.content_type || ""),
    bytes: Number(row.bytes || 0),
    reviewReason: String(row.review_reason || ""),
    reviewedBy: String(row.reviewed_by || ""),
    reviewedAt: String(row.reviewed_at || ""),
    createdAt: String(row.created_at || ""),
  };
}

function publicPhotoView(row: Record<string, unknown>): PublicHostelPhoto {
  return {
    id: String(row.id || ""),
    roomId: String(row.room_id || ""),
    scopeType: String(row.scope_type || (row.room_id ? "ROOM" : "PROPERTY")) as PublicHostelPhoto["scopeType"],
    scopeLabel: String(row.scope_label || (row.room_id ? "Specific room" : "Whole property")),
    roomStartId: String(row.room_start_id || ""),
    roomEndId: String(row.room_end_id || ""),
    mediaKind: String(row.media_kind || "PHOTO") as "PHOTO" | "FLOOR_PLAN",
    reviewedAt: String(row.reviewed_at || ""),
    caption: String(row.caption || ""),
    sortOrder: Number(row.sort_order || 0),
  };
}

/** The object key: unique per photo, and impossible to enumerate from outside. */
export function hostelPhotoKey(landlordId: string, propertyId: string, photoId: string) {
  return `hostel/${landlordId}/${propertyId}/${photoId}`;
}

function validateUpload(input: { contentType: string; bytes: number }) {
  if (!(HOSTEL_PHOTO_TYPES as readonly string[]).includes(input.contentType)) {
    throw new CampusEngineError("VALIDATION_ERROR", "Upload a JPEG, PNG or WebP photo.", 400);
  }
  if (!Number.isFinite(input.bytes) || input.bytes <= 0) {
    throw new CampusEngineError("VALIDATION_ERROR", "That file is empty.", 400);
  }
  if (input.bytes > MAX_HOSTEL_PHOTO_BYTES) {
    throw new CampusEngineError("VALIDATION_ERROR", `Keep each photo under ${Math.round(MAX_HOSTEL_PHOTO_BYTES / 1024 / 1024)} MB.`, 400);
  }
}

async function requireBucket(bucket?: PhotoBucket | null) {
  const resolved = bucket ?? (await privateBucket() as PhotoBucket | undefined);
  if (!resolved) {
    throw new CampusEngineError("CONFIG_REQUIRED", "Photo storage is not configured yet.", 503);
  }
  return resolved;
}

/**
 * Stores one photo for a property this landlord owns. The row is written only
 * after the object is stored, so a failed upload never leaves a photo that
 * cannot be served.
 */
export async function storeHostelPhoto(input: {
  landlordId: string;
  propertyId: string;
  roomId?: string;
  scopeType?: "PROPERTY" | "BUILDING_AREA" | "ROOM_RANGE" | "ROOM";
  scopeLabel?: string;
  roomStartId?: string;
  roomEndId?: string;
  mediaKind?: "PHOTO" | "FLOOR_PLAN";
  caption?: string;
  contentType: string;
  body: ArrayBuffer;
  actor: string;
  bucket?: PhotoBucket | null;
}) {
  await ensureHostelPhotoTables();
  const propertyId = String(input.propertyId || "").trim();
  if (!propertyId) throw new CampusEngineError("VALIDATION_ERROR", "Choose the property this photo belongs to.", 400);
  validateUpload({ contentType: input.contentType, bytes: input.body.byteLength });

  const property = rowsToObjects(await turso(
    "SELECT id FROM hostel_properties WHERE id = ? AND landlord_id = ? LIMIT 1",
    [propertyId, String(input.landlordId || "")],
  ))[0];
  if (!property) throw new CampusEngineError("NOT_FOUND", "That property was not found.", 404);

  const roomId = String(input.roomId || "").trim();
  const mediaKind = input.mediaKind || "PHOTO";
  const scopeType = input.scopeType || (roomId ? "ROOM" : "PROPERTY");
  let scopeLabel = String(input.scopeLabel || "").trim().slice(0, 80);
  const roomStartId = String(input.roomStartId || "").trim();
  const roomEndId = String(input.roomEndId || "").trim();
  if (!["PHOTO", "FLOOR_PLAN"].includes(mediaKind) || !["PROPERTY", "BUILDING_AREA", "ROOM_RANGE", "ROOM"].includes(scopeType)) throw new CampusEngineError("VALIDATION_ERROR", "Choose a valid photo type and photo area.", 400);
  if (mediaKind === "FLOOR_PLAN" && (scopeType !== "ROOM" || !roomId)) throw new CampusEngineError("VALIDATION_ERROR", "A floor plan must be linked to one room.", 400);
  if (scopeType === "PROPERTY") {
    if (roomId) throw new CampusEngineError("VALIDATION_ERROR", "Whole-property photos cannot be assigned to a single room.", 400);
    scopeLabel = "Whole property";
  }
  if (scopeType === "BUILDING_AREA" && (roomId || !scopeLabel)) throw new CampusEngineError("VALIDATION_ERROR", "Choose which building area the photo shows.", 400);
  if (scopeType === "ROOM_RANGE") {
    if (roomId || !roomStartId || !roomEndId) throw new CampusEngineError("VALIDATION_ERROR", "Choose the first and last room shown.", 400);
    const roomRows = rowsToObjects(await turso("SELECT id,label FROM hostel_rooms WHERE property_id = ? ORDER BY label COLLATE NOCASE ASC", [propertyId]));
    const startIndex = roomRows.findIndex((row) => String(row.id) === roomStartId);
    const endIndex = roomRows.findIndex((row) => String(row.id) === roomEndId);
    if (startIndex < 0 || endIndex < 0) throw new CampusEngineError("NOT_FOUND", "Both rooms must belong to this property.", 404);
    if (startIndex >= endIndex) throw new CampusEngineError("VALIDATION_ERROR", "Choose a first room that comes before the last room.", 400);
    const firstLabel = String(roomRows[startIndex].label || "Room");
    const lastLabel = String(roomRows[endIndex].label || "Room");
    scopeLabel = `Rooms ${firstLabel} – ${lastLabel}`.slice(0, 80);
  }
  if (scopeType === "ROOM") {
    if (!roomId) throw new CampusEngineError("VALIDATION_ERROR", "Choose a room for this photo.", 400);
    const room = rowsToObjects(await turso("SELECT id,label FROM hostel_rooms WHERE id = ? AND property_id = ? LIMIT 1", [roomId, propertyId]))[0];
    if (!room) throw new CampusEngineError("NOT_FOUND", "That room was not found in this property.", 404);
    scopeLabel = String(room.label || "Specific room");
  }
  if (scopeType !== "ROOM_RANGE" && (roomStartId || roomEndId)) throw new CampusEngineError("VALIDATION_ERROR", "Room range endpoints are only valid for a room-range photo.", 400);

  const count = rowsToObjects(await turso("SELECT COUNT(*) AS c FROM hostel_property_photos WHERE property_id = ?", [propertyId]))[0];
  if (Number(count?.c || 0) >= MAX_HOSTEL_PHOTOS_PER_PROPERTY) {
    throw new CampusEngineError("INVALID_STATE", `A property can hold ${MAX_HOSTEL_PHOTOS_PER_PROPERTY} photos. Remove one before adding another.`, 409);
  }

  const photoId = crypto.randomUUID();
  const key = hostelPhotoKey(String(input.landlordId), propertyId, photoId);
  const bucket = await requireBucket(input.bucket);
  await bucket.put(key, input.body, { httpMetadata: { contentType: input.contentType } });

  const stamp = new Date().toISOString();
  const next = rowsToObjects(await turso("SELECT COALESCE(MAX(sort_order),0) + 1 AS next FROM hostel_property_photos WHERE property_id = ?", [propertyId]))[0];
  await turso(
    `INSERT INTO hostel_property_photos (id,property_id,landlord_id,room_id,scope_type,scope_label,room_start_id,room_end_id,media_kind,r2_key,caption,sort_order,status,content_type,bytes,review_reason,reviewed_by,reviewed_at,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'PENDING',?,?,'','','',?,?)`,
    [
      photoId, propertyId, String(input.landlordId), scopeType === "ROOM" ? roomId : "", scopeType, scopeLabel, roomStartId, roomEndId, mediaKind, key,
      String(input.caption || "").trim().slice(0, 160), Number(next?.next || 1),
      input.contentType, input.body.byteLength, stamp, stamp,
    ],
  );
  await consoleAudit({
    actor: input.actor, action: "HOSTEL_PHOTO_UPLOADED", targetType: "hostel_property_photo", targetReference: photoId,
    details: { propertyId, bytes: input.body.byteLength, contentType: input.contentType },
  }).catch(() => undefined);
  return getHostelPhoto(photoId);
}

export async function getHostelPhoto(photoId: string): Promise<HostelPhoto | null> {
  await ensureHostelPhotoTables();
  const row = rowsToObjects(await turso(`SELECT ${PHOTO_COLUMNS} FROM hostel_property_photos WHERE id = ? LIMIT 1`, [String(photoId || "")]))[0];
  return row ? photoView(row) : null;
}

/** The landlord's own gallery, newest first, with status attached. */
export async function listHostelPhotosForLandlord(landlordId: string, propertyId?: string) {
  await ensureHostelPhotoTables();
  const id = String(propertyId || "").trim();
  const rows = rowsToObjects(await turso(
    `SELECT ${PHOTO_COLUMNS} FROM hostel_property_photos WHERE landlord_id = ?${id ? " AND property_id = ?" : ""} ORDER BY sort_order ASC, created_at ASC`,
    id ? [String(landlordId), id] : [String(landlordId)],
  ));
  return rows.map(photoView);
}

/** What a student may see: approved photos, in the order the landlord set. */
export async function listApprovedHostelPhotos(propertyId: string): Promise<PublicHostelPhoto[]> {
  await ensureHostelPhotoTables();
  const rows = rowsToObjects(await turso(
    `SELECT id,room_id,scope_type,scope_label,room_start_id,room_end_id,media_kind,reviewed_at,caption,sort_order FROM hostel_property_photos WHERE property_id = ? AND status = 'APPROVED' ORDER BY sort_order ASC, created_at ASC`,
    [String(propertyId || "")],
  ));
  return rows.map(publicPhotoView);
}

/** The cover a card shows: the landlord's first approved photo. */
export async function listApprovedPhotoCovers(propertyIds: string[]) {
  const ids = propertyIds.map((id) => String(id || "")).filter(Boolean);
  if (!ids.length) return new Map<string, PublicHostelPhoto>();
  await ensureHostelPhotoTables();
  const rows = rowsToObjects(await turso(
    `SELECT id,property_id,room_id,scope_type,scope_label,room_start_id,room_end_id,media_kind,reviewed_at,caption,sort_order FROM hostel_property_photos WHERE status = 'APPROVED' AND media_kind = 'PHOTO' AND room_id = '' AND property_id IN (${ids.map(() => "?").join(",")}) AND scope_type IN ('PROPERTY','BUILDING_AREA') ORDER BY sort_order ASC, created_at ASC`,
    ids,
  ));
  const covers = new Map<string, PublicHostelPhoto>();
  for (const row of rows) {
    const propertyId = String(row.property_id || "");
    if (!covers.has(propertyId)) covers.set(propertyId, publicPhotoView(row));
  }
  return covers;
}

/** The moderation queue: what is waiting, oldest first. */
export async function listPendingHostelPhotos(limit = 100) {
  await ensureHostelPhotoTables();
  const bounded = Math.min(Math.max(Number(limit) || 100, 1), 200);
  const rows = rowsToObjects(await turso(
    `SELECT ${PHOTO_COLUMNS} FROM hostel_property_photos WHERE status = 'PENDING' ORDER BY created_at ASC LIMIT ${bounded}`,
  ));
  return rows.map(photoView);
}

export const HOSTEL_PHOTO_ACTIONS = ["APPROVE", "REJECT"] as const;
export type HostelPhotoAction = (typeof HOSTEL_PHOTO_ACTIONS)[number];

/** Staff decide whether a photo may be shown. A rejection needs a reason. */
export async function reviewHostelPhoto(input: { photoId: string; action: HostelPhotoAction; reason?: unknown; actor: string }) {
  await ensureHostelPhotoTables();
  const photo = await getHostelPhoto(input.photoId);
  if (!photo) throw new CampusEngineError("NOT_FOUND", "That photo was not found.", 404);
  const reason = String(input.reason || "").trim().slice(0, 200);
  if (input.action === "REJECT" && !reason) {
    throw new CampusEngineError("VALIDATION_ERROR", "Say why the photo is rejected so the landlord can fix it.", 400);
  }
  const status: HostelPhotoStatus = input.action === "APPROVE" ? "APPROVED" : "REJECTED";
  const stamp = new Date().toISOString();
  await turso(
    "UPDATE hostel_property_photos SET status = ?, review_reason = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ?",
    [status, reason, String(input.actor || ""), stamp, stamp, photo.id],
  );
  await consoleAudit({
    actor: input.actor, action: `HOSTEL_PHOTO_${status}`, targetType: "hostel_property_photo", targetReference: photo.id,
    details: { propertyId: photo.propertyId, reason },
  }).catch(() => undefined);
  return getHostelPhoto(photo.id);
}

/** Caption edits, and the one action that decides the cover: sorting first. */
export async function updateHostelPhoto(input: { landlordId: string; photoId: string; caption?: unknown; cover?: unknown }) {
  await ensureHostelPhotoTables();
  const photo = await getHostelPhoto(input.photoId);
  if (!photo || photo.landlordId !== String(input.landlordId || "")) {
    throw new CampusEngineError("NOT_FOUND", "That photo was not found.", 404);
  }
  const stamp = new Date().toISOString();
  if (input.caption !== undefined) {
    await turso("UPDATE hostel_property_photos SET caption = ?, updated_at = ? WHERE id = ?", [String(input.caption || "").trim().slice(0, 160), stamp, photo.id]);
  }
  if (input.cover === true) {
    const lowest = rowsToObjects(await turso("SELECT COALESCE(MIN(sort_order),0) AS lowest FROM hostel_property_photos WHERE property_id = ?", [photo.propertyId]))[0];
    await turso("UPDATE hostel_property_photos SET sort_order = ?, updated_at = ? WHERE id = ?", [Number(lowest?.lowest || 0) - 1, stamp, photo.id]);
  }
  return getHostelPhoto(photo.id);
}

/** Removes the row and the object. A missing object is not an error. */
export async function deleteHostelPhoto(input: { landlordId?: string; photoId: string; actor: string; bucket?: PhotoBucket | null }) {
  await ensureHostelPhotoTables();
  const photo = await getHostelPhoto(input.photoId);
  if (!photo) throw new CampusEngineError("NOT_FOUND", "That photo was not found.", 404);
  if (input.landlordId && photo.landlordId !== String(input.landlordId)) {
    throw new CampusEngineError("NOT_FOUND", "That photo was not found.", 404);
  }
  await turso("DELETE FROM hostel_property_photos WHERE id = ?", [photo.id]);
  try {
    const bucket = await requireBucket(input.bucket);
    await bucket.delete(hostelPhotoKey(photo.landlordId, photo.propertyId, photo.id));
  } catch {
    // The row is gone, which is what makes the photo unreachable; an orphaned
    // object in a private bucket is a cleanup job, not a failed deletion.
  }
  await consoleAudit({
    actor: input.actor, action: "HOSTEL_PHOTO_DELETED", targetType: "hostel_property_photo", targetReference: photo.id,
    details: { propertyId: photo.propertyId },
  }).catch(() => undefined);
  return { id: photo.id, propertyId: photo.propertyId };
}

/** The bytes behind a photo, for a route that has already decided who may read them. */
export async function readHostelPhotoObject(photo: HostelPhoto, bucket?: PhotoBucket | null) {
  const resolved = await requireBucket(bucket);
  const object = await resolved.get(hostelPhotoKey(photo.landlordId, photo.propertyId, photo.id));
  if (!object || !object.body) throw new CampusEngineError("NOT_FOUND", "That photo's file is no longer stored.", 404);
  return object;
}
