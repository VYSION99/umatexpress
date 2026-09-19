import { isTursoConfiguredRuntime, rowsToObjects, turso } from "@/lib/turso";
import { ensureCampusRideTables, type CampusQueueEntry } from "@/lib/campus-ride";
import { CampusEngineError } from "@/lib/campus-engine/errors";
import { requireNearestRide } from "@/lib/campus-engine/matching";
import { quoteCampusFare } from "@/lib/campus-engine/pricing";
import { campusAudit } from "@/lib/campus-engine/audit";
import { ridePin } from "@/lib/campus-engine/state";
import { applyCampusQueueTransition, campusHoldExpiry, campusQueueEntryState, claimCampusQueueSlot, releaseCampusSlots, releaseExpiredCampusHolds } from "@/lib/campus-engine/queue";
import { hashPaymentToken, paymentAccessCookie, paymentTokenFromRequest } from "@/lib/payment-access";
import { getPaymentProviderRuntime, getPaystackCurrencyRuntime, getPaystackFeePercentRuntime, initializePaystackTransaction, verifyPaystackTransaction } from "@/lib/paystack";
import { incrementMetric, requestIdFromRequest } from "@/lib/observability";
import { studentOwnsEmail } from "@/lib/student-auth";

function ref() {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  const suffix = Array.from(bytes, (byte) => byte.toString(36).padStart(2, "0")).join("").slice(0, 6).toUpperCase();
  return `CR-${Date.now().toString(36).toUpperCase()}-${suffix}`;
}

export async function requestCampusRide(input: { passengerName?: string; phone?: string; email?: string; pickupZoneId?: string; destinationZoneId?: string; rideId?: string; pickupLatitude?: number; pickupLongitude?: number; requestId?: string }) {
  const passengerName = String(input.passengerName || "").trim();
  const phone = String(input.phone || "").trim();
  const email = String(input.email || "").trim();
  const pickupZoneId = String(input.pickupZoneId || "").trim();
  const destinationZoneId = String(input.destinationZoneId || "").trim();
  if (!passengerName || !phone || !pickupZoneId || !destinationZoneId) {
    throw new CampusEngineError("VALIDATION_ERROR", "Passenger name, phone, pickup, and destination are required.", 400);
  }

  const rideId = String(input.rideId || "").trim();
  const matched = await requireNearestRide({ pickupZoneId, destinationZoneId, pickupLatitude: input.pickupLatitude, pickupLongitude: input.pickupLongitude, limit: rideId ? 20 : 1 });
  const match = rideId ? matched.matches.find((item) => item.id === rideId) : matched.match;
  if (!match) throw new CampusEngineError("NO_DRIVER_FOUND", "The selected campusRide is no longer available. Please refresh and choose another ride.", 409);
  const quote = quoteCampusFare({ corridor: match.corridor, minutes: match.estimatedMinutes, paystackFeePercent: await getPaystackFeePercentRuntime() });
  const reference = ref();
  const pin = ridePin();

  if (!(await isTursoConfiguredRuntime())) {
    return { reference, pin, paymentRequired: true, quote, match, queuePosition: Math.max(1, match.capacity - match.availableSlots + 1), preview: true };
  }

  await ensureCampusRideTables();
  const stamp = new Date().toISOString();
  // Return any capacity held by abandoned checkouts before claiming a new slot.
  const expiredReleased = await releaseExpiredCampusHolds(turso, { rideId: match.id, nowIso: stamp });
  if (expiredReleased > 0) await incrementMetric("queue_expired_released", expiredReleased);
  const claim = await claimCampusQueueSlot(turso, { rideId: match.id, nowIso: stamp });
  if (!claim.ok) {
    await incrementMetric("queue_claim_failed");
    throw new CampusEngineError("NO_DRIVER_FOUND", "This ride is full. Please choose another campusRide.", 409);
  }
  await incrementMetric("queue_claim");
  const queuePosition = claim.position;
  const queueEntryId = crypto.randomUUID();
  const expiresAt = campusHoldExpiry(Date.parse(stamp));
  try {
    await turso(
      "INSERT INTO campus_queue_entries (id,reference,ride_id,corridor_id,passenger_name,phone,email,pickup_zone_id,destination_zone_id,queue_position,amount,payment_status,queue_status,ride_pin,ticket_image_ready,created_at,updated_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [queueEntryId, reference, match.id, match.corridorId, passengerName, phone, email, pickupZoneId, destinationZoneId, queuePosition, quote.total, "WAITING_PAYMENT", "WAITING_PAYMENT", pin, 0, stamp, stamp, expiresAt],
    );
  } catch (error) {
    // Never leak the reserved slot if the entry could not be persisted.
    await releaseCampusSlots(turso, { rideId: match.id, count: 1, nowIso: stamp }).catch(() => undefined);
    throw error;
  }
  await campusAudit({ actorType:"student", actorId:phone, action:"REQUEST_RIDE", targetType:"campus_queue_entry", targetReference:reference, details:{ rideId:match.id, pickupZoneId, destinationZoneId, amount:quote.total, requestId: input.requestId || "" } });
  return { queueEntryId, reference, pin, paymentRequired: true, quote, match, queuePosition, preview: false };
}

