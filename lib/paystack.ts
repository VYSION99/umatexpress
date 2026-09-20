import { envValue } from "@/lib/runtime-env";

const DEFAULT_BASE_URL = "https://api.paystack.co";
const DEFAULT_PAYSTACK_FEE_PERCENT = 1.95;

type PaystackInitializeResponse = {
  status?: boolean;
  message?: string;
  data?: { authorization_url?: string; access_code?: string; reference?: string };
};

type PaystackVerifyResponse = {
  status?: boolean;
  message?: string;
  data?: {
    id?: number;
    reference?: string;
    amount?: number;
    currency?: string;
    status?: "success" | "failed" | "abandoned" | "reversed" | "pending" | "ongoing" | "processing" | "queued";
    gateway_response?: string;
  };
};

function getConfig() {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  const baseUrl = (process.env.PAYSTACK_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");
  const currency = process.env.PAYSTACK_CURRENCY || "GHS";
  if (!secretKey || secretKey.startsWith("replace-with")) throw new Error("Paystack is not configured yet.");
  return { secretKey, baseUrl, currency };
}

async function getRuntimeConfig() {
  const secretKey = await envValue("PAYSTACK_SECRET_KEY");
  const baseUrl = (await envValue("PAYSTACK_BASE_URL") || DEFAULT_BASE_URL).replace(/\/$/, "");
  const currency = await envValue("PAYSTACK_CURRENCY") || "GHS";
  if (!secretKey || secretKey.startsWith("replace-with")) throw new Error("Paystack is not configured yet.");
  return { secretKey, baseUrl, currency };
}

function hex(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function safeEqual(left: string, right: string) {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < Math.max(leftBytes.length, rightBytes.length); index++) {
    difference |= (leftBytes[index] || 0) ^ (rightBytes[index] || 0);
  }
  return difference === 0;
}

export async function verifyPaystackWebhookSignature(rawBody: string, suppliedSignature: string | null) {
  if (!suppliedSignature) return false;
  const { secretKey } = await getRuntimeConfig();
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secretKey), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  return safeEqual(hex(signature), suppliedSignature.trim().toLowerCase());
}

export function getPaymentProvider() {
  // Paystack is the platform default. MTN MoMo stays reachable, but only when a
  // deployment asks for it by name: a missing variable must never silently
  // route checkout to a provider nobody configured.
  return (process.env.PAYMENT_PROVIDER || "PAYSTACK").toUpperCase() === "PAYSTACK" ? "PAYSTACK" : "MTN_MOMO";
}

export async function getPaymentProviderRuntime() {
  return (await envValue("PAYMENT_PROVIDER") || "PAYSTACK").toUpperCase() === "PAYSTACK" ? "PAYSTACK" : "MTN_MOMO";
}

export function getPaystackCurrency() {
  return getConfig().currency;
}

export async function getPaystackCurrencyRuntime() {
  return (await getRuntimeConfig()).currency;
}

export function getPaystackFeePercent() {
  const value = Number(process.env.PAYSTACK_FEE_PERCENT || DEFAULT_PAYSTACK_FEE_PERCENT);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_PAYSTACK_FEE_PERCENT;
}

export async function getPaystackFeePercentRuntime() {
  const value = Number(await envValue("PAYSTACK_FEE_PERCENT") || DEFAULT_PAYSTACK_FEE_PERCENT);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_PAYSTACK_FEE_PERCENT;
}

export function calculatePaystackCharge(baseAmount: number, feePercent = getPaystackFeePercent()) {
  const safeBaseAmount = Math.max(0, Math.round(baseAmount));
  const rate = Math.max(0, feePercent) / 100;
  if (!safeBaseAmount || !rate) return { baseAmount: safeBaseAmount, feeAmount: 0, totalAmount: safeBaseAmount, feePercent };
  const totalAmount = Math.ceil(safeBaseAmount / (1 - rate));
  return { baseAmount: safeBaseAmount, feeAmount: totalAmount - safeBaseAmount, totalAmount, feePercent };
}

