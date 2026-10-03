import { bedAvailableSql } from "./inventory";
import { ensureHostelResidencyTables } from "./residency";
import { CampusEngineError } from "@/lib/campus-engine/errors";
import { ensureHostelOnboardingTables, ownerReadiness } from "@/lib/hostel-engine/onboarding";
import { consoleAudit } from "@/lib/console-audit";
import { distanceToCampusMeters, isCoordinate } from "@/lib/hostel-engine/geo";
import { listApprovedHostelPhotos, listApprovedPhotoCovers } from "@/lib/hostel-engine/photos";
import { listPropertyReviews, reviewSummaryForProperties } from "@/lib/hostel-engine/reviews";
import { notifyParty, providerListingNotice } from "@/lib/notify-templates";
import { rowsToObjects, turso, tursoTransaction } from "@/lib/turso";

/**
 * Listing one bed for one academic year, and the review that decides whether
 * students ever see it.
 *
 *  DRAFT ─▶ PENDING_REVIEW ─▶ APPROVED ─▶ SUSPENDED
 *    ▲            │
 *    └── reject ──┘        an edit sends a listing back to draft
 *
 * A bed reaches students only after its own listing is approved. An approved
 * property can be browsed while listings are still in review. Ownership travels
 * through space → room → property to the signed-in landlord, exactly like the
 * workspace that built those rows.
 */

export const HOSTEL_LISTING_STATUSES = ["DRAFT", "PENDING_REVIEW", "APPROVED", "SUSPENDED"] as const;
export type HostelListingStatus = (typeof HOSTEL_LISTING_STATUSES)[number];

export type HostelListing = {
  id: string;
  spaceId: string;
  periodId: string;
  price: number;
  status: HostelListingStatus;
  reviewReason: string;
  submittedAt: string;
  reviewedAt: string;
  reviewedBy: string;
  createdAt: string;
  updatedAt: string;
};

/** A listing with the labels the landlord's own table needs. */
export type LandlordListing = HostelListing & {
  propertyId: string;
  propertyName: string;
  roomLabel: string;
  spaceLabel: string;
  periodName: string;
  periodStartsOn: string;
  periodActive: boolean;
};

/** A listing with the people and places a reviewer has to weigh. */
export type ReviewListing = LandlordListing & {
  landlordId: string;
  landlordName: string;
  landlordPhone: string;
  landlordKycStatus: string;
  propertyStatus: string;
};

/** What a signed-out visitor may see: an approved bed and what it costs. */
export type PublicSpace = {
  listingId: string;
  spaceId: string;
  roomId: string;
  roomLabel: string;
  spaceLabel: string;
  capacity: number;
  bedLayout: "SEPARATE" | "BUNK";
  price: number;
  utilitiesFee: number;
  total: number;
};

/** An approved building a signed-out visitor may browse, with available beds when reviewed. */
export type PublicProperty = {
  id: string;
  name: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  /** Metres from campus: what the landlord declared, else measured from the pin. */
  distanceM: number | null;
  utilitiesEnabled: boolean;
  /** Approved, physically available beds in the open year; zero while listings await review. */
  availableSpaces: number;
  /** Whether the owner's current payout destination has passed staff review. */
  bookingReady: boolean;
  roomCount: number;
  /** Yearly rent in pesewas, before utilities. */
  minPrice: number;
  /** What the cheapest bed costs with the utilities the student would pay. */
  minTotal: number;
  /** The landlord's first approved photo, or null while none has passed review. */
  coverPhotoId: string | null;
  /** Published review score, or 0 while nothing has been reviewed. */
  ratingAverage: number;
  ratingCount: number;
};

/** The filters the browse page may ask for, all optional. */
export type PublicPropertyQuery = {
  periodId?: string;
  propertyId?: string;
  propertyIds?: string[];
  q?: string;
  page?: number;
  pageSize?: number;
  enrich?: boolean;
  maxDistanceM?: number;
  maxPrice?: number;
  minSpaces?: number;
  utilitiesOnly?: boolean;
  sort?: "distance" | "price" | "name";
};

/** A year's rent in whole pesewas: GH₵1 at the floor, GH₵50,000 at the ceiling. */
const MIN_LISTING_PRICE = 100;
const MAX_LISTING_PRICE = 5_000_000;

const LISTING_COLUMNS = "l.id,l.space_id,l.period_id,l.price,COALESCE(l.status,'DRAFT') AS status,COALESCE(l.review_reason,'') AS review_reason,COALESCE(l.submitted_at,'') AS submitted_at,COALESCE(l.reviewed_at,'') AS reviewed_at,COALESCE(l.reviewed_by,'') AS reviewed_by,l.created_at,l.updated_at";

const LISTING_JOINS = `FROM hostel_listings l
  JOIN hostel_spaces s ON s.id = l.space_id
  JOIN hostel_rooms r ON r.id = s.room_id
  JOIN hostel_properties p ON p.id = r.property_id
  LEFT JOIN hostel_periods pe ON pe.id = l.period_id`;

