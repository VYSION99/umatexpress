import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

/**
 * Property photos: the bytes live in the private bucket and the row decides who
 * may read them. The tests drive the engine against a fake Turso and a fake R2,
 * so both halves of that split can be asserted — an upload is invisible until a
 * reviewer approves it, and a rejected photo never becomes public on its own.
 */

process.env.TURSO_DATABASE_URL = "https://photos-test.turso.io";
process.env.TURSO_AUTH_TOKEN = "test-token";
process.env.CONSOLE_SESSION_SECRET = "test-console-session-secret-at-least-32-chars";

const properties = [
  { id: "property-a", landlord_id: "landlord-a", name: "Owusu Lodge", status: "APPROVED" },
  { id: "property-b", landlord_id: "landlord-b", name: "Mensah Court", status: "APPROVED" },
  { id: "property-c", landlord_id: "landlord-a", name: "Owusu Annex", status: "APPROVED" },
  { id: "property-d", landlord_id: "landlord-a", name: "Owusu Garden", status: "APPROVED" },
  { id: "property-e", landlord_id: "landlord-b", name: "Mensah Villas", status: "APPROVED" },
];
const rooms = [{ id: "room-a", property_id: "property-a", label: "A1" }];
const photos = [];

const PHOTO_COLUMNS = [
  "id", "property_id", "landlord_id", "room_id", "caption", "sort_order", "status", "content_type",
  "bytes", "review_reason", "reviewed_by", "reviewed_at", "created_at", "updated_at",
];

function cell(value) {
  if (value === null || value === undefined) return { type: "null" };
  if (typeof value === "number") return { type: Number.isInteger(value) ? "integer" : "real", value: String(value) };
  return { type: "text", value: String(value) };
}

function table(columns, rows) {
  return { cols: columns.map((name) => ({ name })), rows: rows.map((row) => columns.map((name) => cell(row[name]))) };
}

const empty = { cols: [], rows: [] };
const ok = (result) => ({ type: "ok", response: { result: result || {} } });

const bySort = (a, b) => (a.sort_order - b.sort_order) || String(a.created_at).localeCompare(String(b.created_at));
const forProperty = (id) => photos.filter((photo) => photo.property_id === id).sort(bySort);

