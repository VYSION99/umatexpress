import { bedAvailableSql } from "./inventory";
import { ensureHostelResidencyTables } from "./residency";
import { CampusEngineError } from "@/lib/campus-engine/errors";
import { consoleAudit } from "@/lib/console-audit";
import { ensureHostelTables, getHostelProperty } from "@/lib/hostel-engine/landlord";
import { ownerReadiness } from "@/lib/hostel-engine/onboarding";
import { rowsToObjects, turso, tursoTransaction } from "@/lib/turso";

const SEPARATE_BEDS = ["Bed A", "Bed B", "Bed C", "Bed D", "Bed E", "Bed F"];
const BUNK_BEDS = ["Bunk 1 lower", "Bunk 1 upper", "Bunk 2 lower", "Bunk 2 upper", "Bunk 3 lower", "Bunk 3 upper"];
export const ROOM_BATCH_SIZE = 20;

function whole(value: unknown, min: number, max: number, message: string) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new CampusEngineError("VALIDATION_ERROR", message, 400);
  return number;
}

/** One request is one atomic batch; a client can chain batches for a longer range. */
export async function createHostelRoomBatch(landlordId: string, input: {
  propertyId?: unknown; prefix?: unknown; start?: unknown; end?: unknown; width?: unknown;
  capacity?: unknown; bedLayout?: unknown; utilitiesFee?: unknown; amenities?: unknown;
  periodId?: unknown; price?: unknown;
}) {
  await ensureHostelTables();
  await ensureHostelResidencyTables();
  const propertyId = String(input.propertyId || "").trim();
  await getHostelProperty(landlordId, propertyId);
  const prefix = String(input.prefix || "").trim();
  if (!prefix || prefix.length > 18) throw new CampusEngineError("VALIDATION_ERROR", "Enter a room name prefix under 19 characters.", 400);
  const start = whole(input.start, 1, 9999, "Start the range at a room number from 1 to 9999.");
  const end = whole(input.end, start, 9999, "Choose an ending room number at or after the start.");
  if (end - start + 1 > ROOM_BATCH_SIZE) throw new CampusEngineError("VALIDATION_ERROR", `Create up to ${ROOM_BATCH_SIZE} rooms in each batch.`, 400);
  const width = whole(input.width ?? String(end).length, 1, 4, "Choose a number width from 1 to 4 digits.");
  const capacity = whole(input.capacity, 1, 6, "A room holds between 1 and 6 student beds.");
  const bedLayout = String(input.bedLayout || "SEPARATE").toUpperCase();
  if (bedLayout !== "SEPARATE" && bedLayout !== "BUNK") throw new CampusEngineError("VALIDATION_ERROR", "Choose separate beds or bunk beds.", 400);
  if (bedLayout === "BUNK" && capacity % 2) throw new CampusEngineError("VALIDATION_ERROR", "Bunk rooms need 2, 4 or 6 student bed spaces.", 400);
  const utilitiesFee = whole(input.utilitiesFee ?? 0, 0, 1_000_000, "The utilities fee per bed must be between GH₵0 and GH₵10,000.");
  const amenities = String(input.amenities || "").trim();
  if (amenities.length > 200) throw new CampusEngineError("VALIDATION_ERROR", "Keep amenities under 200 characters.", 400);
  const labels = Array.from({ length: end - start + 1 }, (_, index) => `${prefix} ${String(start + index).padStart(width, "0")}`);
  if (labels.some(label => label.length > 24)) throw new CampusEngineError("VALIDATION_ERROR", "The room name plus number must fit within 24 characters.", 400);
  const periodId = String(input.periodId || "").trim();
  const pricing = periodId || input.price !== undefined && input.price !== null && input.price !== "";
  let price = 0;
  if (pricing) {
    if (!periodId) throw new CampusEngineError("VALIDATION_ERROR", "Choose an academic year for the shared rent.", 400);
    price = whole(input.price, 100, 5_000_000, "Enter annual rent per bed between GH₵1 and GH₵50,000.");
    const owner = await ownerReadiness(landlordId);
    if (owner.identityStatus !== "VERIFIED") throw new CampusEngineError("INVALID_STATE", "Owner identity must be approved before pricing rooms.", 409);
    const period = rowsToObjects(await turso("SELECT id,COALESCE(active,1) AS active FROM hostel_periods WHERE id=? LIMIT 1", [periodId]))[0];
    if (!period) throw new CampusEngineError("NOT_FOUND", "That academic year was not found.", 404);
    if (Number(period.active) !== 1) throw new CampusEngineError("INVALID_STATE", "That academic year is closed.", 409);
  }
  const placeholders = labels.map(() => "?").join(",");
  const existing = rowsToObjects(await turso(`SELECT id,label,capacity,utilities_fee,amenities,bed_layout,status FROM hostel_rooms WHERE property_id=? AND label IN (${placeholders})`, [propertyId, ...labels]));
  const existingByLabel = new Map(existing.map(row => [String(row.label), row]));
  const already = [] as string[];
  const fresh = [] as string[];
  for (const label of labels) {
    const row = existingByLabel.get(label);
    if (!row) { fresh.push(label); continue; }
    if (String(row.status) !== "ACTIVE" || Number(row.capacity) !== capacity || Number(row.utilities_fee) !== utilitiesFee || String(row.amenities || "") !== amenities || String(row.bed_layout || "SEPARATE") !== bedLayout) {
      throw new CampusEngineError("CONFLICT", `${label} already exists with different room details. Change the range or edit that room.`, 409);
    }
    if (pricing) {
      const listings = rowsToObjects(await turso(`SELECT l.price,l.status FROM hostel_listings l JOIN hostel_spaces s ON s.id=l.space_id WHERE s.room_id=? AND l.period_id=? AND s.status<>'RETIRED'`, [String(row.id), periodId]));
      if (listings.length !== capacity || listings.some(listing => Number(listing.price) !== price)) {
        throw new CampusEngineError("CONFLICT", `${label} already exists with a different or incomplete annual rate. Review its beds before retrying.`, 409);
      }
    }
    already.push(label);
  }
  if (!fresh.length) return { created: 0, skipped: already.length, labels, bedCount: capacity, priced: Boolean(pricing) };
  const stamp = new Date().toISOString();
  const statements: Array<{ sql: string; args: Array<string | number | null> }> = [];
  for (const label of fresh) {
    const roomId = crypto.randomUUID();
    statements.push({ sql: "INSERT INTO hostel_rooms (id,property_id,label,capacity,utilities_fee,amenities,bed_layout,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'ACTIVE',?,?)", args: [roomId, propertyId, label, capacity, utilitiesFee, amenities, bedLayout, stamp, stamp] });
    for (const bedLabel of (bedLayout === "BUNK" ? BUNK_BEDS : SEPARATE_BEDS).slice(0, capacity)) {
      const spaceId = crypto.randomUUID();
      statements.push({ sql: "INSERT INTO hostel_spaces (id,room_id,label,status,created_at,updated_at) VALUES (?,?,?,'AVAILABLE',?,?)", args: [spaceId, roomId, bedLabel, stamp, stamp] });
      if (pricing) statements.push({ sql: "INSERT INTO hostel_listings (id,space_id,period_id,price,status,review_reason,submitted_at,reviewed_at,reviewed_by,created_at,updated_at) VALUES (?,?,?,?,'DRAFT','','','','',?,?)", args: [crypto.randomUUID(), spaceId, periodId, price, stamp, stamp] });
    }
  }
  statements.push({ sql: "UPDATE hostel_properties SET status='DRAFT',updated_at=? WHERE id=? AND landlord_id=? AND status='APPROVED'", args: [stamp, propertyId, landlordId] });
  try { await tursoTransaction(statements); }
  catch (error) {
    if (error instanceof Error && /unique constraint/i.test(error.message)) throw new CampusEngineError("CONFLICT", "A room in this range was added at the same time. Refresh and retry.", 409);
    throw error;
  }
  await consoleAudit({ actor: landlordId, action: "HOSTEL_ROOMS_BATCH_CREATED", targetType: "hostel_property", targetReference: propertyId, details: { first: fresh[0], last: fresh.at(-1), created: fresh.length, skipped: already.length, capacity, periodId: pricing ? periodId : "", price: pricing ? price : 0 } }).catch(() => undefined);
  return { created: fresh.length, skipped: already.length, labels, bedCount: capacity, priced: Boolean(pricing) };
}

