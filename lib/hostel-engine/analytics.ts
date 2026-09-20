import { ensureHostelTables } from "@/lib/hostel-engine/landlord";
import { ensureHostelMessageTables } from "@/lib/hostel-engine/message-schema";
import { ensureHostelResidencyTables } from "@/lib/hostel-engine/residency";
import { reviewSummaryForProperties } from "@/lib/hostel-engine/reviews";
import { rowsToObjects, turso } from "@/lib/turso";

/**
 * The hostel side of the platform's numbers.
 *
 * Every figure is computed from the ledgers the other modules already write —
 * bookings, listings, spaces, payouts, reviews, messages — so the dashboard
 * cannot drift from the operational screens it summarises. Money is pesewas.
 */

export type HostelAnalytics = {
  generatedAt: string;
  occupancy: { occupied: number; available: number; total: number; rate: number };
  bookings: {
    total: number; paid: number; pendingPayment: number; paymentReview: number;
    expired: number; cancelled: number; refunded: number;
    paidValue: number; refundedValue: number;
    trend: { day: string; count: number; amount: number }[];
    distinctStudents: number; repeatStudents: number;
  };
  listings: { approved: number; pendingReview: number; draft: number; suspended: number; total: number };
  properties: { active: number; draft: number; suspended: number; total: number };
  landlords: { total: number; verified: number; pendingKyc: number; rejected: number };
  money: { gross: number; commission: number; net: number; accrued: number; released: number; processing: number; reversed: number };
  reviews: { count: number; average: number; hidden: number };
  messages: { threads: number; recent: number };
  topProperties: { id: string; name: string; bookings: number; revenue: number; ratingAverage: number; ratingCount: number }[];
};

const DAY_MS = 24 * 60 * 60 * 1000;

function countBy(rows: Record<string, unknown>[], key = "status") {
  const counts = new Map<string, { count: number; amount: number }>();
  rows.forEach((row) => {
    const name = String(row[key] || "").toUpperCase();
    if (!name) return;
    counts.set(name, { count: Number(row.count || 0), amount: Number(row.amount || 0) });
  });
  return counts;
}

function totalFor(counts: Map<string, { count: number; amount: number }>, status: string) {
  return counts.get(status)?.count || 0;
}

function sumFor(counts: Map<string, { count: number; amount: number }>, status: string) {
  return counts.get(status)?.amount || 0;
}

/**
 * Builds the trend for the last `days` finishing today, from whatever paid
 * dates exist: a quiet day is a zero row rather than a missing one, so the
 * chart cannot imply activity that did not happen.
 */
export function hostelBookingTrend(rows: Record<string, unknown>[], days = 14, now = new Date()) {
  const seen = new Map(rows.map((row) => [String(row.day || ""), row]));
  const trend: { day: string; count: number; amount: number }[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = new Date(now.getTime() - offset * DAY_MS).toISOString().slice(0, 10);
    const row = seen.get(day);
    trend.push({ day, count: Number(row?.count || 0), amount: Number(row?.amount || 0) });
  }
  return trend;
}

