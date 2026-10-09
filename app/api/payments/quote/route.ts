import { calculatePaystackCharge, getPaystackFeePercentRuntime } from "@/lib/paystack";

/** The same fee calculation used when the server initializes checkout. */
export async function GET(request: Request) {
  const value = new URL(request.url).searchParams.get("amount");
  const amount = Number(value);
  if (!value || !Number.isSafeInteger(amount) || amount < 0 || amount > 100_000_000) {
    return Response.json({ error: "Enter a valid amount in pesewas." }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  const quote = calculatePaystackCharge(amount, await getPaystackFeePercentRuntime());
  return Response.json({ ...quote, currency: "GHS" }, { headers: { "Cache-Control": "no-store" } });
}