export function mapQueueEntry(row: Record<string, unknown>): CampusQueueEntry {
  return { id:String(row.id), reference:String(row.reference), rideId:String(row.ride_id || ""), corridorId:String(row.corridor_id), passengerName:String(row.passenger_name), phone:String(row.phone), email:String(row.email || ""), pickupZoneId:String(row.pickup_zone_id), destinationZoneId:String(row.destination_zone_id), pickupZone:String(row.pickup_zone || ""), destinationZone:String(row.destination_zone || ""), queuePosition:Number(row.queue_position), amount:Number(row.amount), paymentStatus:String(row.payment_status), queueStatus:String(row.queue_status), ridePin:String(row.ride_pin || ""), acceptedAt:String(row.accepted_at || ""), arrivedAt:String(row.arrived_at || ""), boardedAt:String(row.boarded_at || ""), completedAt:String(row.completed_at || ""), cancelledAt:String(row.cancelled_at || ""), createdAt:String(row.created_at) };
}

export async function initializeCampusRideQueue(input: { passengerName?: string; phone?: string; email?: string; pickupZoneId?: string; destinationZoneId?: string; rideId?: string; pickupLatitude?: number; pickupLongitude?: number; origin: string; secure: boolean; requestId?: string }) {
  const ride = await requestCampusRide(input);
  // Money path: a preview (no Turso) must fail closed, never silently pretend
  // a queue entry exists.
  if (ride.preview || !ride.queueEntryId) throw new CampusEngineError("CONFIG_REQUIRED", "campusRide payments are not configured. Configure Turso and Paystack before accepting rides.", 503);
  const provider = await getPaymentProviderRuntime();
  if (provider !== "PAYSTACK") throw new CampusEngineError("CONFIG_REQUIRED", "campusRide currently requires Paystack payments.", 503);
  const accessToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  const accessTokenHash = await hashPaymentToken(accessToken);
  const paymentReference = crypto.randomUUID();
  const stamp = new Date().toISOString();
  const currency = await getPaystackCurrencyRuntime();
  await turso(
    "INSERT INTO campus_payments (id,queue_entry_id,reference,provider,amount,currency,status,access_token_hash,fare_amount,fee_amount,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    [crypto.randomUUID(), ride.queueEntryId, paymentReference, provider, ride.quote.total, currency, "PENDING", accessTokenHash, ride.quote.subtotal, ride.quote.paystackFee, stamp, stamp],
  );
  const paystack = await initializePaystackTransaction({
    email: input.email || `${String(input.phone || "student").replace(/\D/g, "") || "student"}@campusride.local`,
    amount: ride.quote.total,
    reference: paymentReference,
    callbackUrl: `${input.origin}/campus/ticket?reference=${encodeURIComponent(paymentReference)}`,
    metadata: { module:"campusRide", queueReference: ride.reference, rideId: ride.match.id, pickupZoneId: String(input.pickupZoneId || ""), destinationZoneId: String(input.destinationZoneId || ""), fareAmount: ride.quote.subtotal, paystackFee: ride.quote.paystackFee },
  });
  await turso("UPDATE campus_payments SET authorization_url = ?, updated_at = ? WHERE reference = ?", [paystack.authorizationUrl, new Date().toISOString(), paymentReference]);
  return { ...ride, provider, paymentReference, authorizationUrl: paystack.authorizationUrl, message:"Redirecting to Paystack Checkout.", cookie: paymentAccessCookie(paymentReference, accessToken, input.secure) };
}