export async function hostelAnalytics(options: { now?: Date } = {}): Promise<HostelAnalytics> {
  await Promise.all([ensureHostelTables(), ensureHostelResidencyTables(), ensureHostelMessageTables()]);
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - 14 * DAY_MS).toISOString().slice(0, 10);
  const recentCutoff = new Date(now.getTime() - 7 * DAY_MS).toISOString();

  const [
    bookingRows, trendRows, studentRows, listingRows, propertyRows, spaceRow, landlordRows, payoutRows, reviewRow, messageRow,
  ] = await Promise.all([
    turso("SELECT COALESCE(status,'PENDING_PAYMENT') AS status, COUNT(*) AS count, COALESCE(SUM(total_amount),0) AS amount FROM hostel_bookings GROUP BY status"),
    turso("SELECT substr(paid_at,1,10) AS day, COUNT(*) AS count, COALESCE(SUM(total_amount),0) AS amount FROM hostel_bookings WHERE status = 'PAID' AND substr(paid_at,1,10) >= ? GROUP BY day", [since]),
    turso("SELECT student_email, COUNT(*) AS count FROM hostel_bookings WHERE status = 'PAID' GROUP BY student_email"),
    turso("SELECT COALESCE(status,'DRAFT') AS status, COUNT(*) AS count FROM hostel_listings GROUP BY status"),
    turso("SELECT COALESCE(status,'DRAFT') AS status, COUNT(*) AS count FROM hostel_properties GROUP BY status"),
    turso("SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN status = 'OCCUPIED' THEN 1 ELSE 0 END),0) AS occupied FROM hostel_spaces WHERE COALESCE(status,'AVAILABLE') != 'RETIRED'"),
    turso("SELECT COALESCE(kyc_status,'PENDING') AS status, COUNT(*) AS count FROM hostel_landlords GROUP BY status"),
    turso("SELECT COALESCE(status,'ACCRUED') AS status, COUNT(*) AS count, COALESCE(SUM(net_amount),0) AS amount, COALESCE(SUM(gross_amount),0) AS gross, COALESCE(SUM(commission_amount),0) AS commission FROM hostel_payouts GROUP BY status"),
    turso("SELECT COUNT(*) AS count, COALESCE(AVG(rating),0) AS average, COALESCE(SUM(CASE WHEN status = 'HIDDEN' THEN 1 ELSE 0 END),0) AS hidden FROM hostel_reviews"),
    turso("SELECT COUNT(DISTINCT booking_id) AS threads, COALESCE(SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END),0) AS recent FROM hostel_messages", [recentCutoff]),
  ]);

  const bookingsByStatus = countBy(rowsToObjects(bookingRows));
  const students = rowsToObjects(studentRows);

  // The payout ledger keeps gross, the platform's 3% and the landlord's share
  // on every row, so the money block is a fold over statuses rather than four
  // separate queries that could disagree with each other.
  const money = { gross: 0, commission: 0, net: 0, accrued: 0, released: 0, processing: 0, reversed: 0 };
  rowsToObjects(payoutRows).forEach((row) => {
    const status = String(row.status || "").toUpperCase();
    const amount = Number(row.amount || 0);
    money.gross += Number(row.gross || 0);
    money.commission += Number(row.commission || 0);
    if (status !== "REVERSED") money.net += amount;
    if (status === "ACCRUED") money.accrued += amount;
    if (status === "RELEASED") money.released += amount;
    if (status === "PROCESSING") money.processing += amount;
    if (status === "REVERSED") money.reversed += amount;
  });

  const paidBookings = totalFor(bookingsByStatus, "PAID");
  const trend = hostelBookingTrend(rowsToObjects(trendRows), 14, now);

  const listingCounts = countBy(rowsToObjects(listingRows));
  const listings = {
    approved: totalFor(listingCounts, "APPROVED"),
    pendingReview: totalFor(listingCounts, "PENDING_REVIEW"),
    draft: totalFor(listingCounts, "DRAFT"),
    suspended: totalFor(listingCounts, "SUSPENDED"),
    total: rowsToObjects(listingRows).reduce((total, row) => total + Number(row.count || 0), 0),
  };

  const propertyCounts = countBy(rowsToObjects(propertyRows));
  const spaceRowValue = rowsToObjects(spaceRow)[0] || {};
  const occupied = Number(spaceRowValue.occupied || 0);
  const totalSpaces = Number(spaceRowValue.total || 0);

  const landlordCounts = countBy(rowsToObjects(landlordRows));
  const landlordTotal = rowsToObjects(landlordRows).reduce((total, row) => total + Number(row.count || 0), 0);
  const verified = totalFor(landlordCounts, "VERIFIED");
  const rejected = totalFor(landlordCounts, "REJECTED");

  const reviewCount = Number(rowsToObjects(reviewRow)[0]?.count || 0);
  const reviewAverage = Number(rowsToObjects(reviewRow)[0]?.average || 0);
  const reviewHidden = Number(rowsToObjects(reviewRow)[0]?.hidden || 0);
  const messageStats = rowsToObjects(messageRow)[0] || {};

  const topRows = rowsToObjects(await turso(
    `SELECT p.id AS id, p.name AS name, COUNT(b.id) AS bookings, COALESCE(SUM(b.total_amount),0) AS revenue
     FROM hostel_bookings b JOIN hostel_properties p ON p.id = b.property_id
     WHERE b.status = 'PAID'
     GROUP BY p.id, p.name ORDER BY revenue DESC LIMIT 6`,
  ));
  const ratings = await reviewSummaryForProperties(topRows.map((row) => String(row.id || "")));

  return {
    generatedAt: now.toISOString(),
    occupancy: {
      occupied,
      available: Math.max(0, totalSpaces - occupied),
      total: totalSpaces,
      rate: totalSpaces ? occupied / totalSpaces : 0,
    },
    bookings: {
      total: [...bookingsByStatus.values()].reduce((total, entry) => total + entry.count, 0),
      paid: paidBookings,
      pendingPayment: totalFor(bookingsByStatus, "PENDING_PAYMENT"),
      paymentReview: totalFor(bookingsByStatus, "PAYMENT_REVIEW"),
      expired: totalFor(bookingsByStatus, "EXPIRED"),
      cancelled: totalFor(bookingsByStatus, "CANCELLED"),
      refunded: totalFor(bookingsByStatus, "REFUNDED"),
      paidValue: sumFor(bookingsByStatus, "PAID") + sumFor(bookingsByStatus, "PAYMENT_REVIEW"),
      refundedValue: sumFor(bookingsByStatus, "REFUNDED"),
      trend,
      distinctStudents: students.length,
      repeatStudents: students.filter((row) => Number(row.count || 0) > 1).length,
    },
    listings,
    properties: {
      active: totalFor(propertyCounts, "ACTIVE"),
      draft: totalFor(propertyCounts, "DRAFT"),
      suspended: totalFor(propertyCounts, "SUSPENDED"),
      total: rowsToObjects(propertyRows).reduce((total, row) => total + Number(row.count || 0), 0),
    },
    landlords: { total: landlordTotal, verified, pendingKyc: Math.max(0, landlordTotal - verified - rejected), rejected },
    money,
    reviews: { count: reviewCount, average: reviewAverage, hidden: reviewHidden },
    messages: { threads: Number(messageStats.threads || 0), recent: Number(messageStats.recent || 0) },
    topProperties: topRows.map((row) => ({
      id: String(row.id || ""),
      name: String(row.name || ""),
      bookings: Number(row.bookings || 0),
      revenue: Number(row.revenue || 0),
      ratingAverage: ratings.get(String(row.id || ""))?.average || 0,
      ratingCount: ratings.get(String(row.id || ""))?.count || 0,
    })),
  };
}