export async function initializePaystackTransaction(input: {
  email: string;
  amount: number;
  reference: string;
  callbackUrl: string;
  metadata: Record<string, string | number>;
}) {
  const { secretKey, baseUrl, currency } = await getRuntimeConfig();
  const response = await fetch(`${baseUrl}/transaction/initialize`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: input.email,
      amount: input.amount,
      currency,
      reference: input.reference,
      callback_url: input.callbackUrl,
      metadata: input.metadata,
    }),
  });
  const result = await response.json().catch(() => ({})) as PaystackInitializeResponse;
  if (!response.ok || !result.status || !result.data?.authorization_url) {
    throw new Error(result.message || `Paystack initialize failed (${response.status}).`);
  }
  return {
    authorizationUrl: result.data.authorization_url,
    accessCode: result.data.access_code || "",
    reference: result.data.reference || input.reference,
    currency,
  };
}

export async function verifyPaystackTransaction(reference: string) {
  const { secretKey, baseUrl } = await getRuntimeConfig();
  const response = await fetch(`${baseUrl}/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${secretKey}` },
  });
  const result = await response.json().catch(() => ({})) as PaystackVerifyResponse;
  if (!response.ok || !result.status || !result.data) {
    throw new Error(result.message || `Paystack verify failed (${response.status}).`);
  }
  return {
    status: result.data.status === "success" ? "SUCCESSFUL" : result.data.status === "failed" || result.data.status === "abandoned" ? "FAILED" : "PENDING",
    financialTransactionId: result.data.id ? String(result.data.id) : "",
    amount: Number(result.data.amount || 0),
    currency: result.data.currency || "",
    reason: result.data.gateway_response || result.message || "",
  };
}

/* ------------------------------------------------------------------ *
 * Payouts: recipients, transfers and the balance they draw on.
 *
 * Transfers are a separate Paystack permission from collecting payments, and
 * a recipient is addressed by a `bank_code` rather than by an account number
 * alone. Everything here is server-only: the secret key is never sent to the
 * browser, and an account number only ever appears in a request body.
 * ------------------------------------------------------------------ */

type PaystackTransferRecipient = {
  recipient_code?: string;
  type?: string;
  currency?: string;
  details?: { account_number?: string; bank_code?: string; bank_name?: string };
};

type PaystackRecipientResponse = { status?: boolean; message?: string; data?: PaystackTransferRecipient };

type PaystackTransferResponse = {
  status?: boolean;
  message?: string;
  data?: {
    transfer_code?: string;
    reference?: string;
    amount?: number;
    status?: string;
    reason?: string;
    recipient?: string | { recipient_code?: string };
  };
};

export type PaystackTransferStatus = "SUCCESS" | "FAILED" | "PENDING" | "REVERSED" | "UNKNOWN";

/** Paystack's transfer webhook calls a completed transfer `success`. */
export function normalizeTransferStatus(value: unknown): PaystackTransferStatus {
  switch (String(value || "").toLowerCase()) {
    case "success":
    case "successful":
    case "completed":
      return "SUCCESS";
    case "failed":
    case "reversed":
      return String(value).toLowerCase() === "reversed" ? "REVERSED" : "FAILED";
    case "pending":
    case "processing":
    case "queued":
    case "ongoing":
    case "otp":
      return "PENDING";
    default:
      return "UNKNOWN";
  }
}

function transferPayload(result: PaystackTransferResponse) {
  const data = result.data ?? {};
  const recipient = typeof data.recipient === "string" ? data.recipient : data.recipient?.recipient_code || "";
  return {
    transferCode: String(data.transfer_code || ""),
    reference: String(data.reference || ""),
    amount: Number(data.amount || 0),
    status: normalizeTransferStatus(data.status),
    rawStatus: String(data.status || ""),
    recipientCode: String(recipient || ""),
    reason: String(data.reason || result.message || ""),
  };
}

