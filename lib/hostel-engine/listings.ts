import { CampusEngineError } from "@/lib/campus-engine/errors";
import { consoleAudit } from "@/lib/console-audit";
import { ensureHostelTables } from "@/lib/hostel-engine/landlord";
import { distanceToCampusMeters, isCoordinate } from "@/lib/hostel-engine/geo";
import { rowsToObjects, turso } from "@/lib/turso";

/**
 * Listing one bed for one academic year, and the review that decides whether
 * students ever see it.
 *
 *  DRAFT ─▶ PENDING_REVIEW ─▶ APPROVED ─▶ SUSPENDED
 *    ▲            │
 *    └── reject ──┘        an edit sends a listing back to draft
 *
 * The listing is the only door to a student's screen: a bed, a room and a
 * property being real is not enough, so the public read below is written in
 * terms of `status = 'APPROVED'` and nothing else. Ownership always travels
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
  roomLabel: string;
  spaceLabel: string;
  capacity: number;
  price: number;
  utilitiesFee: number;
  total: number;
};

/** A building a signed-out visitor may browse: its pin, its price and its beds. */
export type PublicProperty = {
  id: string;
  name: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  /** Metres from campus: what the landlord declared, else measured from the pin. */
  distanceM: number | null;
  utilitiesEnabled: boolean;
  /** Approved beds in the open year, after every gate. */
  availableSpaces: number;
  roomCount: number;
  /** Yearly rent in pesewas, before utilities. */
  minPrice: number;
  /** What the cheapest bed costs with the utilities the student would pay. */
  minTotal: number;
};