function listingView(row: Record<string, unknown>): HostelListing {
  return {
    id: String(row.id || ""),
    spaceId: String(row.space_id || ""),
    periodId: String(row.period_id || ""),
    price: Number(row.price ?? 0),
    status: String(row.status || "DRAFT") as HostelListingStatus,
    reviewReason: String(row.review_reason || ""),
    submittedAt: String(row.submitted_at || ""),
    reviewedAt: String(row.reviewed_at || ""),
    reviewedBy: String(row.reviewed_by || ""),
    createdAt: String(row.created_at || ""),
    updatedAt: String(row.updated_at || ""),
  };
}

function landlordListingView(row: Record<string, unknown>): LandlordListing {
  return {
    ...listingView(row),
    propertyId: String(row.property_id || ""),
    propertyName: String(row.property_name || ""),
    roomLabel: String(row.room_label || ""),
    spaceLabel: String(row.space_label || ""),
    periodName: String(row.period_name || ""),
    periodStartsOn: String(row.period_starts_on || ""),
    periodActive: Number(row.period_active ?? 0) === 1,
  };
}

function reviewListingView(row: Record<string, unknown>): ReviewListing {
  return {
    ...landlordListingView(row),
    landlordId: String(row.landlord_id || ""),
    landlordName: String(row.landlord_name || ""),
    landlordPhone: String(row.landlord_phone || ""),
    landlordKycStatus: String(row.landlord_kyc_status || "PENDING"),
    propertyStatus: String(row.property_status || "DRAFT"),
  };
}

/**
 * The bed as the landlord built it, for a message about it: a review decision
 * is read by the person who owns the row, so it names the building, the room
 * and the bed instead of a listing id they have never seen.
 */
function listingLabel(row: Record<string, unknown>) {
  return [row.property_name, row.room_label, row.space_label]
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join(" · ");
}

function requiredId(value: unknown, label: string) {
  const text = String(value ?? "").trim();
  if (!text || text.length > 80) throw new CampusEngineError("VALIDATION_ERROR", `Choose a ${label}.`, 400);
  return text;
}

function priceInPesewas(value: unknown) {
  const price = Number(value);
  if (!Number.isInteger(price) || price < MIN_LISTING_PRICE || price > MAX_LISTING_PRICE) {
    throw new CampusEngineError("VALIDATION_ERROR", "Enter the yearly rent in whole pesewas, between GH₵1 and GH₵50,000.", 400);
  }
  return price;
}

function statusLabel(status: string) {
  return status.toLowerCase().replace("_", " ");
}

/**
 * One listing, scoped through its bed to the signed-in landlord. The property
 * id is in the WHERE clause, so a valid listing id is never a permission.
 */
async function ownedListingRow(landlordId: string, listingId: string) {
  const row = rowsToObjects(await turso(
    `SELECT ${LISTING_COLUMNS},
       COALESCE(s.status,'AVAILABLE') AS space_status,
       COALESCE(r.status,'ACTIVE') AS room_status,
       p.id AS property_id,p.name AS property_name,COALESCE(p.status,'DRAFT') AS property_status,
       COALESCE(pe.name,'') AS period_name,COALESCE(pe.starts_on,'') AS period_starts_on,COALESCE(pe.active,0) AS period_active
     ${LISTING_JOINS}
     WHERE l.id = ? AND p.landlord_id = ? LIMIT 1`,
    [listingId, landlordId],
  ))[0];
  if (!row) throw new CampusEngineError("NOT_FOUND", "That listing does not belong to your account.", 404);
  return row;
}

export async function getHostelListing(landlordId: string, listingId: string): Promise<HostelListing> {
  await ensureHostelResidencyTables();
  return listingView(await ownedListingRow(landlordId, listingId));
}

/**
 * Prices a bed for a year. The bed must be the landlord's own, in a live room,
 * and the year must still be open — a listing is a promise the landlord can
 * keep, so the form refuses to record one they cannot.
 */