export async function markCampusRidePaymentSuccessful(reference: string, amount: number, transactionId: string, requestId = "") {
  await ensureCampusRideTables();
  const payment = rowsToObjects(await turso("SELECT id,queue_entry_id,reference,provider,amount,status FROM campus_payments WHERE reference = ? AND provider = 'PAYSTACK' LIMIT 1", [reference]))[0];
  if (!payment) return { handled: false, reason: "CAMPUS_PAYMENT_NOT_FOUND" };
  const stamp = new Date().toISOString();
  const entryId = String(payment.queue_entry_id);
  const expectedAmount = Number(payment.amount || 0);
  if (Number(amount || 0) !== expectedAmount) {
    await turso("UPDATE campus_payments SET status = 'PAID_REVIEW', raw_response = ?, paid_at = ?, updated_at = ? WHERE reference = ? AND status <> 'SUCCESSFUL'", [`PAYSTACK_AMOUNT_MISMATCH:${transactionId}`, stamp, stamp, reference]);
    await turso("UPDATE campus_queue_entries SET payment_status = 'SUCCESSFUL', queue_status = 'PAYMENT_RECEIVED_REVIEW', ticket_image_ready = 1, updated_at = ? WHERE id = ? AND queue_status = 'WAITING_PAYMENT'", [stamp, entryId]);
    await incrementMetric("payment_review");
    await campusAudit({ actorType:"system", action:"CAMPUS_PAYMENT_REVIEW", targetType:"campus_payment", targetReference:reference, details:{ expectedAmount, receivedAmount:amount, reason:"PAYSTACK_AMOUNT_MISMATCH", requestId } });
    return { handled: true, status: "PAID_REVIEW" };
  }
  // The slot was already reserved at claim time, so success never touches capacity.
  const claimed = await applyCampusQueueTransition(turso, { entryId, from: "WAITING_PAYMENT", to: "PAID_WAITING", paymentStatus: "SUCCESSFUL", ticketReady: true, nowIso: stamp });
  if (!claimed) {
    const state = await campusQueueEntryState(turso, entryId);
    if (state && ["PAID_WAITING","ACCEPTED_BY_DRIVER","DRIVER_ARRIVED","BOARDED","COMPLETED"].includes(state.queueStatus)) {
      return { handled: true, status: "SUCCESSFUL" };
    }
    // The hold expired and its slot was returned: flag for manual resolution.
    await turso("UPDATE campus_payments SET status = 'PAID_REVIEW', raw_response = ?, paid_at = ?, updated_at = ? WHERE reference = ? AND status <> 'SUCCESSFUL'", [`PAYSTACK_HOLD_EXPIRED:${transactionId}`, stamp, stamp, reference]);
    await turso("UPDATE campus_queue_entries SET payment_status = 'SUCCESSFUL', queue_status = 'PAYMENT_RECEIVED_REVIEW', ticket_image_ready = 1, updated_at = ? WHERE id = ?", [stamp, entryId]);
    await incrementMetric("payment_review");
    await campusAudit({ actorType:"system", action:"CAMPUS_PAYMENT_REVIEW", targetType:"campus_payment", targetReference:reference, details:{ reason:"PAYSTACK_HOLD_EXPIRED", transactionId, requestId } });
    return { handled: true, status: "PAID_REVIEW" };
  }
  await turso("UPDATE campus_payments SET status = 'SUCCESSFUL', raw_response = ?, paid_at = ?, updated_at = ? WHERE reference = ? AND status <> 'SUCCESSFUL'", [transactionId || "PAYSTACK_SUCCESS", stamp, stamp, reference]);
  await incrementMetric("payment_success");
  await campusAudit({ actorType:"system", action:"PAYMENT_SUCCESS", targetType:"campus_payment", targetReference:reference, details:{ amount:payment.amount, requestId } });
  return { handled: true, status: "SUCCESSFUL" };
}

export async function markCampusRidePaymentFailed(reference: string, reason: string, transactionId: string, requestId = "") {
  await ensureCampusRideTables();
  const payment = rowsToObjects(await turso("SELECT p.queue_entry_id, q.ride_id FROM campus_payments p LEFT JOIN campus_queue_entries q ON q.id = p.queue_entry_id WHERE p.reference = ? AND p.provider = 'PAYSTACK' LIMIT 1", [reference]))[0];
  if (!payment) return { handled: false, reason: "CAMPUS_PAYMENT_NOT_FOUND" };
  const stamp = new Date().toISOString();
  const entryId = String(payment.queue_entry_id);
  // Release the held slot exactly once; a replay finds the entry already terminal.
  const released = await applyCampusQueueTransition(turso, { entryId, from: "WAITING_PAYMENT", to: "PAYMENT_FAILED", paymentStatus: "FAILED", nowIso: stamp });
  if (released && payment.ride_id) await releaseCampusSlots(turso, { rideId: String(payment.ride_id), count: 1, nowIso: stamp });
  await turso("UPDATE campus_payments SET status = 'FAILED', raw_response = ?, updated_at = ? WHERE reference = ? AND status <> 'SUCCESSFUL'", [transactionId || reason || "PAYSTACK_PAYMENT_FAILED", stamp, reference]);
  await incrementMetric("payment_failed");
  await campusAudit({ actorType:"system", action:"PAYMENT_FAILED", targetType:"campus_payment", targetReference:reference, details:{ reason, requestId } });
  return { handled: true, status: "FAILED" };
}

