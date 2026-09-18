import { logEvent } from "@/lib/observability";
import { listPaystackBanks } from "@/lib/paystack";
import { envValue } from "@/lib/runtime-env";

/**
 * Where an organizer can be paid.
 *
 * A Paystack transfer recipient is addressed by a `bank_code`, not by an
 * account number on its own, so the payout form has to capture which
 * institution the number belongs to. The catalogue below is Ghana's, copied
 * from Paystack's own list, and it is a fallback rather than the source of
 * truth: the live list is preferred because Paystack adds and retires
 * institutions without telling anyone. It exists so that an unreachable
 * Paystack does not stop an organizer from recording where their money should
 * go — the alternative is a payout that can never be addressed.
 */

export const PAYOUT_METHODS = ["BANK", "MOMO"] as const;
export type PayoutMethod = (typeof PAYOUT_METHODS)[number];

export type PayoutDestination = { code: string; name: string };

export function isPayoutMethod(value: unknown): value is PayoutMethod {
  return (PAYOUT_METHODS as readonly string[]).includes(String(value || "").trim().toUpperCase());
}

/** A bank account is a GhIPSS transfer; mobile money is its own recipient type. */
export function recipientTypeFor(method: PayoutMethod) {
  return method === "BANK" ? "ghipss" : "mobile_money";
}

const FALLBACK_BANKS: PayoutDestination[] = [
  { code: "030100", name: "Absa Bank Ghana Ltd" },
  { code: "280100", name: "Access Bank" },
  { code: "080100", name: "ADB Bank Limited" },
  { code: "300345", name: "Adehyeman Savings and Loans LTD" },
  { code: "300341", name: "Affinity Ghana Savings and Loans" },
  { code: "070101", name: "ARB Apex Bank" },
  { code: "210100", name: "Bank of Africa Ghana" },
  { code: "010100", name: "Bank of Ghana" },
  { code: "300335", name: "Best Point Savings & Loans" },
  { code: "140100", name: "CAL Bank Limited" },
  { code: "340100", name: "Consolidated Bank Ghana Limited" },
  { code: "130100", name: "Ecobank Ghana Limited" },
  { code: "200100", name: "FBNBank Ghana Limited" },
  { code: "240100", name: "Fidelity Bank Ghana Limited" },
  { code: "170100", name: "First Atlantic Bank Limited" },
  { code: "330100", name: "First National Bank Ghana Limited" },
  { code: "040100", name: "GCB Bank Limited" },
  { code: "230100", name: "Guaranty Trust Bank (Ghana) Limited" },
  { code: "050100", name: "National Investment Bank Limited" },
  { code: "360100", name: "OmniBSCI Bank" },
  { code: "300457", name: "Paystack Limited" },
  { code: "180100", name: "Prudential Bank Limited" },
  { code: "110100", name: "Republic Bank (GH) Limited" },
  { code: "300361", name: "Services Integrity Savings and Loans" },
  { code: "240092", name: "Sinapi ABA Savings And Loans" },
  { code: "090100", name: "Société Générale Ghana Limited" },
  { code: "190100", name: "Stanbic Bank Ghana Limited" },
  { code: "020100", name: "Standard Chartered Bank Ghana Limited" },
  { code: "060100", name: "United Bank for Africa Ghana Limited" },
  { code: "100100", name: "Universal Merchant Bank Ghana Limited" },
  { code: "120100", name: "Zenith Bank Ghana" },
];

const FALLBACK_MOMO: PayoutDestination[] = [
  { code: "MTN", name: "MTN" },
  { code: "VOD", name: "Vodafone" },
  { code: "ATL", name: "AirtelTigo" },
];

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/** A failed lookup is remembered only briefly, so one bad minute is not a bad day. */
const FAILURE_TTL_MS = 60 * 1000;

let cachedBanks: { at: number; rows: CatalogueRow[] } | null = null;
let failedAt = 0;

type CatalogueRow = PayoutDestination & { type: string };

function fallbackFor(method: PayoutMethod): PayoutDestination[] {
  return method === "BANK" ? FALLBACK_BANKS : FALLBACK_MOMO;
}

/**
 * The live catalogue, or `null` when Paystack cannot be reached. A currency
 * other than GHS has no offline list at all: the codes differ per country and
 * guessing them would address a transfer to the wrong institution.
 */
async function liveBanks(currency: string): Promise<CatalogueRow[] | null> {
  const wanted = currency.toUpperCase();
  const now = Date.now();
  if (cachedBanks && now - cachedBanks.at < CACHE_TTL_MS) return cachedBanks.rows;
  if (failedAt && now - failedAt < FAILURE_TTL_MS) return null;
  try {
    const rows = await listPaystackBanks(wanted);
    const wantedType = wanted === "GHS" ? "ghipss" : null;
    const mapped: CatalogueRow[] = rows
      .filter((row) => (wantedType ? row.type === wantedType || row.type === "mobile_money" : true))
      .map((row) => ({ code: row.code, name: row.name, type: row.type }));
    cachedBanks = { at: now, rows: mapped };
    return mapped;
  } catch (error) {
    failedAt = now;
    logEvent("warn", "payout_bank_list_unavailable", { currency: wanted, reason: error instanceof Error ? error.message : "unknown" });
    return null;
  }
}

/**
 * What the payout form offers. Sorted by name so the list reads like a bank
 * branch rather than like an API response.
 */
export async function listPayoutDestinations(method: PayoutMethod): Promise<PayoutDestination[]> {
  const currency = (await envValue("PAYSTACK_CURRENCY")) || "GHS";
  const live = await liveBanks(currency);
  if (live) {
    const wanted = method === "BANK" ? "ghipss" : "mobile_money";
    const rows = live.filter((row) => row.type === wanted).map((row) => ({ code: row.code, name: row.name }));
    if (rows.length) return rows.sort((left, right) => left.name.localeCompare(right.name));
  }
  // Only Ghana has an offline list, and only until Paystack answers with one.
  if (currency.toUpperCase() !== "GHS") return [];
  return [...fallbackFor(method)].sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Resolves a submitted code against the catalogue, so a payout account can
 * never point at an institution Paystack does not know. Returns null when the
 * code is not offered for that method.
 */
export async function findPayoutDestination(method: PayoutMethod, code: unknown): Promise<PayoutDestination | null> {
  const wanted = String(code || "").trim().toUpperCase();
  if (!wanted) return null;
  const destinations = await listPayoutDestinations(method);
  return destinations.find((row) => row.code.toUpperCase() === wanted) || null;
}