export async function createHostelListing(landlordId: string, input: {
  spaceId?: unknown; periodId?: unknown; price?: unknown;
}): Promise<LandlordListing> {
  await ensureHostelResidencyTables();
  const spaceId = requiredId(input.spaceId, "bed");
  const periodId = requiredId(input.periodId, "academic year");
  const price = priceInPesewas(input.price);

  const space = rowsToObjects(await turso(
    `SELECT s.id AS space_id,s.room_id,COALESCE(s.status,'AVAILABLE') AS space_status,r.label AS room_label,COALESCE(r.status,'ACTIVE') AS room_status
     FROM hostel_spaces s JOIN hostel_rooms r ON r.id = s.room_id JOIN hostel_properties p ON p.id = r.property_id
     WHERE s.id = ? AND p.landlord_id = ? LIMIT 1`,
    [spaceId, landlordId],
  ))[0];
  if (!space) throw new CampusEngineError("NOT_FOUND", "That bed does not belong to your account.", 404);
  const owner = await ownerReadiness(landlordId);
  if (owner.identityStatus !== "VERIFIED") throw new CampusEngineError("INVALID_STATE", "Owner identity must be approved before creating bed listings.", 409);
  if (String(space.room_status) !== "ACTIVE" || !rowsToObjects(await turso(`SELECT s.id FROM hostel_spaces s WHERE s.id=? AND ${bedAvailableSql('s','?')}`, [spaceId,periodId,periodId,periodId])).length) {
    throw new CampusEngineError("INVALID_STATE", "Only a free bed can be listed. That one is retired or already belongs to a resident.", 409);
  }

  const period = rowsToObjects(await turso("SELECT id,name,COALESCE(active,1) AS active FROM hostel_periods WHERE id = ? LIMIT 1", [periodId]))[0];
  if (!period) throw new CampusEngineError("NOT_FOUND", "That academic year was not found.", 404);
  if (Number(period.active) !== 1) {
    throw new CampusEngineError("INVALID_STATE", `${String(period.name)} is closed to new listings.`, 409);
  }

  const sibling = rowsToObjects(await turso(`SELECT l.price FROM hostel_listings l JOIN hostel_spaces s ON s.id=l.space_id
    WHERE s.room_id=? AND l.period_id=? AND l.price<>? LIMIT 1`, [String(space.room_id), periodId, price]))[0];
  if (sibling) throw new CampusEngineError("INVALID_STATE", "All beds in one room must have the same rent for the academic year. Change the room rate instead.", 409);

  const existing = rowsToObjects(await turso(
    "SELECT id,COALESCE(status,'DRAFT') AS status FROM hostel_listings WHERE space_id = ? AND period_id = ? LIMIT 1",
    [spaceId, periodId],
  ))[0];
  if (existing) {
    throw new CampusEngineError("CONFLICT", `That bed already has a ${statusLabel(String(existing.status))} listing for ${String(period.name)}. Edit the listing you have.`, 409);
  }

  const stamp = new Date().toISOString();
  const id = crypto.randomUUID();
  await turso(
    "INSERT INTO hostel_listings (id,space_id,period_id,price,status,review_reason,submitted_at,reviewed_at,reviewed_by,created_at,updated_at) VALUES (?,?,?,?,'DRAFT','','','','',?,?)",
    [id, spaceId, periodId, price, stamp, stamp],
  );
  await consoleAudit({
    actor: landlordId,
    action: "HOSTEL_LISTING_CREATED",
    targetType: "hostel_listing",
    targetReference: id,
    details: { spaceId, periodId, price },
  }).catch(() => undefined);
  return landlordListingView(await ownedListingRow(landlordId, id));
}

/** One annual rent per student bed, shared by every active bed in a room. */
export async function setHostelRoomRate(landlordId: string, input: { roomId?: unknown; periodId?: unknown; price?: unknown }) {
  await ensureHostelResidencyTables();
  const roomId = requiredId(input.roomId, "room");
  const periodId = requiredId(input.periodId, "academic year");
  const price = priceInPesewas(input.price);
  const room = rowsToObjects(await turso(`SELECT r.id,r.label,r.status FROM hostel_rooms r
    JOIN hostel_properties p ON p.id=r.property_id WHERE r.id=? AND p.landlord_id=? LIMIT 1`, [roomId, landlordId]))[0];
  if (!room) throw new CampusEngineError("NOT_FOUND", "That room is not in your property.", 404);
  if (String(room.status) !== "ACTIVE") throw new CampusEngineError("INVALID_STATE", "Retired rooms cannot be priced.", 409);
  const owner = await ownerReadiness(landlordId);
  if (owner.identityStatus !== "VERIFIED") throw new CampusEngineError("INVALID_STATE", "Owner identity must be approved before pricing rooms.", 409);
  const period = rowsToObjects(await turso("SELECT id,name,COALESCE(active,1) AS active FROM hostel_periods WHERE id=? LIMIT 1", [periodId]))[0];
  if (!period) throw new CampusEngineError("NOT_FOUND", "That academic year was not found.", 404);
  if (Number(period.active) !== 1) throw new CampusEngineError("INVALID_STATE", "That academic year is closed.", 409);
  const spaces = rowsToObjects(await turso("SELECT id,status FROM hostel_spaces WHERE room_id=? AND status<>'RETIRED' ORDER BY label COLLATE NOCASE", [roomId]));
  if (!spaces.length) throw new CampusEngineError("INVALID_STATE", "Add active beds to this room first.", 409);
  const existing = rowsToObjects(await turso(`SELECT l.id,l.space_id,l.price,l.status FROM hostel_listings l
    JOIN hostel_spaces s ON s.id=l.space_id WHERE s.room_id=? AND l.period_id=?`, [roomId, periodId]));
  const available = new Set(rowsToObjects(await turso(`SELECT s.id FROM hostel_spaces s WHERE s.room_id=? AND ${bedAvailableSql('s','?')}`, [roomId,periodId,periodId,periodId])).map(row=>String(row.id)));
  const bySpace = new Map(existing.map(row => [String(row.space_id), row]));
  if (existing.some(row => Number(row.price) !== price && String(row.status) === "SUSPENDED")) throw new CampusEngineError("INVALID_STATE", "A suspended bed needs staff review before the room rent can change.", 409);
  if (spaces.some(space => !available.has(String(space.id)) && Number(bySpace.get(String(space.id))?.price) !== price)) throw new CampusEngineError("INVALID_STATE", "The room already has a held or occupied bed at a different rent. Set a new rate for the next academic year.", 409);
  const stamp = new Date().toISOString();
  const statements: Array<{ sql: string; args: Array<string | number | null> }> = [];
  for (const space of spaces) {
    const current = bySpace.get(String(space.id));
    if (!current) {
      if (!available.has(String(space.id))) throw new CampusEngineError("INVALID_STATE", "A held bed cannot receive a new listing.", 409);
      statements.push({ sql: "INSERT INTO hostel_listings (id,space_id,period_id,price,status,review_reason,submitted_at,reviewed_at,reviewed_by,created_at,updated_at) VALUES (?,?,?,?,'DRAFT','','','','',?,?)", args: [crypto.randomUUID(), String(space.id), periodId, price, stamp, stamp] });
    } else if (Number(current.price) !== price) {
      statements.push({ sql: "UPDATE hostel_listings SET price=?,status='DRAFT',review_reason='',submitted_at='',reviewed_at='',reviewed_by='',updated_at=? WHERE id=? AND status<>'SUSPENDED'", args: [price, stamp, String(current.id)] });
    }
  }
  if (statements.length) await tursoTransaction(statements);
  await consoleAudit({ actor: landlordId, action: "HOSTEL_ROOM_RATE_SET", targetType: "hostel_room", targetReference: roomId, details: { periodId, price, affectedBeds: statements.length } }).catch(() => undefined);
  return { roomId, roomLabel: String(room.label), periodId, periodName: String(period.name), price, bedCount: spaces.length, changed: statements.length };
}