export async function createPaystackRecipient(input: {
  type: string;
  name: string;
  accountNumber: string;
  bankCode: string;
  currency: string;
  email?: string;
  description?: string;
}) {
  const { secretKey, baseUrl } = await getRuntimeConfig();
  const response = await fetch(`${baseUrl}/transferrecipient`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: input.type,
      name: input.name,
      account_number: input.accountNumber,
      bank_code: input.bankCode,
      currency: input.currency,
      ...(input.email ? { email: input.email } : {}),
      ...(input.description ? { description: input.description } : {}),
    }),
  });
  const result = await response.json().catch(() => ({})) as PaystackRecipientResponse;
  if (!response.ok || !result.status || !result.data?.recipient_code) {
    // The message is surfaced to an administrator, so it must say what Paystack
    // said. It never echoes the request body.
    throw new Error(result.message || `Paystack recipient creation failed (${response.status}).`);
  }
  return { recipientCode: String(result.data.recipient_code), type: String(result.data.type || input.type) };
}

export async function initiatePaystackTransfer(input: {
  amount: number;
  recipientCode: string;
  reference: string;
  reason: string;
  currency?: string;
}) {
  const { secretKey, baseUrl, currency } = await getRuntimeConfig();
  const response = await fetch(`${baseUrl}/transfer`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      source: "balance",
      amount: Math.max(0, Math.round(input.amount)),
      recipient: input.recipientCode,
      reference: input.reference,
      reason: input.reason.slice(0, 100),
      currency: input.currency || currency,
    }),
  });
  const result = await response.json().catch(() => ({})) as PaystackTransferResponse;
  if (!response.ok || !result.status || !result.data) {
    throw new Error(result.message || `Paystack transfer failed (${response.status}).`);
  }
  return transferPayload(result);
}

/** The reference is ours, so this is the lookup that cannot be mistyped. */
export async function verifyPaystackTransfer(reference: string) {
  const { secretKey, baseUrl } = await getRuntimeConfig();
  const response = await fetch(`${baseUrl}/transfer/verify/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${secretKey}` },
  });
  const result = await response.json().catch(() => ({})) as PaystackTransferResponse;
  if (!response.ok || !result.status || !result.data) {
    throw new Error(result.message || `Paystack transfer verify failed (${response.status}).`);
  }
  return transferPayload(result);
}

type PaystackBankResponse = {
  status?: boolean;
  message?: string;
  data?: Array<{ code?: string; name?: string; type?: string; currency?: string }>;
};

/**
 * The institutions a transfer can address, straight from Paystack. Fetching
 * rather than embedding is what keeps a newly added bank payable without a
 * deployment; `lib/paystack-banks.ts` holds the offline fallback.
 */
export async function listPaystackBanks(currency: string) {
  const { secretKey, baseUrl } = await getRuntimeConfig();
  const response = await fetch(`${baseUrl}/bank?currency=${encodeURIComponent(currency)}`, {
    headers: { Authorization: `Bearer ${secretKey}` },
  });
  const result = await response.json().catch(() => ({})) as PaystackBankResponse;
  if (!response.ok || !result.status || !Array.isArray(result.data)) {
    throw new Error(result.message || `Paystack bank list failed (${response.status}).`);
  }
  return result.data
    .map((row) => ({ code: String(row.code || "").trim(), name: String(row.name || "").trim(), type: String(row.type || "").trim() }))
    .filter((row) => row.code && row.name);
}

/**
 * What the platform can actually pay out right now. Paystack settles on its own
 * schedule, so this — not the sum of what has been collected — is the ceiling
 * for a transfer run.
 */
export async function fetchPaystackBalance(currency: string) {
  const { secretKey, baseUrl } = await getRuntimeConfig();
  const response = await fetch(`${baseUrl}/balance`, {
    headers: { Authorization: `Bearer ${secretKey}` },
  });
  const result = await response.json().catch(() => ({})) as {
    status?: boolean;
    message?: string;
    data?: Array<{ currency?: string; balance?: number }>;
  };
  if (!response.ok || !result.status || !Array.isArray(result.data)) {
    throw new Error(result.message || `Paystack balance failed (${response.status}).`);
  }
  const wanted = currency.toUpperCase();
  const match = result.data.find((row) => String(row.currency || "").toUpperCase() === wanted);
  return { currency: wanted, balance: Number(match?.balance || 0), available: result.data.map((row) => ({ currency: String(row.currency || ""), balance: Number(row.balance || 0) })) };
}