function handle(sql, args) {
  // Every schema pass is already applied in this database, so the marker alone
  // is enough; the fake never has to execute DDL.
  if (/^SELECT version FROM campus_schema_meta/.test(sql)) return ok(table(["version"], [{ version: "test-version" }]));
  if (/^CREATE |^ALTER |^INSERT OR REPLACE INTO campus_schema_meta|^INSERT INTO admin_audit_logs|^INSERT INTO rate_limit_windows/.test(sql)) return ok(empty);
  if (/^SELECT count FROM rate_limit_windows/.test(sql)) return ok(table(["count"], [{ count: 1 }]));

  if (/^SELECT id FROM hostel_properties WHERE id = \? AND landlord_id = \? LIMIT 1/.test(sql)) {
    const row = properties.find((item) => item.id === args[0] && item.landlord_id === args[1]);
    return ok(row ? table(["id"], [row]) : empty);
  }
  if (/^SELECT id FROM hostel_rooms WHERE id = \? AND property_id = \? LIMIT 1/.test(sql)) {
    const row = rooms.find((item) => item.id === args[0] && item.property_id === args[1]);
    return ok(row ? table(["id"], [row]) : empty);
  }
  if (/^SELECT COUNT\(\*\) AS c FROM hostel_property_photos WHERE property_id = \?/.test(sql)) {
    return ok(table(["c"], [{ c: photos.filter((photo) => photo.property_id === args[0]).length }]));
  }
  if (/^SELECT COALESCE\(MAX\(sort_order\),0\) \+ 1 AS next FROM hostel_property_photos WHERE property_id = \?/.test(sql)) {
    const list = photos.filter((photo) => photo.property_id === args[0]);
    return ok(table(["next"], [{ next: list.length ? Math.max(...list.map((photo) => photo.sort_order)) + 1 : 1 }]));
  }
  if (/^SELECT COALESCE\(MIN\(sort_order\),0\) AS lowest FROM hostel_property_photos WHERE property_id = \?/.test(sql)) {
    const list = photos.filter((photo) => photo.property_id === args[0]);
    return ok(table(["lowest"], [{ lowest: list.length ? Math.min(...list.map((photo) => photo.sort_order)) : 0 }]));
  }
  if (/^INSERT INTO hostel_property_photos/.test(sql)) {
    const [id, propertyId, landlordId, roomId, r2Key, caption, sortOrder, contentType, bytes, createdAt, updatedAt] = args;
    photos.push({
      id, property_id: propertyId, landlord_id: landlordId, room_id: roomId, r2_key: r2Key, caption,
      sort_order: Number(sortOrder), status: "PENDING", content_type: contentType, bytes: Number(bytes),
      review_reason: "", reviewed_by: "", reviewed_at: "", created_at: createdAt, updated_at: updatedAt,
    });
    return ok(empty);
  }
  if (/^SELECT id,property_id,COALESCE\(landlord_id,''\) AS landlord_id/.test(sql) && /WHERE id = \? LIMIT 1/.test(sql)) {
    const row = photos.find((photo) => photo.id === args[0]);
    return ok(row ? table(PHOTO_COLUMNS, [row]) : empty);
  }
  if (/^SELECT id,property_id,COALESCE\(landlord_id,''\) AS landlord_id/.test(sql) && /FROM hostel_property_photos WHERE landlord_id = \?/.test(sql)) {
    const rows = args.length === 2
      ? photos.filter((photo) => photo.landlord_id === args[0] && photo.property_id === args[1])
      : photos.filter((photo) => photo.landlord_id === args[0]);
    return ok(rows.length ? table(PHOTO_COLUMNS, rows.sort(bySort)) : empty);
  }
  if (/^SELECT id,property_id,COALESCE\(landlord_id,''\) AS landlord_id/.test(sql) && /WHERE status = 'PENDING'/.test(sql)) {
    const rows = photos.filter((photo) => photo.status === "PENDING").sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    return ok(rows.length ? table(PHOTO_COLUMNS, rows) : empty);
  }
  if (/^SELECT id,caption,sort_order FROM hostel_property_photos WHERE property_id = \? AND status = 'APPROVED'/.test(sql)) {
    const rows = forProperty(args[0]).filter((photo) => photo.status === "APPROVED");
    return ok(rows.length ? table(["id", "caption", "sort_order"], rows) : empty);
  }
  if (/^SELECT id,property_id,caption,sort_order FROM hostel_property_photos WHERE status = 'APPROVED' AND property_id IN/.test(sql)) {
    const wanted = new Set(args);
    const rows = photos.filter((photo) => photo.status === "APPROVED" && wanted.has(photo.property_id)).sort(bySort);
    return ok(rows.length ? table(["id", "property_id", "caption", "sort_order"], rows) : empty);
  }
  if (/^UPDATE hostel_property_photos SET status = \?/.test(sql)) {
    const [status, reason, by, at, updatedAt, id] = args;
    const row = photos.find((photo) => photo.id === id);
    if (row) Object.assign(row, { status, review_reason: reason, reviewed_by: by, reviewed_at: at, updated_at: updatedAt });
    return ok(empty);
  }
  if (/^UPDATE hostel_property_photos SET caption = \?, updated_at = \? WHERE id = \?/.test(sql)) {
    const [caption, updatedAt, id] = args;
    const row = photos.find((photo) => photo.id === id);
    if (row) Object.assign(row, { caption, updated_at: updatedAt });
    return ok(empty);
  }
  if (/^UPDATE hostel_property_photos SET sort_order = \?, updated_at = \? WHERE id = \?/.test(sql)) {
    const [sortOrder, updatedAt, id] = args;
    const row = photos.find((photo) => photo.id === id);
    if (row) Object.assign(row, { sort_order: Number(sortOrder), updated_at: updatedAt });
    return ok(empty);
  }
  if (/^DELETE FROM hostel_property_photos WHERE id = \?/.test(sql)) {
    const index = photos.findIndex((photo) => photo.id === args[0]);
    if (index >= 0) photos.splice(index, 1);
    return ok(empty);
  }
  return ok(empty);
}

globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  const results = body.requests
    .filter((request) => request.type === "execute")
    .map(({ stmt }) => {
      const args = (stmt.args || []).map((arg) => (arg.type === "null" ? null : arg.value));
      return handle(stmt.sql, args);
    });
  results.push({ type: "ok" });
  return { ok: true, json: async () => ({ results }) };
};

/** The smallest stand-in for R2 that still keeps the object and its type. */
function fakeBucket() {
  const objects = new Map();
  return {
    objects,
    async put(key, value, options) {
      objects.set(key, { value, contentType: options?.httpMetadata?.contentType || "" });
    },
    async get(key) {
      const hit = objects.get(key);
      if (!hit) return null;
      return { body: new Response(hit.value).body, httpMetadata: { contentType: hit.contentType }, size: hit.value?.byteLength ?? 0 };
    },
    async delete(key) {
      for (const one of Array.isArray(key) ? key : [key]) objects.delete(one);
    },
  };
}

const bytes = (text) => new TextEncoder().encode(text).buffer;

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root, resolve: { alias: { "@": root } }, server: { middlewareMode: true, hmr: false } });
after(async () => vite.close());

const {
  deleteHostelPhoto, getHostelPhoto, hostelPhotoKey, listApprovedHostelPhotos, listApprovedPhotoCovers,
  listHostelPhotosForLandlord, listPendingHostelPhotos, readHostelPhotoObject, reviewHostelPhoto,
  storeHostelPhoto, updateHostelPhoto, MAX_HOSTEL_PHOTOS_PER_PROPERTY, MAX_HOSTEL_PHOTO_BYTES,
} = await vite.ssrLoadModule("/lib/hostel-engine/photos.ts");
const publicPhotoRoute = await vite.ssrLoadModule("/app/api/hostel/photos/[photoId]/route.ts");
const landlordPhotosRoute = await vite.ssrLoadModule("/app/api/console/hostel/photos/route.ts");
const photoReviewRoute = await vite.ssrLoadModule("/app/api/console/hostel/photos/review/route.ts");

const upload = (input = {}) => storeHostelPhoto({
  landlordId: "landlord-a", propertyId: "property-a", caption: "Front gate", contentType: "image/jpeg",
  body: bytes("jpeg-bytes"), actor: "owusu@example.com", bucket: input.bucket ?? fakeBucket(), ...input,
});

const params = (photoId) => ({ params: Promise.resolve({ photoId }) });

test("an uploaded photo is private until a reviewer approves it", async () => {
  const bucket = fakeBucket();
  const photo = await upload({ bucket });
  assert.equal(photo.status, "PENDING");
  assert.equal(photo.landlordId, "landlord-a");
  assert.equal(photo.propertyId, "property-a");
  assert.equal(photo.contentType, "image/jpeg");
  assert.equal(photo.bytes, 10);
  assert.equal(photo.reviewedBy, "");

  // The object is stored under a key built from ids, not from the file name,
  // which is what makes it unenumerable from outside.
  assert.deepEqual([...bucket.objects.keys()], [hostelPhotoKey("landlord-a", "property-a", photo.id)]);

  assert.deepEqual(await listApprovedHostelPhotos("property-a"), [], "nothing is public before approval");
  assert.deepEqual((await listPendingHostelPhotos()).map((item) => item.id), [photo.id]);
  assert.deepEqual((await listHostelPhotosForLandlord("landlord-a", "property-a")).map((item) => item.status), ["PENDING"]);

  const approved = await reviewHostelPhoto({ photoId: photo.id, action: "APPROVE", actor: "admin@umat.edu.gh" });
  assert.equal(approved.status, "APPROVED");
  assert.equal(approved.reviewedBy, "admin@umat.edu.gh");
  assert.ok(approved.reviewedAt);

  const listed = await listApprovedHostelPhotos("property-a");
  assert.deepEqual(listed.map((item) => item.id), [photo.id]);
  assert.equal(listed[0].caption, "Front gate");
  assert.deepEqual(await listPendingHostelPhotos(), [], "an approved photo leaves the queue");
  const covers = await listApprovedPhotoCovers(["property-a", "property-b"]);
  assert.equal(covers.get("property-a")?.id, photo.id);
  assert.equal(covers.has("property-b"), false, "a property with no approved photo has no cover");
});