/** The filters the browse page may ask for, all optional. */
export type PublicPropertyQuery = {
  periodId?: string;
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
  await ensureHostelTables();
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
  await ensureHostelTables();
  const spaceId = requiredId(input.spaceId, "bed");
  const periodId = requiredId(input.periodId, "academic year");
  const price = priceInPesewas(input.price);

  const space = rowsToObjects(await turso(
    `SELECT s.id AS space_id,COALESCE(s.status,'AVAILABLE') AS space_status,r.label AS room_label,COALESCE(r.status,'ACTIVE') AS room_status
     FROM hostel_spaces s JOIN hostel_rooms r ON r.id = s.room_id JOIN hostel_properties p ON p.id = r.property_id
     WHERE s.id = ? AND p.landlord_id = ? LIMIT 1`,
    [spaceId, landlordId],
  ))[0];
  if (!space) throw new CampusEngineError("NOT_FOUND", "That bed does not belong to your account.", 404);
  if (String(space.space_status) === "RETIRED" || String(space.room_status) !== "ACTIVE") {
    throw new CampusEngineError("INVALID_STATE", "That bed is not part of an active room, so it cannot be listed.", 409);
  }

  const period = rowsToObjects(await turso("SELECT id,name,COALESCE(active,1) AS active FROM hostel_periods WHERE id = ? LIMIT 1", [periodId]))[0];
  if (!period) throw new CampusEngineError("NOT_FOUND", "That academic year was not found.", 404);
  if (Number(period.active) !== 1) {
    throw new CampusEngineError("INVALID_STATE", `${String(period.name)} is closed to new listings.`, 409);
  }

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

/**
 * Repricing is a material change, so an approved or in-review listing goes back
 * to draft and has to be submitted again. A suspended listing stays suspended:
 * an admin took it down, and a landlord cannot lift that with an edit.
 */
export async function updateHostelListing(landlordId: string, listingId: string, input: {
  price?: unknown;
}): Promise<LandlordListing> {
  const price = priceInPesewas(input.price);
  await ensureHostelTables();
  const row = await ownedListingRow(landlordId, listingId);
  const current = String(row.status || "DRAFT");
  if (current === "SUSPENDED") {
    throw new CampusEngineError("INVALID_STATE", "This listing was suspended by the platform. Contact support before changing it.", 409);
  }
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
  await ensureHostelTables();
  const row = await ownedListingRow(landlordId, listingId);
  const current = String(row.status || "DRAFT");
  if (current === "PENDING_REVIEW") throw new CampusEngineError("INVALID_STATE", "This listing is already with a reviewer.", 409);
  if (current === "APPROVED") throw new CampusEngineError("INVALID_STATE", "This listing is already live.", 409);
  if (current === "SUSPENDED") {
    throw new CampusEngineError("INVALID_STATE", "This listing was suspended by the platform, so it cannot go back for review on its own.", 409);
  }
  if (String(row.space_status) === "RETIRED" || String(row.room_status) !== "ACTIVE") {
    throw new CampusEngineError("INVALID_STATE", "That bed is no longer part of an active room.", 409);
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
  return { ...listingView(row), status: "PENDING_REVIEW", submittedAt: stamp, reviewReason: "" };
}

/**
 * Withdraws a listing that has not been approved. A live listing is taken down
 * by staff instead, so a landlord cannot pull a bed out from under a student
 * who is already looking at it.
 */
export async function removeHostelListing(landlordId: string, listingId: string) {
  await ensureHostelTables();
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
  await ensureHostelTables();
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
  await ensureHostelTables();
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

/**
 * The decision. Approving the first bed of a building also accepts the building,
 * so the landlord's property badge stops reading DRAFT the moment a reviewer has
 * actually seen it.
 */
export async function reviewHostelListing(input: {
  listingId: string;
  action: "APPROVE" | "REJECT" | "SUSPEND";
  reason?: unknown;
  actor: string;
}): Promise<HostelListing> {
  await ensureHostelTables();
  const listingId = String(input.listingId ?? "").trim();
  if (!listingId) throw new CampusEngineError("VALIDATION_ERROR", "Choose a listing.", 400);
  if (!["APPROVE", "REJECT", "SUSPEND"].includes(input.action)) {
    throw new CampusEngineError("VALIDATION_ERROR", "Choose approve, reject or suspend.", 400);
  }
  const reason = String(input.reason ?? "").trim();

  const row = rowsToObjects(await turso(
    `SELECT ${LISTING_COLUMNS},p.id AS property_id,COALESCE(p.status,'DRAFT') AS property_status
     FROM hostel_listings l JOIN hostel_spaces s ON s.id = l.space_id JOIN hostel_rooms r ON r.id = s.room_id JOIN hostel_properties p ON p.id = r.property_id
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

  const stamp = new Date().toISOString();
  await turso(
    "UPDATE hostel_listings SET status=?,review_reason=?,reviewed_at=?,reviewed_by=?,updated_at=? WHERE id=?",
    [transition.to, transition.to === "APPROVED" ? "" : reason, stamp, input.actor, stamp, listingId],
  );

  if (input.action === "APPROVE" && String(row.property_status) === "DRAFT") {
    await turso("UPDATE hostel_properties SET status='APPROVED',updated_at=? WHERE id = ?", [stamp, String(row.property_id)]);
    await consoleAudit({
      actor: input.actor,
      action: "HOSTEL_PROPERTY_APPROVED",
      targetType: "hostel_property",
      targetReference: String(row.property_id),
      details: { listingId, name: String(row.property_name || "") },
    }).catch(() => undefined);
  }

  await consoleAudit({
    actor: input.actor,
    action: `HOSTEL_LISTING_${input.action}`,
    targetType: "hostel_listing",
    targetReference: listingId,
    details: { from: current, to: transition.to, reason },
  }).catch(() => undefined);

  return { ...listingView(row), status: transition.to, reviewReason: transition.to === "APPROVED" ? "" : reason, reviewedAt: stamp, reviewedBy: input.actor };
}

/**
 * What a signed-out visitor may see. Every gate in the platform meets here: the
 * listing is approved, its bed has not been retired, its room is active, and its
 * property has not been suspended. Bookings land in Phase 2, so for now every
 * approved bed is free.
 */
export async function listPublicSpaces(input: { propertyId?: string; periodId?: string } = {}) {
  await ensureHostelTables();
  const propertyId = String(input.propertyId ?? "").trim();
  const periodId = String(input.periodId ?? "").trim();
  const period = periodId
    ? rowsToObjects(await turso("SELECT id,name,starts_on,ends_on FROM hostel_periods WHERE id = ? AND COALESCE(active,1) = 1 LIMIT 1", [periodId]))[0]
    : rowsToObjects(await turso("SELECT id,name,starts_on,ends_on FROM hostel_periods WHERE COALESCE(active,1) = 1 ORDER BY starts_on DESC LIMIT 1"))[0];
  if (!period) return { period: null, spaces: [] as PublicSpace[] };

  const filters = ["l.period_id = ?", "l.status = 'APPROVED'", "COALESCE(s.status,'AVAILABLE') <> 'RETIRED'", "COALESCE(r.status,'ACTIVE') = 'ACTIVE'", "COALESCE(p.status,'DRAFT') <> 'SUSPENDED'"];
  const args: (string | number | null)[] = [String(period.id)];
  if (propertyId) { filters.push("p.id = ?"); args.push(propertyId); }

  const rows = rowsToObjects(await turso(
    `SELECT l.id AS listing_id,s.id AS space_id,r.label AS room_label,s.label AS space_label,r.capacity,l.price,
       COALESCE(r.utilities_fee,0) AS utilities_fee,COALESCE(p.utilities_enabled,0) AS utilities_enabled
     FROM hostel_listings l
     JOIN hostel_spaces s ON s.id = l.space_id
     JOIN hostel_rooms r ON r.id = s.room_id
     JOIN hostel_properties p ON p.id = r.property_id
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
      roomLabel: String(row.room_label || ""),
      spaceLabel: String(row.space_label || ""),
      capacity: Number(row.capacity || 0),
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
 * What the map and the browse page show: one row per building that has at least
 * one bed a student could actually book, in the open year. The same gates as
 * `listPublicSpaces` are applied here in aggregate, so a suspended property, a
 * retired bed, an inactive room or a draft listing can never put a pin on the
 * map. Distance is declared when the landlord typed it, computed from the pin
 * otherwise, and null when the building has neither.
 */
export async function listPublicProperties(query: PublicPropertyQuery = {}) {
  await ensureHostelTables();
  const periodId = String(query.periodId ?? "").trim();
  const period = periodId
    ? rowsToObjects(await turso("SELECT id,name,starts_on,ends_on FROM hostel_periods WHERE id = ? AND COALESCE(active,1) = 1 LIMIT 1", [periodId]))[0]
    : rowsToObjects(await turso("SELECT id,name,starts_on,ends_on FROM hostel_periods WHERE COALESCE(active,1) = 1 ORDER BY starts_on DESC LIMIT 1"))[0];
  if (!period) return { period: null, properties: [] as PublicProperty[] };

  const rows = rowsToObjects(await turso(
    `SELECT p.id AS property_id,p.name AS property_name,COALESCE(p.address,'') AS property_address,p.latitude,p.longitude,
       p.campus_distance_m,COALESCE(p.utilities_enabled,0) AS utilities_enabled,COALESCE(p.status,'DRAFT') AS property_status,
       COUNT(*) AS available_spaces,COUNT(DISTINCT r.id) AS room_count,MIN(l.price) AS min_price,
       MIN(l.price + CASE WHEN COALESCE(p.utilities_enabled,0) = 1 THEN COALESCE(r.utilities_fee,0) ELSE 0 END) AS min_total
     FROM hostel_listings l
     JOIN hostel_spaces s ON s.id = l.space_id
     JOIN hostel_rooms r ON r.id = s.room_id
     JOIN hostel_properties p ON p.id = r.property_id
     WHERE l.period_id = ? AND l.status = 'APPROVED'
       AND COALESCE(s.status,'AVAILABLE') <> 'RETIRED'
       AND COALESCE(r.status,'ACTIVE') = 'ACTIVE'
       AND COALESCE(p.status,'DRAFT') <> 'SUSPENDED'
     GROUP BY p.id
     ORDER BY p.name COLLATE NOCASE ASC`,
    [String(period.id)],
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
      roomCount: Number(row.room_count || 0),
      minPrice: Number(row.min_price || 0),
      minTotal: Number(row.min_total || 0),
    };
  });

  const { maxDistanceM, minSpaces, maxPrice } = query;
  const filtered = properties.filter((property) => {
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
    if (sort === "price") return left.minTotal - right.minTotal || left.name.localeCompare(right.name);
    if (sort === "distance") {
      if (left.distanceM === null) return right.distanceM === null ? left.name.localeCompare(right.name) : 1;
      if (right.distanceM === null) return -1;
      return left.distanceM - right.distanceM || left.name.localeCompare(right.name);
    }
    return left.name.localeCompare(right.name);
  });

  return {
    period: { id: String(period.id), name: String(period.name), startsOn: String(period.starts_on), endsOn: String(period.ends_on) },
    properties: filtered,
  };
}

/**
 * One building with the beds a student can see: the browse row plus the labelled
 * spaces underneath it. A property with no approved bed resolves to `null`, so a
 * suspended building's page is a 404 rather than an empty promise.
 */
export async function getPublicProperty(propertyId: string, periodId?: string) {
  const id = String(propertyId ?? "").trim();
  if (!id) return null;
  const { period, properties } = await listPublicProperties({ periodId });
  const property = properties.find((item) => item.id === id);
  if (!property || !period) return null;
  const { spaces } = await listPublicSpaces({ propertyId: id, periodId: period.id });
  return { period, property, spaces };
}
