import { ensureBookingsTable, ensurePaymentsTable, turso } from "@/lib/turso";
import { getMomoCurrencyRuntime, normalizeGhanaPhone, requestToPay } from "@/lib/mtn-momo";
import { calculatePaystackCharge, getPaymentProviderRuntime, getPaystackCurrencyRuntime, getPaystackFeePercentRuntime, initializePaystackTransaction } from "@/lib/paystack";
import { hashPaymentToken, paymentAccessCookie } from "@/lib/payment-access";
import { getDynamicTrip } from "@/lib/dynamic-trips";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { requireStudent } from "@/lib/student-auth";
import { CampusEngineError } from "@/lib/campus-engine/errors";
import { requestIdFromRequest, withRequestId } from "@/lib/observability";

function cleanText(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function errorStatus(error: unknown) {
  if (error instanceof CampusEngineError) return error.status;
  const message = error instanceof Error ? error.message : "";
  if (message.includes("Turso") || message.includes("valid Turso credentials")) return 503;
  if (message.includes("MTN MoMo is not configured")) return 503;
  if (message.includes("Paystack is not configured")) return 503;
  if (message.includes("MTN token request failed") || message.includes("MTN RequestToPay failed")) return 502;
  if (message.includes("Paystack initialize failed")) return 502;
  if (message.includes("valid Ghanaian mobile number")) return 400;
  return 500;
}

export async function POST(request: Request) {
  const requestId = requestIdFromRequest(request);
  const respond = (body: unknown, init?: ResponseInit) => withRequestId(Response.json(body, init), requestId);
  let bookingId = "";
  try {
    const limited = await rateLimit(request, "payment-initialize", { limit: 20, windowMs: 10 * 60_000 });
    if (!limited.ok) return rateLimitResponse(limited.retryAfter);
    const body = await request.json() as Record<string, unknown>;
    // Booking is the only gated action: anyone may browse trips and seats, but a
    // passenger must hold a UMaTeXPRESS student account to hold a seat and pay.
    const student = await requireStudent(request);
    const name = cleanText(body.name, 100) || student.name;
    const submittedEmail = cleanText(body.email, 254).toLowerCase();
    // The receipt address is the account address, so a booking can never be made
    // under someone else's email.
    const email = student.email;
    if (submittedEmail && submittedEmail !== email) {
      return respond({ error: "Book with the email on your account." }, { status: 400 });
    }
    const travelDate = cleanText(body.travelDate, 10);
    const seat = Number(body.seat);
    const tripId = cleanText(body.tripId, 80);
    const trip = await getDynamicTrip(tripId);

    if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return respond({ error: "Enter a valid passenger name and email address." }, { status: 400 });
    }
    if (!trip || !trip.active) return respond({ error: "Choose a valid trip." }, { status: 400 });
    if (!Number.isInteger(seat) || seat < 1 || seat > trip.capacity) {
      return respond({ error: `Choose a valid seat from 1 to ${trip.capacity}.` }, { status: 400 });
    }
    if (trip.travelDate !== travelDate) {
      return respond({ error: "That travel date is not available." }, { status: 400 });
    }

    const phoneText = cleanText(body.phone, 30);
    const phone = normalizeGhanaPhone(phoneText);
    const ticketAmount = trip.price * 100;
    await ensureBookingsTable();
    await ensurePaymentsTable();

    const now = new Date();
    const nowIso = now.toISOString();
    await turso("DELETE FROM seat_holds WHERE status = 'HELD' AND expires_at < ?", [nowIso]);

    bookingId = crypto.randomUUID();
    const bookingReference = `UMX-${Date.now()}-${seat}`;
    const paymentReference = crypto.randomUUID();
    const accessToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
    const accessTokenHash = await hashPaymentToken(accessToken);
    const holdExpiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
    const provider = await getPaymentProviderRuntime();
    const currency = provider === "PAYSTACK" ? await getPaystackCurrencyRuntime() : await getMomoCurrencyRuntime();
    const paystackCharge = provider === "PAYSTACK" ? calculatePaystackCharge(ticketAmount, await getPaystackFeePercentRuntime()) : null;
    const payableAmount = paystackCharge?.totalAmount ?? ticketAmount;

    try {
      await turso(
        "INSERT INTO seat_holds (id, booking_id, trip_id, travel_date, seat, status, expires_at, created_at) VALUES (?, ?, ?, ?, ?, 'HELD', ?, ?)",
        [crypto.randomUUID(), bookingId, tripId, travelDate, seat, holdExpiresAt, nowIso],
      );
    } catch {
      return respond({ error: "That seat has just been reserved. Please choose another seat." }, { status: 409 });
    }

    try {
      await turso(
        "INSERT INTO bookings (id, reference, passenger_name, email, phone, seat, trip_id, travel_date, amount, payment_status, booking_status, hold_expires_at, departure_time, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [bookingId, bookingReference, name, email, phone, seat, tripId, travelDate, payableAmount, "PENDING", "AWAITING_PAYMENT", holdExpiresAt, trip.time, nowIso],
      );
      await turso(
        "INSERT INTO payments (id, booking_id, provider, reference_id, external_id, payer_phone, amount, currency, status, access_token_hash, fare_amount, fee_amount, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [crypto.randomUUID(), bookingId, provider, paymentReference, bookingReference, phone, payableAmount, currency, "PENDING", accessTokenHash, ticketAmount, paystackCharge?.feeAmount || 0, nowIso, nowIso],
      );
      if (provider === "PAYSTACK") {
        const paystack = await initializePaystackTransaction({
          email,
          amount: payableAmount,
          reference: paymentReference,
          callbackUrl: `${new URL(request.url).origin}/payment/callback?reference=${encodeURIComponent(paymentReference)}`,
          metadata: { bookingReference, passengerName: name, phone, seat, tripId, travelDate, fareAmount: ticketAmount, paystackFee: paystackCharge?.feeAmount || 0 },
        });
        return respond({ reference: paymentReference, status: "PENDING", provider, authorizationUrl: paystack.authorizationUrl, fareAmount: ticketAmount, feeAmount: paystackCharge?.feeAmount || 0, totalAmount: payableAmount, message: "Redirecting to Paystack Checkout." }, {
          status: 202,
          headers: { "Set-Cookie": paymentAccessCookie(paymentReference, accessToken, new URL(request.url).protocol === "https:"), "Cache-Control": "no-store" },
        });
      } else {
        await requestToPay({
          referenceId: paymentReference,
          externalId: bookingReference,
          amount: (payableAmount / 100).toFixed(2),
          phone,
          payerMessage: "UMaTeXPRESS student transport payment",
          payeeNote: `UMaTeXPRESS booking ${bookingReference}`,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Payment initialization failed.";
      await turso("UPDATE payments SET status = 'FAILED', failure_reason = ?, updated_at = ?, completed_at = ? WHERE reference_id = ?", [message, new Date().toISOString(), new Date().toISOString(), paymentReference]).catch(() => undefined);
      await turso("UPDATE bookings SET payment_status = 'FAILED' WHERE id = ?", [bookingId]).catch(() => undefined);
      await turso("DELETE FROM seat_holds WHERE booking_id = ?", [bookingId]).catch(() => undefined);
      throw error;
    }

    return respond({ reference: paymentReference, status: "PENDING", message: "Payment request sent. Approve the MTN MoMo prompt on your phone." }, {
      status: 202,
      headers: { "Set-Cookie": paymentAccessCookie(paymentReference, accessToken, new URL(request.url).protocol === "https:"), "Cache-Control": "no-store" },
    });
  } catch (error) {
    return respond({ error: error instanceof Error ? error.message : "Payment could not start." }, { status: errorStatus(error) });
  }
}