/**
 * Repricing is a material change, so an approved or in-review listing goes back
 * to draft and has to be submitted again. A suspended listing stays suspended:
 * an admin took it down, and a landlord cannot lift that with an edit.
 */
export async function updateHostelListing(landlordId: string, listingId: string, input: {
  price?: unknown;
}): Promise<LandlordListing> {
  const price = priceInPesewas(input.price);
  await ensureHostelResidencyTables();
  const row = await ownedListingRow(landlordId, listingId);
  const current = String(row.status || "DRAFT");
  if (current === "SUSPENDED") {
    throw new CampusEngineError("INVALID_STATE", "This listing was suspended by the platform. Contact support before changing it.", 409);
  }
  const siblingPrice = rowsToObjects(await turso(`SELECT l.price FROM hostel_listings l JOIN hostel_spaces s ON s.id=l.space_id
    JOIN hostel_spaces own ON own.room_id=s.room_id WHERE own.id=? AND l.period_id=? AND l.id<>? AND l.price<>? LIMIT 1`, [String(row.space_id), String(row.period_id), listingId, price]))[0];
  if (siblingPrice) throw new CampusEngineError("INVALID_STATE", "Change the room rate so every bed keeps the same annual price.", 409);
  const next = current === "APPROVED" || current === "PENDING_REVIEW" ? "DRAFT" : current;
  await turso(
    "UPDATE hostel_listings SET price=?,status=?,review_reason=?,updated_at=? WHERE id=?",
    [price, next, next === "DRAFT" ? "" : String(row.review_reason || ""), new Date().toISOString(), listingId],
  );
  await consoleAudit({
    actor: landlordId,
    action: "HOSTEL_LISTING_UPDATED",
    targetType: "hostel_listing",
    targetReference: listingId,
    details: { price, from: current, to: next },
  }).catch(() => undefined);
  return landlordListingView(await ownedListingRow(landlordId, listingId));
}

/** The landlord's move: a draft goes to the review queue. */
export async function submitHostelListing(landlordId: string, listingId: string): Promise<HostelListing> {
  await ensureHostelResidencyTables();
  const row = await ownedListingRow(landlordId, listingId);
  const owner = await ownerReadiness(landlordId);
  if (owner.identityStatus !== "VERIFIED" || owner.profileStatus !== "APPROVED") throw new CampusEngineError("INVALID_STATE", "Owner identity and account details must be approved before submitting listings.", 409);
  if (String(row.property_status) !== "APPROVED") throw new CampusEngineError("INVALID_STATE", "This property must be approved separately before its beds can be submitted.", 409);
  const current = String(row.status || "DRAFT");
  if (current === "PENDING_REVIEW") throw new CampusEngineError("INVALID_STATE", "This listing is already with a reviewer.", 409);
  if (current === "APPROVED") throw new CampusEngineError("INVALID_STATE", "This listing is already live.", 409);
  if (current === "SUSPENDED") {
    throw new CampusEngineError("INVALID_STATE", "This listing was suspended by the platform, so it cannot go back for review on its own.", 409);
  }
  if (String(row.room_status) !== "ACTIVE" || !rowsToObjects(await turso(`SELECT s.id FROM hostel_spaces s WHERE s.id=? AND ${bedAvailableSql('s','?')}`, [String(row.space_id),String(row.period_id),String(row.period_id),String(row.period_id)])).length) {
    throw new CampusEngineError("INVALID_STATE", "That bed is retired or already belongs to a resident, so it cannot go back on the market.", 409);
  }
  if (String(row.property_status) === "SUSPENDED") {
    throw new CampusEngineError("INVALID_STATE", "This property is suspended, so its beds cannot be listed.", 409);
  }
  if (Number(row.period_active) !== 1) {
    throw new CampusEngineError("INVALID_STATE", "That academic year is closed to new listings.", 409);
  }

  const stamp = new Date().toISOString();
  await turso(
    "UPDATE hostel_listings SET status='PENDING_REVIEW',submitted_at=?,review_reason='',updated_at=? WHERE id=?",
    [stamp, stamp, listingId],
  );
  await consoleAudit({
    actor: landlordId,
    action: "HOSTEL_LISTING_SUBMITTED",
    targetType: "hostel_listing",
    targetReference: listingId,
    details: { price: Number(row.price || 0) },
  }).catch(() => undefined);
  // The reviewer should see what the rules noticed about this bed. A failed
  // scan must not fail the submission, so it is fired and forgotten.
  void import("@/lib/hostel-engine/signals")
    .then(({ scanHostelSignals }) => scanHostelSignals())
    .catch(() => undefined);
  return { ...listingView(row), status: "PENDING_REVIEW", submittedAt: stamp, reviewReason: "" };
}

