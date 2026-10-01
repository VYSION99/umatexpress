import { ensureHostelResidencyTables, BOOKING_COLUMNS, BOOKING_JOINS, bookingView } from "./residency";
import { ensureHostelMessageTables } from "./message-schema";
import { ensureHostelPluginTables } from "./plugins";
import { rowsToObjects, turso } from "@/lib/turso";

export async function hostelResidentList(landlordId: string, options: { propertyId?: string; periodId?: string; search?: string; status?: string; page?: number } = {}) {
  await ensureHostelResidencyTables();
  await Promise.all([ensureHostelMessageTables(), ensureHostelPluginTables()]);
  const pageSize = 20;
  const requestedPage = Math.max(1, Math.min(100_000, Math.floor(Number(options.page) || 1)));
  const base = ["b.landlord_id=?"];
  const args: Array<string | number> = [landlordId];
  if (options.propertyId) { base.push("b.property_id=?"); args.push(options.propertyId); }
  if (options.periodId) { base.push("b.period_id=?"); args.push(options.periodId); }
  const filters = [...base], filteredArgs = [...args];
  const search = String(options.search || "").trim().slice(0, 80);
  if (search) { filters.push("instr(lower(b.student_name || ' ' || b.student_email || ' ' || b.reference || ' ' || COALESCE(r.label,'')),lower(?))>0"); filteredArgs.push(search); }
  if (["EXPECTED", "CHECKED_IN", "CHECKED_OUT", "NO_SHOW"].includes(options.status || "")) {
    filters.push("b.status='PAID' AND COALESCE(st.status,'EXPECTED')=?"); filteredArgs.push(options.status!);
  } else if (["PENDING_PAYMENT", "PAYMENT_REVIEW", "CANCELLED", "REFUNDED", "EXPIRED"].includes(options.status || "")) {
    filters.push("b.status=?"); filteredArgs.push(options.status!);
  }
  const where = filters.join(" AND "), baseWhere = base.join(" AND ");
  const [countRows, totals] = await Promise.all([
    turso(`SELECT COUNT(*) AS total ${BOOKING_JOINS} WHERE ${where}`, filteredArgs),
    turso(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN b.status='PAID' AND COALESCE(st.status,'EXPECTED')='EXPECTED' THEN 1 ELSE 0 END) AS expected,
      SUM(CASE WHEN b.status='PAID' AND st.status='CHECKED_IN' THEN 1 ELSE 0 END) AS checked_in,
      SUM(CASE WHEN b.status='PAID' AND st.status IN ('CHECKED_OUT','NO_SHOW') THEN 1 ELSE 0 END) AS departed,
      SUM(CASE WHEN b.status='PENDING_PAYMENT' THEN 1 ELSE 0 END) AS awaiting_payment,
      SUM(CASE WHEN b.status='PAYMENT_REVIEW' THEN 1 ELSE 0 END) AS needs_review,
      SUM(CASE WHEN b.status='PAID' THEN b.total_amount ELSE 0 END) AS bed_revenue,
      SUM(CASE WHEN b.status='PAID' THEN b.commission_amount ELSE 0 END) AS commission,
      SUM(CASE WHEN b.status='PAID' THEN b.net_amount ELSE 0 END) AS net,
      (SELECT COUNT(*) FROM hostel_service_requests req JOIN hostel_bookings b ON b.id=req.booking_id WHERE ${baseWhere} AND req.status IN ('REQUESTED','APPROVED','ACTIVE')) AS open_services,
      (SELECT COUNT(*) FROM hostel_messages m JOIN hostel_bookings b ON b.id=m.booking_id WHERE ${baseWhere} AND m.sender_type='STUDENT' AND m.read_at='') AS unread_messages
      ${BOOKING_JOINS} WHERE ${baseWhere}`, [...args, ...args, ...args]),
  ]);
  const total = Number(rowsToObjects(countRows)[0]?.total || 0);
  const page = Math.min(requestedPage, Math.max(1, Math.ceil(total / pageSize)));
  const rows = rowsToObjects(await turso(`SELECT ${BOOKING_COLUMNS},
    (SELECT COUNT(*) FROM hostel_messages m WHERE m.booking_id=b.id AND m.sender_type='STUDENT' AND m.read_at='') AS unread_messages,
    (SELECT COUNT(*) FROM hostel_service_requests req WHERE req.booking_id=b.id AND req.status IN ('REQUESTED','APPROVED','ACTIVE')) AS open_services
    ${BOOKING_JOINS} WHERE ${where} ORDER BY b.created_at DESC,b.id DESC LIMIT ? OFFSET ?`, [...filteredArgs, pageSize, (page - 1) * pageSize]));
  const summary = rowsToObjects(totals)[0] || {};
  const n = (key: string) => Number(summary[key] || 0);
  return {
    residents: rows.map(row => ({ ...bookingView(row), unreadMessages: Number(row.unread_messages || 0), openServices: Number(row.open_services || 0) })),
    pagination: { page, pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize)) },
    summary: { total: n("total"), resident: n("checked_in"), expected: n("expected"), departed: n("departed"), awaitingPayment: n("awaiting_payment"), needsReview: n("needs_review"),
      bedRevenue: n("bed_revenue"), commission: n("commission"), net: n("net"), openServices: n("open_services"), unreadMessages: n("unread_messages") },
  };
}