test("a rejection needs a reason and never goes public", async () => {
  const photo = await upload({ propertyId: "property-b", landlordId: "landlord-b", caption: "Roof leak" });
  await assert.rejects(
    () => reviewHostelPhoto({ photoId: photo.id, action: "REJECT", actor: "admin@umat.edu.gh" }),
    (error) => error?.code === "VALIDATION_ERROR",
    "a rejection without a reason must be refused",
  );

  const rejected = await reviewHostelPhoto({ photoId: photo.id, action: "REJECT", reason: "Blurry", actor: "admin@umat.edu.gh" });
  assert.equal(rejected.status, "REJECTED");
  assert.equal(rejected.reviewReason, "Blurry");
  assert.deepEqual(await listApprovedHostelPhotos("property-b"), []);
  assert.deepEqual(await listPendingHostelPhotos(), []);

  // A staff member can still preview it; the public route cannot.
  const preview = await getHostelPhoto(photo.id);
  assert.equal(preview.status, "REJECTED");
  const blocked = await publicPhotoRoute.GET(new Request(`https://umatexpress.test/api/hostel/photos/${photo.id}`), params(photo.id));
  assert.equal(blocked.status, 404);
});

test("an upload is refused for a property the landlord does not own", async () => {
  await assert.rejects(
    () => upload({ landlordId: "landlord-b", propertyId: "property-a" }),
    (error) => error?.code === "NOT_FOUND" && error.status === 404,
  );
  await assert.rejects(
    () => upload({ roomId: "room-a", propertyId: "property-b", landlordId: "landlord-b" }),
    (error) => error?.code === "NOT_FOUND" && error.status === 404,
    "a room from another property is not a valid target",
  );
});

test("only a JPEG, PNG or WebP under six megabytes is accepted", async () => {
  await assert.rejects(() => upload({ contentType: "image/gif" }), (error) => error?.code === "VALIDATION_ERROR");
  await assert.rejects(() => upload({ body: new ArrayBuffer(0) }), (error) => error?.code === "VALIDATION_ERROR");
  await assert.rejects(
    () => upload({ body: { byteLength: MAX_HOSTEL_PHOTO_BYTES + 1 } }),
    (error) => error?.code === "VALIDATION_ERROR",
  );
  const stored = await upload({ contentType: "image/webp", body: bytes("webp") });
  assert.equal(stored.contentType, "image/webp");
});