/** Reprice up to twenty existing numbered rooms together, preserving every bed-level safety gate. */
export async function priceHostelRoomRange(landlordId: string, input: {
  propertyId?: unknown; prefix?: unknown; start?: unknown; end?: unknown; width?: unknown;
  periodId?: unknown; price?: unknown;
}) {
  await ensureHostelTables();
  await ensureHostelResidencyTables();
  const propertyId = String(input.propertyId || "").trim();
  await getHostelProperty(landlordId, propertyId);
  const prefix = String(input.prefix || "").trim();
  if (!prefix || prefix.length > 18) throw new CampusEngineError("VALIDATION_ERROR", "Enter a room name prefix under 19 characters.", 400);
  const start = whole(input.start, 1, 9999, "Start the range at a room number from 1 to 9999.");
  const end = whole(input.end, start, 9999, "Choose an ending room number at or after the start.");
  if (end - start + 1 > ROOM_BATCH_SIZE) throw new CampusEngineError("VALIDATION_ERROR", `Price up to ${ROOM_BATCH_SIZE} rooms in each batch.`, 400);
  const width = whole(input.width ?? String(end).length, 1, 4, "Choose a number width from 1 to 4 digits.");
  const labels = Array.from({ length: end - start + 1 }, (_, index) => `${prefix} ${String(start + index).padStart(width, "0")}`);
  const periodId = String(input.periodId || "").trim();
  if (!periodId) throw new CampusEngineError("VALIDATION_ERROR", "Choose an academic year.", 400);
  const price = whole(input.price, 100, 5_000_000, "Enter annual rent per bed between GH₵1 and GH₵50,000.");
  const owner = await ownerReadiness(landlordId);
  if (owner.identityStatus !== "VERIFIED") throw new CampusEngineError("INVALID_STATE", "Owner identity must be approved before pricing rooms.", 409);
  const period = rowsToObjects(await turso("SELECT id,COALESCE(active,1) AS active FROM hostel_periods WHERE id=? LIMIT 1", [periodId]))[0];
  if (!period) throw new CampusEngineError("NOT_FOUND", "That academic year was not found.", 404);
  if (Number(period.active) !== 1) throw new CampusEngineError("INVALID_STATE", "That academic year is closed.", 409);
  const rooms = rowsToObjects(await turso(`SELECT id,label,status FROM hostel_rooms WHERE property_id=? AND label IN (${labels.map(() => "?").join(",")})`, [propertyId, ...labels]));
  const byLabel = new Map(rooms.map(row => [String(row.label), row]));
  for (const label of labels) {
    const room = byLabel.get(label);
    if (!room) throw new CampusEngineError("NOT_FOUND", `${label} was not found in this property. Check the range before pricing.`, 404);
    if (String(room.status) !== "ACTIVE") throw new CampusEngineError("INVALID_STATE", `${label} is retired and cannot be priced.`, 409);
  }
  const ids = rooms.map(room => String(room.id));
  const spaces = rowsToObjects(await turso(`SELECT s.room_id,s.id AS space_id,CASE WHEN ${bedAvailableSql('s',"'"+periodId.replaceAll("'","''")+"'")} THEN 'AVAILABLE' ELSE 'UNAVAILABLE' END AS space_status,l.id AS listing_id,l.price,l.status AS listing_status
    FROM hostel_spaces s LEFT JOIN hostel_listings l ON l.space_id=s.id AND l.period_id=?
    WHERE s.room_id IN (${ids.map(() => "?").join(",")}) AND s.status<>'RETIRED'`, [periodId, ...ids]));
  const byRoom = new Map<string, Record<string, unknown>[]>();
  for (const space of spaces) byRoom.set(String(space.room_id), [...(byRoom.get(String(space.room_id)) || []), space]);
  const stamp = new Date().toISOString();
  const statements: Array<{ sql: string; args: Array<string | number | null> }> = [];
  for (const label of labels) {
    const room = byLabel.get(label)!;
    const beds = byRoom.get(String(room.id)) || [];
    if (!beds.length) throw new CampusEngineError("INVALID_STATE", `${label} has no active beds.`, 409);
    for (const bed of beds) {
      const listingId = String(bed.listing_id || "");
      if (listingId && Number(bed.price) === price) continue;
      if (String(bed.space_status) !== "AVAILABLE") throw new CampusEngineError("INVALID_STATE", `${label} has a held or occupied bed at another price. Use the next academic year.`, 409);
      if (String(bed.listing_status) === "SUSPENDED") throw new CampusEngineError("INVALID_STATE", `${label} has a suspended bed; staff must review it before repricing.`, 409);
      if (!listingId) statements.push({ sql: "INSERT INTO hostel_listings (id,space_id,period_id,price,status,review_reason,submitted_at,reviewed_at,reviewed_by,created_at,updated_at) VALUES (?,?,?,?,'DRAFT','','','','',?,?)", args: [crypto.randomUUID(), String(bed.space_id), periodId, price, stamp, stamp] });
      else statements.push({ sql: "UPDATE hostel_listings SET price=?,status='DRAFT',review_reason='',submitted_at='',reviewed_at='',reviewed_by='',updated_at=? WHERE id=? AND status<>'SUSPENDED'", args: [price, stamp, listingId] });
    }
  }
  if (statements.length) await tursoTransaction(statements);
  await consoleAudit({ actor: landlordId, action: "HOSTEL_ROOM_RATES_BATCH_SET", targetType: "hostel_property", targetReference: propertyId, details: { first: labels[0], last: labels.at(-1), rooms: labels.length, bedsChanged: statements.length, periodId, price } }).catch(() => undefined);
  return { rooms: labels.length, changed: statements.length, periodId, price };
}