/**
 * Withdraws a listing that has not been approved. A live listing is taken down
 * by staff instead, so a landlord cannot pull a bed out from under a student
 * who is already looking at it.
 */
export async function removeHostelListing(landlordId: string, listingId: string) {
  await ensureHostelResidencyTables();
  const row = await ownedListingRow(landlordId, listingId);
  const current = String(row.status || "DRAFT");
  if (current === "APPROVED" || current === "SUSPENDED") {
    throw new CampusEngineError("INVALID_STATE", "A live or suspended listing cannot be withdrawn. Ask the platform to take it down.", 409);
  }
  await turso("DELETE FROM hostel_listings WHERE id = ? AND space_id = ?", [listingId, String(row.space_id)]);
  await consoleAudit({
    actor: landlordId,
    action: "HOSTEL_LISTING_REMOVED",
    targetType: "hostel_listing",
    targetReference: listingId,
    details: { spaceId: String(row.space_id), periodId: String(row.period_id), price: Number(row.price || 0) },
  }).catch(() => undefined);
  return { id: listingId, removed: true };
}

/** The landlord's own listings, one property at a time. */
export async function listHostelListingsForProperty(landlordId: string, propertyId: string): Promise<LandlordListing[]> {
  await ensureHostelResidencyTables();
  const owned = rowsToObjects(await turso("SELECT id FROM hostel_properties WHERE id = ? AND landlord_id = ? LIMIT 1", [propertyId, landlordId]))[0];
  if (!owned) throw new CampusEngineError("NOT_FOUND", "That property does not belong to your account.", 404);
  const rows = rowsToObjects(await turso(
    `SELECT ${LISTING_COLUMNS},
       p.id AS property_id,p.name AS property_name,r.label AS room_label,s.label AS space_label,
       COALESCE(pe.name,'') AS period_name,COALESCE(pe.starts_on,'') AS period_starts_on,COALESCE(pe.active,0) AS period_active
     ${LISTING_JOINS}
     WHERE p.id = ? AND p.landlord_id = ?
     ORDER BY COALESCE(pe.starts_on,'') DESC, r.label COLLATE NOCASE ASC, s.label COLLATE NOCASE ASC`,
    [propertyId, landlordId],
  ));
  return rows.map(landlordListingView);
}

/**
 * The review queue. `PENDING_REVIEW` is the work; `APPROVED` is what is live and
 * suspendable, which is what a moderator opens when a complaint comes in.
 */
export async function listHostelListingsForStaff(status: "PENDING_REVIEW" | "APPROVED" = "PENDING_REVIEW"): Promise<ReviewListing[]> {
  await ensureHostelResidencyTables();
  const rows = rowsToObjects(await turso(
    `SELECT ${LISTING_COLUMNS},
       p.id AS property_id,p.name AS property_name,p.status AS property_status,
       r.label AS room_label,s.label AS space_label,
       COALESCE(pe.name,'') AS period_name,COALESCE(pe.starts_on,'') AS period_starts_on,COALESCE(pe.active,0) AS period_active,
       COALESCE(h.id,'') AS landlord_id,COALESCE(h.organization,h.name,'') AS landlord_name,COALESCE(h.phone,'') AS landlord_phone,COALESCE(h.kyc_status,'PENDING') AS landlord_kyc_status
     ${LISTING_JOINS}
     LEFT JOIN hostel_landlords h ON h.id = p.landlord_id
     WHERE l.status = ?
     ORDER BY ${status === "APPROVED" ? "l.reviewed_at DESC, l.updated_at DESC" : "l.submitted_at ASC, l.updated_at ASC"}`,
    [status],
  ));
  return rows.map(reviewListingView);
}