test("a gallery stops at twelve photos, and removing one frees a slot", async () => {
  const bucket = fakeBucket();
  for (let index = 0; index < MAX_HOSTEL_PHOTOS_PER_PROPERTY; index += 1) {
    await storeHostelPhoto({
      landlordId: "landlord-a", propertyId: "property-c", caption: `Photo ${index + 1}`, contentType: "image/png",
      body: bytes(`png-${index}`), actor: "owusu@example.com", bucket,
    });
  }
  const crowded = await listHostelPhotosForLandlord("landlord-a", "property-c");
  assert.equal(crowded.length, MAX_HOSTEL_PHOTOS_PER_PROPERTY);
  assert.deepEqual(crowded.map((photo) => photo.sortOrder), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

  await assert.rejects(
    () => storeHostelPhoto({
      landlordId: "landlord-a", propertyId: "property-c", contentType: "image/png",
      body: bytes("one-too-many"), actor: "owusu@example.com", bucket,
    }),
    (error) => error?.code === "INVALID_STATE" && error.status === 409,
  );

  const removed = await deleteHostelPhoto({ landlordId: "landlord-a", photoId: crowded[0].id, actor: "owusu@example.com", bucket });
  assert.equal(removed.id, crowded[0].id);
  assert.equal(bucket.objects.has(hostelPhotoKey("landlord-a", "property-c", crowded[0].id)), false, "the object goes with the row");
  assert.equal((await listHostelPhotosForLandlord("landlord-a", "property-c")).length, MAX_HOSTEL_PHOTOS_PER_PROPERTY - 1);
  await storeHostelPhoto({
    landlordId: "landlord-a", propertyId: "property-c", contentType: "image/png",
    body: bytes("replacement"), actor: "owusu@example.com", bucket,
  });
  assert.equal((await listHostelPhotosForLandlord("landlord-a", "property-c")).length, MAX_HOSTEL_PHOTOS_PER_PROPERTY);
});

test("the landlord picks the cover, and only approved photos can be it", async () => {
  const bucket = fakeBucket();
  const first = await upload({ propertyId: "property-d", bucket });
  const second = await upload({ propertyId: "property-d", caption: "Back yard", bucket });
  await reviewHostelPhoto({ photoId: first.id, action: "APPROVE", actor: "admin@umat.edu.gh" });
  await reviewHostelPhoto({ photoId: second.id, action: "APPROVE", actor: "admin@umat.edu.gh" });

  const before = await listApprovedPhotoCovers(["property-d"]);
  assert.equal(before.get("property-d")?.id, first.id, "the first approved photo is the default cover");

  const chosen = await updateHostelPhoto({ landlordId: "landlord-a", photoId: second.id, caption: "Back yard at dusk", cover: true });
  assert.equal(chosen.caption, "Back yard at dusk");
  const after = await listApprovedPhotoCovers(["property-d"]);
  assert.equal(after.get("property-d")?.id, second.id);

  // Another landlord cannot touch it, caption or cover.
  await assert.rejects(
    () => updateHostelPhoto({ landlordId: "landlord-b", photoId: second.id, caption: "Hijacked" }),
    (error) => error?.code === "NOT_FOUND",
  );
  assert.equal((await getHostelPhoto(second.id)).caption, "Back yard at dusk");
});

test("the bytes come back with the stored content type", async () => {
  const bucket = fakeBucket();
  const photo = await storeHostelPhoto({
    landlordId: "landlord-b", propertyId: "property-e", caption: "Room with a view", contentType: "image/png",
    body: bytes("image-bytes"), actor: "mensah@example.com", bucket,
  });
  await reviewHostelPhoto({ photoId: photo.id, action: "APPROVE", actor: "admin@umat.edu.gh" });

  const object = await readHostelPhotoObject(photo, bucket);
  assert.equal(object.httpMetadata.contentType, "image/png");
  assert.ok(object.body, "the body is a stream, not a buffer");
  await assert.rejects(
    () => readHostelPhotoObject(photo, fakeBucket()),
    (error) => error?.code === "NOT_FOUND",
    "an approved row with no stored object cannot be served",
  );
});

test("the public route serves a photo only once it is approved", async () => {
  const pending = await upload({ propertyId: "property-a", caption: "Not reviewed yet" });
  const before = await publicPhotoRoute.GET(new Request(`https://umatexpress.test/api/hostel/photos/${pending.id}`), params(pending.id));
  assert.equal(before.status, 404, "a pending photo has no public URL");
  assert.equal((await before.json()).code, "NOT_FOUND");

  const missing = await publicPhotoRoute.GET(new Request("https://umatexpress.test/api/hostel/photos/does-not-exist"), params("does-not-exist"));
  assert.equal(missing.status, 404);
});

test("the gallery and the review queue are behind their console roles", async () => {
  const gallery = await landlordPhotosRoute.GET(new Request("https://console.umatexpress.test/api/console/hostel/photos"));
  assert.equal(gallery.status, 401, "the landlord gallery needs a landlord session");

  const queue = await photoReviewRoute.GET(new Request("https://console.umatexpress.test/api/console/hostel/photos/review"));
  assert.equal(queue.status, 401, "the review queue is staff-only");

  const decide = await photoReviewRoute.PATCH(new Request("https://console.umatexpress.test/api/console/hostel/photos/review", {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ photoId: "x", action: "APPROVE" }),
  }));
  assert.equal(decide.status, 401);
});