/** Submit eligible draft beds in a numbered range for staff review. */
export async function submitHostelRoomRange(landlordId: string, input: {
  propertyId?: unknown; prefix?: unknown; start?: unknown; end?: unknown; width?: unknown; periodId?: unknown;
}) {
  await ensureHostelTables();
  await ensureHostelResidencyTables();
  const propertyId = String(input.propertyId || "").trim();
  const property = await getHostelProperty(landlordId, propertyId);
  const owner = await ownerReadiness(landlordId);
  if (owner.identityStatus !== "VERIFIED" || owner.profileStatus !== "APPROVED") throw new CampusEngineError("INVALID_STATE", "Owner identity and account details must be approved before submitting listings.", 409);
  if (property.status !== "APPROVED") throw new CampusEngineError("INVALID_STATE", "This property must be approved before its beds can be submitted.", 409);
  const prefix = String(input.prefix || "").trim();
  if (!prefix || prefix.length > 18) throw new CampusEngineError("VALIDATION_ERROR", "Enter a room name prefix under 19 characters.", 400);
  const start = whole(input.start, 1, 9999, "Start the range at a room number from 1 to 9999.");
  const end = whole(input.end, start, 9999, "Choose an ending room number at or after the start.");
  if (end - start + 1 > ROOM_BATCH_SIZE) throw new CampusEngineError("VALIDATION_ERROR", `Submit up to ${ROOM_BATCH_SIZE} rooms in each batch.`, 400);
  const width = whole(input.width ?? String(end).length, 1, 4, "Choose a number width from 1 to 4 digits.");
  const labels = Array.from({ length: end - start + 1 }, (_, index) => `${prefix} ${String(start + index).padStart(width, "0")}`);
  const periodId = String(input.periodId || "").trim();
  if (!periodId) throw new CampusEngineError("VALIDATION_ERROR", "Choose an academic year.", 400);
  const period = rowsToObjects(await turso("SELECT id,COALESCE(active,1) AS active FROM hostel_periods WHERE id=? LIMIT 1", [periodId]))[0];
  if (!period || Number(period.active) !== 1) throw new CampusEngineError("INVALID_STATE", "That academic year is closed to new listings.", 409);
  const rows = rowsToObjects(await turso(`SELECT r.label,r.status AS room_status,CASE WHEN ${bedAvailableSql('s',"'"+periodId.replaceAll("'","''")+"'")} THEN 'AVAILABLE' ELSE 'UNAVAILABLE' END AS space_status,l.id AS listing_id,l.status AS listing_status,l.price
    FROM hostel_rooms r JOIN hostel_spaces s ON s.room_id=r.id
    LEFT JOIN hostel_listings l ON l.space_id=s.id AND l.period_id=?
    WHERE r.property_id=? AND r.label IN (${labels.map(() => "?").join(",")}) AND s.status<>'RETIRED'`, [periodId, propertyId, ...labels]));
  const byLabel = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) byLabel.set(String(row.label), [...(byLabel.get(String(row.label)) || []), row]);
  const draftIds: string[] = [];
  let skipped = 0;
  for (const label of labels) {
    const beds = byLabel.get(label);
    if (!beds?.length) throw new CampusEngineError("INVALID_STATE", `${label} has no active beds or does not exist.`, 409);
    for (const bed of beds) {
      if (String(bed.room_status) !== "ACTIVE" || String(bed.space_status) !== "AVAILABLE") throw new CampusEngineError("INVALID_STATE", `${label} has a held or occupied bed. Resolve it before submission.`, 409);
      if (!bed.listing_id) throw new CampusEngineError("INVALID_STATE", `${label} has an unpriced bed. Set one annual room rate before submission.`, 409);
      const status = String(bed.listing_status);
      if (status === "DRAFT") {
        if (Number(bed.price) < 100) throw new CampusEngineError("INVALID_STATE", `${label} has a bed without a valid price.`, 409);
        draftIds.push(String(bed.listing_id));
      } else if (status === "PENDING_REVIEW" || status === "APPROVED") skipped++;
      else throw new CampusEngineError("INVALID_STATE", `${label} has a suspended bed; staff must review it separately.`, 409);
    }
  }
  if (draftIds.length) {
    const stamp = new Date().toISOString();
    await tursoTransaction(draftIds.map(id => ({ sql: "UPDATE hostel_listings SET status='PENDING_REVIEW',submitted_at=?,review_reason='',updated_at=? WHERE id=? AND status='DRAFT'", args: [stamp, stamp, id] })));
    await consoleAudit({ actor: landlordId, action: "HOSTEL_LISTINGS_BATCH_SUBMITTED", targetType: "hostel_property", targetReference: propertyId, details: { first: labels[0], last: labels.at(-1), periodId, submitted: draftIds.length } }).catch(() => undefined);
    void import("@/lib/hostel-engine/signals").then(({ scanHostelSignals }) => scanHostelSignals()).catch(() => undefined);
  }
  return { rooms: labels.length, submitted: draftIds.length, skipped };
}
