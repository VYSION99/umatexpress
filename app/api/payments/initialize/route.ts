import { ensureBookingsTable, ensurePaymentsTable, turso } from "@/lib/turso";
import { getMomoCurrency, normalizeGhanaPhone, requestToPay } from "@/lib/mtn-momo";
import { getPaymentProvider, getPaystackCurrency, initializePaystackTransaction } from "@/lib/paystack";
import { hashPaymentToken, paymentAccessCookie } from "@/lib/payment-access";
import { getTrip, isValidTravelDate } from "@/lib/trips";
import { departureForTrip, getTripSettings, tripIsEnabled } from "@/lib/trip-settings";

function cleanText(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function errorStatus(error: unknown) {
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
  let bookingId = "";
  try {
    const body = await request.json() as Record<string, unknown>;
    const name = cleanText(body.name, 100);
    const email = cleanText(body.email, 254).toLowerCase();
    const travelDate = cleanText(body.travelDate, 10);
    const seat = Number(body.seat);
    const tripId = Number(body.tripId);
    const trip = getTrip(tripId);

    if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return Response.json({ error: "Enter a valid passenger name and email address." }, { status: 400 });
    }
    if (!Number.isInteger(seat) || seat < 1 || seat > 50) {
      return Response.json({ error: "Choose a valid seat from 1 to 50." }, { status: 400 });
    }
    if (!trip) return Response.json({ error: "Choose a valid trip." }, { status: 400 });
    const tripSettings = await getTripSettings();
    if (!tripIsEnabled(tripSettings.mode, tripId)) {
      return Response.json({ error: "That departure is not currently open for booking." }, { status: 409 });
    }
    if (!isValidTravelDate(travelDate)) {
      return Response.json({ error: "That travel date is not available." }, { status: 400 });
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
    const provider = getPaymentProvider();
    const currency = provider === "PAYSTACK" ? getPaystackCurrency() : getMomoCurrency();

    try {
      await turso(
        "INSERT INTO seat_holds (id, booking_id, trip_id, travel_date, seat, status, expires_at, created_at) VALUES (?, ?, ?, ?, ?, 'HELD', ?, ?)",
        [crypto.randomUUID(), bookingId, tripId, travelDate, seat, holdExpiresAt, nowIso],
      );
    } catch {
      return Response.json({ error: "That seat has just been reserved. Please choose another seat." }, { status: 409 });
    }

    try {
      await turso(
        "INSERT INTO bookings (id, reference, passenger_name, email, phone, seat, trip_id, travel_date, amount, payment_status, booking_status, hold_expires_at, departure_time, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [bookingId, bookingReference, name, email, phone, seat, tripId, travelDate, ticketAmount, "PENDING", "AWAITING_PAYMENT", holdExpiresAt, departureForTrip(tripSettings, tripId), nowIso],
      );
      await turso(
        "INSERT INTO payments (id, booking_id, provider, reference_id, external_id, payer_phone, amount, currency, status, access_token_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [crypto.randomUUID(), bookingId, provider, paymentReference, bookingReference, phone, ticketAmount, currency, "PENDING", accessTokenHash, nowIso, nowIso],
      );
      if (provider === "PAYSTACK") {
        const paystack = await initializePaystackTransaction({
          email,
          amount: ticketAmount,
          reference: paymentReference,
          callbackUrl: `${new URL(request.url).origin}/payment/callback?reference=${encodeURIComponent(paymentReference)}`,
          metadata: { bookingReference, passengerName: name, phone, seat, tripId, travelDate },
        });
        return Response.json({ reference: paymentReference, status: "PENDING", provider, authorizationUrl: paystack.authorizationUrl, message: "Redirecting to Paystack Checkout." }, {
          status: 202,
          headers: { "Set-Cookie": paymentAccessCookie(paymentReference, accessToken, new URL(request.url).protocol === "https:"), "Cache-Control": "no-store" },
        });
      } else {
        await requestToPay({
          referenceId: paymentReference,
          externalId: bookingReference,
          amount: (ticketAmount / 100).toFixed(2),
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

    return Response.json({ reference: paymentReference, status: "PENDING", message: "Payment request sent. Approve the MTN MoMo prompt on your phone." }, {
      status: 202,
      headers: { "Set-Cookie": paymentAccessCookie(paymentReference, accessToken, new URL(request.url).protocol === "https:"), "Cache-Control": "no-store" },
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Payment could not start." }, { status: errorStatus(error) });
  }
}