export async function verifyCampusRidePayment(request: Request, reference: string) {
  if (!reference) throw new CampusEngineError("VALIDATION_ERROR", "Missing campusRide payment reference.", 400);
  if (!(await isTursoConfiguredRuntime())) throw new CampusEngineError("CONFIG_REQUIRED", "Configure Turso before verifying campusRide payments.", 503);
  await ensureCampusRideTables();
  const payment = rowsToObjects(await turso("SELECT id,queue_entry_id,reference,provider,amount,currency,status,access_token_hash FROM campus_payments WHERE reference = ? LIMIT 1", [reference]))[0];
  if (!payment) throw new CampusEngineError("NOT_FOUND", "campusRide payment was not found.", 404);
  const token = paymentTokenFromRequest(request, reference);
  let authorised = false;
  if (token && payment.access_token_hash) {
    authorised = await hashPaymentToken(token) === String(payment.access_token_hash);
  }
  // The token is the guest's key and lasts an hour; a student who signed in
  // keeps access to their own ticket without it, because the queue entry was
  // created under their account's address. That is what lets a emailed ticket
  // link, or the profile's saved-ticket link, work on another device or later
  // in the week. The lookup only runs when the token is missing or stale.
  if (!authorised) {
    const owner = rowsToObjects(await turso("SELECT email FROM campus_queue_entries WHERE id = ? LIMIT 1", [String(payment.queue_entry_id)]))[0];
    if (!(await studentOwnsEmail(request, owner?.email))) {
      throw new CampusEngineError("FORBIDDEN", "campusRide payment access is not authorised.", 403);
    }
  }
  let status = String(payment.status || "PENDING").toUpperCase();
  const stamp = new Date().toISOString();
  const requestId = requestIdFromRequest(request);
  if (status !== "SUCCESSFUL" && status !== "FAILED" && status !== "PAID_REVIEW") {
    const providerStatus = await verifyPaystackTransaction(reference);
    status = String(providerStatus.status || "PENDING").toUpperCase();
    if (status === "SUCCESSFUL") {
      const applied = await markCampusRidePaymentSuccessful(reference, Number(providerStatus.amount), providerStatus.financialTransactionId || "", requestId);
      status = String(applied?.status || "SUCCESSFUL").toUpperCase();
    } else if (status === "FAILED") {
      await markCampusRidePaymentFailed(reference, providerStatus.reason || "PAYMENT_FAILED", providerStatus.financialTransactionId || "", requestId);
    } else {
      await turso("UPDATE campus_payments SET status = 'PENDING', updated_at = ? WHERE reference = ?", [stamp, reference]);
    }
  }
  const ticket = rowsToObjects(await turso(
    `SELECT q.reference,q.passenger_name,q.phone,q.email,q.queue_position,q.amount,q.payment_status,q.queue_status,q.ride_pin,q.created_at,
      p.reference AS payment_reference,r.id AS ride_id,COALESCE(d.name,'Driver pending') AS driver_name,COALESCE(v.label,'Vehicle pending') AS vehicle_label,COALESCE(v.plate_number,'') AS plate_number,
      oz.name AS pickup_zone,dz.name AS destination_zone,c.name AS corridor_name
     FROM campus_queue_entries q
     JOIN campus_payments p ON p.queue_entry_id = q.id
     LEFT JOIN campus_rides r ON r.id = q.ride_id
     LEFT JOIN campus_drivers d ON d.id = r.driver_id
     LEFT JOIN campus_vehicles v ON v.id = r.vehicle_id
     LEFT JOIN campus_zones oz ON oz.id = q.pickup_zone_id
     LEFT JOIN campus_zones dz ON dz.id = q.destination_zone_id
     LEFT JOIN campus_route_corridors c ON c.id = q.corridor_id
     WHERE p.reference = ? LIMIT 1`,
    [reference],
  ))[0];
  return { paid: status === "SUCCESSFUL", status, reference, ticket };
}
