import { bedAvailableSql } from "./inventory";
import { ensureHostelConditionTables } from "./condition-schema";
import { conditionTransferStatements } from "./conditions";
import { CampusEngineError } from "@/lib/campus-engine/errors";
import { getHostelBookingByReference, ensureHostelResidencyTables } from "./residency";
import { ensureHostelRefundTables } from "./refunds";
import { rowsToObjects, turso, tursoTransaction } from "@/lib/turso";

export const STAY_ACTIONS = ["SCHEDULE", "CHECK_IN", "CHECK_OUT", "NO_SHOW", "TRANSFER"] as const;
export type StayAction = typeof STAY_ACTIONS[number];
async function ownedBooking(landlordId: string, reference: string) {
  await ensureHostelResidencyTables();
  const booking = await getHostelBookingByReference(reference);
  if (!booking || booking.landlordId !== landlordId) throw new CampusEngineError("NOT_FOUND", "That resident was not found in your hostel workspace.", 404);
  return booking;
}

export async function hostelStayDetail(landlordId: string, reference: string, search = "") {
  const booking = await ownedBooking(landlordId, reference);
  const [stay, events, destinations] = await Promise.all([
    turso("SELECT key_reference,updated_by,updated_at FROM hostel_stays WHERE booking_id=?", [booking.id]),
    turso("SELECT id,action,actor,details,created_at FROM hostel_stay_events WHERE booking_id=? ORDER BY created_at DESC,id DESC LIMIT 30", [booking.id]),
    turso(`SELECT l.id AS listing_id,r.label AS room_label,s.label AS space_label
      FROM hostel_listings l JOIN hostel_spaces s ON s.id=l.space_id JOIN hostel_rooms r ON r.id=s.room_id
      JOIN hostel_properties p ON p.id=r.property_id
      WHERE p.id=? AND p.landlord_id=? AND l.period_id=? AND l.status='APPROVED' AND r.status='ACTIVE' AND ${bedAvailableSql()}
      AND l.price=? AND CASE WHEN p.utilities_enabled=1 THEN r.utilities_fee ELSE 0 END=?
      AND (?='' OR instr(lower(r.label || ' ' || s.label),lower(?))>0)
      ORDER BY r.label COLLATE NOCASE,s.label COLLATE NOCASE LIMIT 50`,
    [booking.propertyId, landlordId, booking.periodId, booking.price, booking.utilitiesFee, search.trim().slice(0, 80), search.trim().slice(0, 80)]),
  ]);
  return { booking, stay: rowsToObjects(stay)[0] || {}, events: rowsToObjects(events), destinations: rowsToObjects(destinations) };
}