/** The listing decision requires a separately approved property and owner. */
export async function reviewHostelListing(input: {
  listingId: string;
  action: "APPROVE" | "REJECT" | "SUSPEND";
  reason?: unknown;
  actor: string;
}): Promise<HostelListing> {
  await ensureHostelResidencyTables();
  const listingId = String(input.listingId ?? "").trim();
  if (!listingId) throw new CampusEngineError("VALIDATION_ERROR", "Choose a listing.", 400);
  if (!["APPROVE", "REJECT", "SUSPEND"].includes(input.action)) {
    throw new CampusEngineError("VALIDATION_ERROR", "Choose approve, reject or suspend.", 400);
  }
  const reason = String(input.reason ?? "").trim();

  const row = rowsToObjects(await turso(
    `SELECT ${LISTING_COLUMNS},
       p.id AS property_id,COALESCE(p.status,'DRAFT') AS property_status,p.name AS property_name,
       r.label AS room_label,s.label AS space_label,
       COALESCE(h.id,'') AS landlord_id,COALESCE(h.email,'') AS landlord_email
     ${LISTING_JOINS}
     LEFT JOIN hostel_landlords h ON h.id = p.landlord_id
     WHERE l.id = ? LIMIT 1`,
    [listingId],
  ))[0];
  if (!row) throw new CampusEngineError("NOT_FOUND", "That listing was not found.", 404);

  const current = String(row.status || "DRAFT");
  const transitions: Record<string, { from: string[]; to: HostelListingStatus }> = {
    APPROVE: { from: ["PENDING_REVIEW"], to: "APPROVED" },
    REJECT: { from: ["PENDING_REVIEW"], to: "DRAFT" },
    SUSPEND: { from: ["APPROVED"], to: "SUSPENDED" },
  };
  const transition = transitions[input.action];
  if (!transition.from.includes(current)) {
    throw new CampusEngineError("INVALID_STATE", `A ${statusLabel(current)} listing cannot be ${input.action.toLowerCase()}d.`, 409);
  }
  if ((input.action === "REJECT" || input.action === "SUSPEND") && !reason) {
    throw new CampusEngineError("VALIDATION_ERROR", "Give a reason so the landlord knows what to change.", 400);
  }

  if (input.action === "APPROVE") {
    const owner = await ownerReadiness(String(row.landlord_id));
    if (owner.identityStatus !== "VERIFIED" || owner.profileStatus !== "APPROVED" || String(row.property_status) !== "APPROVED") throw new CampusEngineError("INVALID_STATE", "Approve the owner identity, account and property separately before approving this listing.", 409);
  }

  const stamp = new Date().toISOString();
  await turso(
    "UPDATE hostel_listings SET status=?,review_reason=?,reviewed_at=?,reviewed_by=?,updated_at=? WHERE id=?",
    [transition.to, transition.to === "APPROVED" ? "" : reason, stamp, input.actor, stamp, listingId],
  );

  await consoleAudit({
    actor: input.actor,
    action: `HOSTEL_LISTING_${input.action}`,
    targetType: "hostel_listing",
    targetReference: listingId,
    details: { from: current, to: transition.to, reason },
  }).catch(() => undefined);

  // The landlord is the second party to this decision and is told in the same
  // voice as every other provider: approving a listing, sending one back to
  // draft and suspending a live listing read as three different messages.
  await notifyParty({
    recipient: row.landlord_email,
    reference: listingId,
    notice: providerListingNotice("landlord", input.action, { listing: listingLabel(row), reason }),
  });

  return { ...listingView(row), status: transition.to, reviewReason: transition.to === "APPROVED" ? "" : reason, reviewedAt: stamp, reviewedBy: input.actor };
}

/**
 * What a signed-out visitor may see. Every gate in the platform meets here: the
 * listing is approved, its bed has not been retired, its room is active, and its
 * property has not been suspended. Only AVAILABLE beds pass; held and occupied beds remain hidden.
 */
export async function listPublicSpaces(input: { propertyId?: string; periodId?: string } = {}) {
  await ensureHostelOnboardingTables();
  await ensureHostelResidencyTables();
  const propertyId = String(input.propertyId ?? "").trim();
  const periodId = String(input.periodId ?? "").trim();
  const period = periodId
    ? rowsToObjects(await turso("SELECT id,name,starts_on,ends_on FROM hostel_periods WHERE id = ? AND COALESCE(active,1) = 1 LIMIT 1", [periodId]))[0]
    : rowsToObjects(await turso("SELECT id,name,starts_on,ends_on FROM hostel_periods WHERE COALESCE(active,1) = 1 ORDER BY starts_on DESC LIMIT 1"))[0];
  if (!period) return { period: null, spaces: [] as PublicSpace[] };

  // A bed a student is paying for, or already lives in, is not on offer: only
  // AVAILABLE beds reach the page, which is what keeps two students from paying
  // for the same bed.
  const filters = ["l.period_id = ?", "l.status = 'APPROVED'", bedAvailableSql(), "COALESCE(r.status,'ACTIVE') = 'ACTIVE'", "p.status = 'APPROVED'", "h.status = 'ACTIVE'", "h.kyc_status = 'VERIFIED'", "o.profile_status = 'APPROVED'", "EXISTS (SELECT 1 FROM hostel_property_photos ph WHERE ph.property_id=p.id AND ph.status='APPROVED')"];
  const args: (string | number | null)[] = [String(period.id)];
  if (propertyId) { filters.push("p.id = ?"); args.push(propertyId); }

  const rows = rowsToObjects(await turso(
    `SELECT l.id AS listing_id,s.id AS space_id,r.id AS room_id,r.label AS room_label,s.label AS space_label,r.capacity,COALESCE(r.bed_layout,'SEPARATE') AS bed_layout,l.price,
       COALESCE(r.utilities_fee,0) AS utilities_fee,COALESCE(p.utilities_enabled,0) AS utilities_enabled
     FROM hostel_listings l
     JOIN hostel_spaces s ON s.id = l.space_id
     JOIN hostel_rooms r ON r.id = s.room_id
     JOIN hostel_properties p ON p.id = r.property_id
     JOIN hostel_landlords h ON h.id = p.landlord_id
     JOIN hostel_owner_onboarding o ON o.landlord_id = h.id
     WHERE ${filters.join(" AND ")}
     ORDER BY p.name COLLATE NOCASE ASC, r.label COLLATE NOCASE ASC, s.label COLLATE NOCASE ASC`,
    args,
  ));
  const spaces: PublicSpace[] = rows.map((row) => {
    const price = Number(row.price || 0);
    const utilitiesFee = Number(row.utilities_enabled ?? 0) === 1 ? Number(row.utilities_fee || 0) : 0;
    return {
      listingId: String(row.listing_id || ""),
      spaceId: String(row.space_id || ""),
      roomId: String(row.room_id || ""),
      roomLabel: String(row.room_label || ""),
      spaceLabel: String(row.space_label || ""),
      capacity: Number(row.capacity || 0),
      bedLayout: String(row.bed_layout || "SEPARATE") as "SEPARATE" | "BUNK",
      price,
      utilitiesFee,
      total: price + utilitiesFee,
    };
  });
  return {
    period: { id: String(period.id), name: String(period.name), startsOn: String(period.starts_on), endsOn: String(period.ends_on) },
    spaces,
  };
}