/** Occupancy and its audit entry always change in the same transaction. */
export async function updateHostelStay(input: {
  landlordId: string; reference: string; actor: string; action: StayAction; version: number;
  transactionGuard?: { sql:string; args:Array<string|number|null>; after: (eventId:string,stamp:string)=>Array<{sql:string;args:Array<string|number|null>}> };
  expectedArrivalOn?: string; keyReference?: string; keysReturned?: boolean; note?: string; targetListingId?: string;
}) {
  const booking = await ownedBooking(input.landlordId, input.reference);
  await ensureHostelRefundTables();
  if (booking.status !== "PAID") throw new CampusEngineError("INVALID_STATE", "Confirm the bed payment before changing residency.", 409);
  if (!Number.isInteger(input.version) || input.version !== booking.stayVersion) throw new CampusEngineError("CONFLICT", "This resident was updated elsewhere. Refresh and review the latest details.", 409);
  if (!STAY_ACTIONS.includes(input.action)) throw new CampusEngineError("VALIDATION_ERROR", "Choose a supported residency action.", 400);
  const allowed = input.action === "CHECK_OUT" ? ["CHECKED_IN"] : input.action === "TRANSFER" ? ["EXPECTED", "CHECKED_IN"] : ["EXPECTED"];
  if (!allowed.includes(booking.stayStatus)) throw new CampusEngineError("INVALID_STATE", "That action is not available for this residency status.", 409);
  const stamp = new Date().toISOString(), today = stamp.slice(0, 10);
  const eventId = crypto.randomUUID();
  let previousAssignment = "initial";
  if (input.action === "TRANSFER") {
    await ensureHostelConditionTables();
    previousAssignment = String(rowsToObjects(await turso("SELECT assignment_id FROM hostel_stays WHERE booking_id=?", [booking.id]))[0]?.assignment_id || "initial");
  }
  if (["CHECK_IN", "TRANSFER", "SCHEDULE"].includes(input.action) && booking.periodEndsOn && today > booking.periodEndsOn) {
    throw new CampusEngineError("INVALID_STATE", "This academic year has ended. Close the residency or arrange a new booking.", 409);
  }
  if (input.action === "CHECK_IN" && today < booking.periodStartsOn) throw new CampusEngineError("INVALID_STATE", "Check-in opens when the booked academic year starts.", 409);
  if (input.action === "NO_SHOW" && today < (booking.expectedArrivalOn || booking.periodStartsOn)) throw new CampusEngineError("INVALID_STATE", "Wait until the expected arrival date before recording a no-show.", 409);
  const note = String(input.note || "").trim().slice(0, 500);
  if (["TRANSFER", "CHECK_OUT", "NO_SHOW"].includes(input.action) && !note) throw new CampusEngineError("VALIDATION_ERROR", "Add a short note explaining this residency change.", 400);
  let arrival = booking.expectedArrivalOn;
  if (input.action === "SCHEDULE") {
    arrival = String(input.expectedArrivalOn || "");
    const date = new Date(arrival + "T00:00:00Z");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(arrival) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== arrival || arrival < booking.periodStartsOn || arrival > booking.periodEndsOn) {
      throw new CampusEngineError("VALIDATION_ERROR", "Choose an arrival date within the booked academic year.", 400);
    }
  }
  const keyReference = String(input.keyReference || "").trim().slice(0, 80);
  if (input.action === "CHECK_OUT" || (input.action === "TRANSFER" && booking.stayStatus === "CHECKED_IN")) {
    const stay = rowsToObjects(await turso("SELECT key_reference FROM hostel_stays WHERE booking_id=?", [booking.id]))[0];
    if (stay?.key_reference && input.keysReturned !== true) throw new CampusEngineError("VALIDATION_ERROR", "Confirm the issued key has been returned before checkout or transfer.", 400);
  }
  // No transfer or occupancy change may race an approved/in-flight refund.
  const guard = `EXISTS (SELECT 1 FROM hostel_bookings b WHERE b.id=hostel_stays.booking_id AND b.landlord_id=? AND b.status='PAID')
    AND NOT EXISTS (SELECT 1 FROM hostel_refunds rf WHERE rf.booking_id=hostel_stays.booking_id AND rf.status IN ('REQUESTED','APPROVED'))`;
  const status = input.action === "CHECK_IN" ? "CHECKED_IN" : input.action === "CHECK_OUT" ? "CHECKED_OUT" : input.action === "NO_SHOW" ? "NO_SHOW" : booking.stayStatus;
  let changes: Array<{ sql: string; args: Array<string | number | null> }>;
  const details: Record<string, unknown> = { note, previousStatus: booking.stayStatus, status, expectedArrivalOn: arrival };
  if (input.action === "TRANSFER") {
    const target = rowsToObjects(await turso(`SELECT l.id,l.space_id,r.id AS room_id,r.label AS room_label,s.label AS space_label
      FROM hostel_listings l JOIN hostel_spaces s ON s.id=l.space_id JOIN hostel_rooms r ON r.id=s.room_id JOIN hostel_properties p ON p.id=r.property_id
      WHERE l.id=? AND p.id=? AND p.landlord_id=? AND l.period_id=? AND l.status='APPROVED' AND r.status='ACTIVE'
      AND ${bedAvailableSql()} AND l.price=? AND CASE WHEN p.utilities_enabled=1 THEN r.utilities_fee ELSE 0 END=?`,
    [String(input.targetListingId || ""), booking.propertyId, input.landlordId, booking.periodId, booking.price, booking.utilitiesFee]))[0];
    if (!target) throw new CampusEngineError("CONFLICT", "Choose an available, approved bed at the same rent and utilities price in this property and academic year.", 409);
    details.from = `${booking.roomLabel} · ${booking.spaceLabel}`;
    details.to = `${String(target.room_label)} · ${String(target.space_label)}`;
    details.keysReturned = input.keysReturned === true;
    details.keyReference = keyReference;
    changes = [
      { sql: `UPDATE hostel_spaces SET status=CASE WHEN ?<=date('now') THEN 'OCCUPIED' ELSE status END,updated_at=? WHERE id=? AND ${bedAvailableSql('hostel_spaces',"(SELECT period_id FROM hostel_bookings WHERE id=?)")}
        ${input.transactionGuard?'AND ('+input.transactionGuard.sql+')':''}
        AND EXISTS (SELECT 1 FROM hostel_stays WHERE booking_id=? AND version=? AND status IN ('EXPECTED','CHECKED_IN') AND ${guard})
        AND EXISTS (SELECT 1 FROM hostel_listings l JOIN hostel_rooms r ON r.id=hostel_spaces.room_id JOIN hostel_properties p ON p.id=r.property_id
          WHERE l.id=? AND l.space_id=hostel_spaces.id AND l.period_id=? AND l.status='APPROVED' AND r.status='ACTIVE' AND p.id=? AND l.price=? AND CASE WHEN p.utilities_enabled=1 THEN r.utilities_fee ELSE 0 END=?)`,
      args: [booking.periodStartsOn, stamp, String(target.space_id),booking.id,booking.id,booking.id,...(input.transactionGuard?.args||[]), booking.id, input.version, input.landlordId, String(target.id), booking.periodId, booking.propertyId, booking.price, booking.utilitiesFee] },
      { sql: "UPDATE hostel_bookings SET listing_id=?,space_id=?,room_id=?,updated_at=? WHERE id=? AND changes()=1", args: [String(target.id), String(target.space_id), String(target.room_id), stamp, booking.id] },
      { sql: `UPDATE hostel_spaces SET status=CASE WHEN EXISTS(SELECT 1 FROM hostel_bed_claims c JOIN hostel_periods pe ON pe.id=c.period_id WHERE c.space_id=hostel_spaces.id AND c.booking_id<>? AND pe.starts_on<=date('now')) THEN status ELSE 'AVAILABLE' END,updated_at=? WHERE id=? AND changes()=1`, args: [booking.id, stamp, booking.spaceId] },
      { sql: "UPDATE hostel_stays SET assignment_id=?,key_reference=?,version=version+1,updated_by=?,updated_at=? WHERE booking_id=? AND changes()=1", args: [eventId, keyReference, input.actor, stamp, booking.id] },
    ];
  } else {
    changes = [
      { sql: `UPDATE hostel_stays SET status=?,expected_arrival_on=?,checked_in_at=CASE WHEN ?='CHECK_IN' THEN ? ELSE checked_in_at END,
        checked_out_at=CASE WHEN ? IN ('CHECK_OUT','NO_SHOW') THEN ? ELSE checked_out_at END,
        key_reference=CASE WHEN ?='CHECK_IN' THEN ? ELSE key_reference END,updated_by=?,updated_at=?,version=version+1
        WHERE booking_id=? AND version=? AND status=? AND ${guard}
        AND (?<>'CHECK_IN' OR NOT EXISTS(SELECT 1 FROM hostel_stays other JOIN hostel_bookings ob ON ob.id=other.booking_id WHERE ob.space_id=? AND ob.id<>? AND other.status='CHECKED_IN'))`,
      args: [status, arrival, input.action, stamp, input.action, stamp, input.action, keyReference, input.actor, stamp, booking.id, input.version, booking.stayStatus, input.landlordId,input.action,booking.spaceId,booking.id] },
    ];
    if (["CHECK_OUT", "NO_SHOW"].includes(input.action)) changes.push({ sql: `UPDATE hostel_spaces SET status=CASE WHEN EXISTS(SELECT 1 FROM hostel_bed_claims c JOIN hostel_periods pe ON pe.id=c.period_id WHERE c.space_id=hostel_spaces.id AND c.booking_id<>? AND pe.starts_on<=date('now')) THEN status ELSE 'AVAILABLE' END,updated_at=? WHERE id=? AND changes()=1`, args: [booking.id, stamp, booking.spaceId] });
    if(input.action==='CHECK_IN') changes.push({sql:"UPDATE hostel_spaces SET status='OCCUPIED',updated_at=? WHERE id=? AND changes()=1",args:[stamp,booking.spaceId]});
    details.keysReturned = input.keysReturned === true;
    if (input.action === "CHECK_IN") details.keyReference = keyReference;
  }
  changes.push({ sql: `INSERT INTO hostel_stay_events (id,booking_id,landlord_id,action,actor,details,created_at)
    SELECT ?,?,?,?,?,?,? WHERE changes()=1 AND EXISTS (SELECT 1 FROM hostel_stays WHERE booking_id=? AND version=? AND updated_at=?)`,
  args: [eventId, booking.id, input.landlordId, input.action, input.actor, JSON.stringify(details), stamp, booking.id, input.version + 1, stamp] });
  if (input.action === "TRANSFER") changes.push(...conditionTransferStatements({ bookingId: booking.id, previousAssignment, eventId, actor: input.actor, stamp }));
  if(input.transactionGuard)changes.push(...input.transactionGuard.after(eventId,stamp));
  const [changed] = await tursoTransaction(changes);
  if (Number(changed.affected_row_count) !== 1) throw new CampusEngineError("CONFLICT", "The resident, destination bed or refund status changed. Refresh before trying again.", 409);
  return hostelStayDetail(input.landlordId, input.reference);
}