/**
 * Approved buildings are browseable even while their individual bed listings
 * await review. Only approved, available listings supply prices or booking
 * options; payout review still gates booking separately.
 */
export async function listPublicProperties(query: PublicPropertyQuery = {}) {
  await ensureHostelOnboardingTables();
  await ensureHostelResidencyTables();
  const periodId = String(query.periodId ?? "").trim();
  const period = periodId
    ? rowsToObjects(await turso("SELECT id,name,starts_on,ends_on FROM hostel_periods WHERE id = ? AND COALESCE(active,1) = 1 LIMIT 1", [periodId]))[0]
    : rowsToObjects(await turso("SELECT id,name,starts_on,ends_on FROM hostel_periods WHERE COALESCE(active,1) = 1 ORDER BY starts_on DESC LIMIT 1"))[0];
  if (!period) return { period: null, properties: [] as PublicProperty[], mapProperties: [] as PublicProperty[], total: 0, page: 1, pageCount: 0 };

  const clauses: string[] = [];
  const args: Array<string | number | null> = [String(period.id)];
  if (query.propertyId) { clauses.push("p.id = ?"); args.push(query.propertyId); }
  if (query.propertyIds?.length) {
    const ids = [...new Set(query.propertyIds)].slice(0, 4);
    clauses.push(`p.id IN (${ids.map(() => "?").join(",")})`);
    args.push(...ids);
  }
  const search = (query.q || "").trim().slice(0, 100);
  if (search) { clauses.push("(instr(lower(p.name), lower(?)) > 0 OR instr(lower(COALESCE(p.address,'')), lower(?)) > 0)"); args.push(search, search); }
  if (query.utilitiesOnly) clauses.push("COALESCE(p.utilities_enabled,0) = 1");
  const having: string[] = [];
  if (Number.isFinite(query.maxPrice) && query.maxPrice! >= 0) { having.push("min_total <= ?"); args.push(query.maxPrice!); }
  if (Number.isFinite(query.minSpaces) && query.minSpaces! > 1) { having.push("available_spaces >= ?"); args.push(query.minSpaces!); }
  const rows = rowsToObjects(await turso(
    `SELECT p.id AS property_id,p.name AS property_name,COALESCE(p.address,'') AS property_address,p.latitude,p.longitude,
       p.campus_distance_m,COALESCE(p.utilities_enabled,0) AS utilities_enabled,
       COALESCE(o.payout_status,'PENDING') AS payout_status,COALESCE(o.payout_snapshot,'') AS payout_snapshot,
       COALESCE(h.payout_method,'') AS payout_method,COALESCE(h.payout_account_last4,'') AS payout_last4,
       COALESCE(h.payout_bank_code,'') AS payout_bank_code,COALESCE(h.payout_updated_at,'') AS payout_updated_at,
       COUNT(l.id) AS available_spaces,COUNT(DISTINCT r.id) AS room_count,MIN(l.price) AS min_price,
       MIN(l.price + CASE WHEN COALESCE(p.utilities_enabled,0) = 1 THEN COALESCE(r.utilities_fee,0) ELSE 0 END) AS min_total
     FROM hostel_properties p
     JOIN hostel_landlords h ON h.id = p.landlord_id
     JOIN hostel_owner_onboarding o ON o.landlord_id = h.id
     LEFT JOIN hostel_rooms r ON r.property_id = p.id AND COALESCE(r.status,'ACTIVE') = 'ACTIVE'
     LEFT JOIN hostel_spaces s ON s.room_id = r.id
     LEFT JOIN hostel_listings l ON l.space_id = s.id AND l.period_id = ? AND l.status = 'APPROVED' AND ${bedAvailableSql()}
     WHERE p.status = 'APPROVED' AND h.status = 'ACTIVE' AND h.kyc_status = 'VERIFIED'
       AND o.profile_status = 'APPROVED'
       AND EXISTS (SELECT 1 FROM hostel_property_photos ph WHERE ph.property_id=p.id AND ph.status='APPROVED')
       ${clauses.length ? "AND " + clauses.join(" AND ") : ""}
     GROUP BY p.id
     ${having.length ? "HAVING " + having.join(" AND ") : ""}
     ORDER BY p.name COLLATE NOCASE ASC`,
    args,
  ));

  const properties: PublicProperty[] = rows.map((row) => {
    const latitude = row.latitude === null || row.latitude === undefined || !isCoordinate(Number(row.latitude)) ? null : Number(row.latitude);
    const longitude = row.longitude === null || row.longitude === undefined || !isCoordinate(Number(row.longitude)) ? null : Number(row.longitude);
    const declared = row.campus_distance_m === null || row.campus_distance_m === undefined ? null : Number(row.campus_distance_m);
    const distanceM = declared !== null && Number.isFinite(declared)
      ? Math.max(0, Math.round(declared))
      : latitude !== null && longitude !== null
        ? distanceToCampusMeters(latitude, longitude)
        : null;
    return {
      id: String(row.property_id || ""),
      name: String(row.property_name || ""),
      address: String(row.property_address || ""),
      latitude,
      longitude,
      distanceM,
      utilitiesEnabled: Number(row.utilities_enabled ?? 0) === 1,
      availableSpaces: Number(row.available_spaces || 0),
      bookingReady: String(row.payout_status) === "APPROVED" && Boolean(row.payout_method && row.payout_last4) && String(row.payout_snapshot) === JSON.stringify([row.payout_method, row.payout_last4, row.payout_bank_code, row.payout_updated_at]),
      roomCount: Number(row.room_count || 0),
      minPrice: Number(row.min_price || 0),
      minTotal: Number(row.min_total || 0),
      coverPhotoId: null,
      ratingAverage: 0,
      ratingCount: 0,
    };
  });

  const { maxDistanceM, minSpaces, maxPrice } = query;
  const filtered = properties.filter((property) => {
    if (query.propertyId && property.id !== query.propertyId) return false;
    if (search && !`${property.name} ${property.address}`.toLowerCase().includes(search.toLowerCase())) return false;
    if (query.utilitiesOnly === true && !property.utilitiesEnabled) return false;
    if (typeof maxDistanceM === "number" && Number.isFinite(maxDistanceM) && maxDistanceM >= 0) {
      if (property.distanceM === null || property.distanceM > maxDistanceM) return false;
    }
    if (typeof minSpaces === "number" && Number.isFinite(minSpaces) && minSpaces > 1 && property.availableSpaces < minSpaces) return false;
    if (typeof maxPrice === "number" && Number.isFinite(maxPrice) && maxPrice >= 0 && property.minTotal > maxPrice) return false;
    return true;
  });

  const sort = query.sort || "name";
  filtered.sort((left, right) => {
    if (sort === "price") return (left.availableSpaces ? left.minTotal : Number.POSITIVE_INFINITY) - (right.availableSpaces ? right.minTotal : Number.POSITIVE_INFINITY) || left.name.localeCompare(right.name);
    if (sort === "distance") {
      if (left.distanceM === null) return right.distanceM === null ? left.name.localeCompare(right.name) : 1;
      if (right.distanceM === null) return -1;
      return left.distanceM - right.distanceM || left.name.localeCompare(right.name);
    }
    return left.name.localeCompare(right.name);
  });

  const total = filtered.length;
  const pageSize = Math.min(48, Math.max(1, Math.floor(query.pageSize || 12)));
  const pageCount = Math.ceil(total / pageSize);
  const page = Math.min(Math.max(1, Math.floor(query.page || 1)), Math.max(1, pageCount));
  const pageProperties = filtered.slice((page - 1) * pageSize, page * pageSize);
  // Map pins carry only summary data and never trigger image/review queries.
  const mapProperties = filtered.filter(property => property.latitude !== null && property.longitude !== null).slice(0, 60);
  if (query.enrich !== false) {
    const ids = pageProperties.map(property => property.id);
    const [covers, ratings] = await Promise.all([listApprovedPhotoCovers(ids), reviewSummaryForProperties(ids)]);
    pageProperties.forEach(property => {
      property.coverPhotoId = covers.get(property.id)?.id || null;
      property.ratingAverage = ratings.get(property.id)?.average || 0;
      property.ratingCount = ratings.get(property.id)?.count || 0;
    });
  }

  return {
    period: { id: String(period.id), name: String(period.name), startsOn: String(period.starts_on), endsOn: String(period.ends_on) },
    properties: pageProperties, mapProperties, total, page, pageCount,
  };
}

/**
 * One approved building and any separately approved, available beds. A building
 * without bookable beds still has a public information page; an unapproved or
 * suspended building remains a 404.
 */
export async function getPublicProperty(propertyId: string, periodId?: string) {
  const id = String(propertyId ?? "").trim();
  if (!id) return null;
  const { period, properties } = await listPublicProperties({ periodId, propertyId: id, pageSize: 1 });
  const property = properties.find((item) => item.id === id);
  if (!property || !period) return null;
  const [{ spaces }, photos, reviews] = await Promise.all([
    listPublicSpaces({ propertyId: id, periodId: period.id }),
    listApprovedHostelPhotos(id),
    listPropertyReviews(id, { limit: 12 }),
  ]);
  return { period, property, spaces, photos, reviews };
}
