import { providerOperation, ProviderRejected } from "@/lib/payments/operations";
import { registerPaymentAttempt } from "@/lib/payments/intents";
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
    /** What Paystack actually charged for the transaction, in pesewas. */
    fees?: number;
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

export function getPaymentProvider() { return "PAYSTACK" as const; }
export async function getPaymentProviderRuntime() { return "PAYSTACK" as const; }

export function getPaystackCurrency() {
  return getConfig().currency;
}

export async function getPaystackCurrencyRuntime() {
  return (await getRuntimeConfig()).currency;
}

export function getPaystackFeePercent() {
  const value = Number(process.env.PAYSTACK_FEE_PERCENT || DEFAULT_PAYSTACK_FEE_PERCENT);
  return validateFeePercent(value);
}

export async function getPaystackFeePercentRuntime() {
  const value = Number(await envValue("PAYSTACK_FEE_PERCENT") || DEFAULT_PAYSTACK_FEE_PERCENT);
  return validateFeePercent(value);
}

function validateFeePercent(value: number) {
  if (!Number.isFinite(value) || value < 0 || value >= 100) throw new Error("Paystack processing fee must be between 0 and less than 100 percent.");
  return value;
}

export function calculatePaystackCharge(baseAmount: number, feePercent = getPaystackFeePercent()) {
  if (!Number.isSafeInteger(baseAmount) || baseAmount < 0) throw new Error("Payment amount must be a non-negative integer in minor units.");
  const safeBaseAmount = baseAmount;
  const safeFeePercent = validateFeePercent(feePercent);
  const rate = safeFeePercent / 100;
  if (!safeBaseAmount || !rate) return { baseAmount: safeBaseAmount, feeAmount: 0, totalAmount: safeBaseAmount, feePercent: safeFeePercent };
  const totalAmount = Math.ceil(safeBaseAmount / (1 - rate));
  if (!Number.isSafeInteger(totalAmount)) throw new Error("Payment total exceeds the supported amount.");
  return { baseAmount: safeBaseAmount, feeAmount: totalAmount - safeBaseAmount, totalAmount, feePercent: safeFeePercent };
}

async function initializePaystackTransactionRaw(input: {
  email: string;
  amount: number;
  reference: string;
  callbackUrl: string;
  metadata: Record<string, string | number>;
}) {
  const { secretKey, baseUrl, currency } = await getRuntimeConfig();
  const response = await fetch(`${baseUrl}/transaction/initialize`, {
    signal: AbortSignal.timeout(20_000),
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
    if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) throw new ProviderRejected(result.message || "Provider rejected the request.");
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
    signal: AbortSignal.timeout(20_000),
    headers: { Authorization: `Bearer ${secretKey}` },
  });
  const result = await response.json().catch(() => ({})) as PaystackVerifyResponse;
  if (!response.ok || !result.status || !result.data) {
    throw new Error(result.message || `Paystack verify failed (${response.status}).`);
  }
  return {
    status: result.data.status === "success" ? "SUCCESSFUL"
      : result.data.status === "failed" || result.data.status === "abandoned" ? "FAILED"
      : result.data.status === "reversed" ? "REVERSED"
      : "PENDING",
    financialTransactionId: result.data.id ? String(result.data.id) : "",
    amount: Number(result.data.amount || 0),
    currency: String(result.data.currency || "MISSING").toUpperCase(),
    // The configured percentage is an estimate; this is what the rail took. The
    // two are stored separately so a drift between them is visible rather than
    // silently paid for by the platform.
    fees: Number(result.data.fees || 0),
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
  const rawStatus = String(data.status || "");
  return {
    transferCode: String(data.transfer_code || ""),
    reference: String(data.reference || ""),
    amount: Number(data.amount || 0),
    status: normalizeTransferStatus(rawStatus),
    rawStatus,
    // Paystack asked the account holder to authorise this one. It is not
    // pending on the network, it is pending on a human: nothing moves until
    // `/transfer/finalize_transfer` is called with the OTP.
    awaitingOtp: rawStatus.toLowerCase() === "otp",
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
    signal: AbortSignal.timeout(20_000),
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

async function initiatePaystackTransferRaw(input: {
  amount: number;
  recipientCode: string;
  reference: string;
  reason: string;
  currency?: string;
}) {
  const { secretKey, baseUrl, currency } = await getRuntimeConfig();
  const response = await fetch(`${baseUrl}/transfer`, {
    signal: AbortSignal.timeout(20_000),
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
    if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) throw new ProviderRejected(result.message || "Provider rejected the request.");
    throw new Error(result.message || `Paystack transfer failed (${response.status}).`);
  }
  return transferPayload(result);
}

/**
 * Completes a transfer Paystack held for a one-time password.
 *
 * `/transfer` answers `otp` when the account has that check switched on, and
 * the transfer then sits until this is called. The OTP is delivered to the
 * account holder by Paystack, never to us, so it only ever arrives as input
 * from the administrator who received it. It is not stored.
 */
export async function finalizePaystackTransfer(input: { transferCode: string; otp: string }) {
  const transferCode = String(input.transferCode || "").trim();
  const otp = String(input.otp || "").trim();
  if (!transferCode) throw new Error("A transfer code is required to authorise a transfer.");
  if (!otp) throw new Error("The one-time password from Paystack is required.");
  const { secretKey, baseUrl } = await getRuntimeConfig();
  const response = await fetch(`${baseUrl}/transfer/finalize_transfer`, {
    signal: AbortSignal.timeout(20_000),
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ transfer_code: transferCode, otp }),
  });
  const result = await response.json().catch(() => ({})) as PaystackTransferResponse;
  if (!response.ok || !result.status || !result.data) {
    // The OTP is the one thing that must never reach a log or an audit trail.
    throw new Error(result.message || `Paystack transfer finalization failed (${response.status}).`);
  }
  return transferPayload(result);
}

/** The reference is ours, so this is the lookup that cannot be mistyped. */
export async function verifyPaystackTransfer(reference: string) {
  const { secretKey, baseUrl } = await getRuntimeConfig();
  const response = await fetch(`${baseUrl}/transfer/verify/${encodeURIComponent(reference)}`, {
    signal: AbortSignal.timeout(20_000),
    headers: { Authorization: `Bearer ${secretKey}` },
  });
  const result = await response.json().catch(() => ({})) as PaystackTransferResponse;
  if (!response.ok || !result.status || !result.data) {
    throw new Error(result.message || `Paystack transfer verify failed (${response.status}).`);
  }
  return transferPayload(result);
}

type PaystackRefundResponse = {
  status?: boolean;
  message?: string;
  data?: {
    id?: number;
    reference?: string;
    transaction?: string | { reference?: string };
    amount?: number;
    status?: string;
    currency?: string;
    merchant_note?: string;
    customer_note?: string;
  };
};

export type PaystackRefundStatus = "PENDING" | "PROCESSED" | "FAILED" | "UNKNOWN";

/** Paystack's refund lifecycle, folded into the three states our ledger keeps. */
export function normalizeRefundStatus(value: unknown): PaystackRefundStatus {
  switch (String(value || "").toLowerCase()) {
    case "processed":
    case "success":
    case "successful":
    case "completed":
      return "PROCESSED";
    case "failed":
    case "reversed":
    case "declined":
      return "FAILED";
    case "pending":
    case "processing":
    case "queued":
    case "ongoing":
      return "PENDING";
    default:
      return "UNKNOWN";
  }
}

function refundPayload(result: PaystackRefundResponse) {
  const data = result.data ?? {};
  const transaction = typeof data.transaction === "string" ? data.transaction : data.transaction?.reference || "";
  return {
    refundReference: String(data.reference || ""),
    transactionReference: String(transaction || ""),
    amount: Number(data.amount || 0),
    status: normalizeRefundStatus(data.status),
    rawStatus: String(data.status || ""),
    currency: String(data.currency || ""),
    reason: String(data.merchant_note || data.customer_note || result.message || ""),
  };
}

/**
 * Sends part or all of a charge back to the student. The transaction is the one
 * that paid the booking; Paystack accepts the refund and processes it
 * asynchronously, so the ledger waits for `refund.processed` (or the reconcile
 * action) before it calls the money returned.
 */
async function initiatePaystackRefundRaw(input: {
  transactionReference: string;
  amount: number;
  currency?: string;
  reason?: string;
}) {
  const { secretKey, baseUrl, currency } = await getRuntimeConfig();
  const response = await fetch(`${baseUrl}/refund`, {
    signal: AbortSignal.timeout(20_000),
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      transaction: input.transactionReference,
      amount: Math.max(0, Math.round(input.amount)),
      currency: input.currency || currency,
      ...(input.reason ? { merchant_note: String(input.reason).slice(0, 200) } : {}),
    }),
  });
  const result = await response.json().catch(() => ({})) as PaystackRefundResponse;
  if (!response.ok || !result.status || !result.data) {
    if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) throw new ProviderRejected(result.message || "Provider rejected the request.");
    throw new Error(result.message || `Paystack refund failed (${response.status}).`);
  }
  return refundPayload(result);
}

export async function verifyPaystackRefund(reference: string) {
  const { secretKey, baseUrl } = await getRuntimeConfig();
  const response = await fetch(`${baseUrl}/refund/${encodeURIComponent(reference)}`, {
    signal: AbortSignal.timeout(20_000),
    headers: { Authorization: `Bearer ${secretKey}` },
  });
  const result = await response.json().catch(() => ({})) as PaystackRefundResponse;
  if (!response.ok || !result.status || !result.data) {
    throw new Error(result.message || `Paystack refund verify failed (${response.status}).`);
  }
  return refundPayload(result);
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
    signal: AbortSignal.timeout(20_000),
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
    signal: AbortSignal.timeout(20_000),
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

export async function initializePaystackTransaction(input: Parameters<typeof initializePaystackTransactionRaw>[0]) {
  const config = await getRuntimeConfig();
  await registerPaymentAttempt(input, config.currency);
  return providerOperation("INITIALIZE", input.reference, input, () => initializePaystackTransactionRaw(input));
}
export async function initiatePaystackTransfer(input: Parameters<typeof initiatePaystackTransferRaw>[0]) {
  await getRuntimeConfig();
  return providerOperation("TRANSFER", input.reference, input, () => initiatePaystackTransferRaw(input));
}
export async function initiatePaystackRefund(input: Parameters<typeof initiatePaystackRefundRaw>[0] & { operationId?: string }) {
  await getRuntimeConfig();
  const { operationId, ...payload } = input;
  const marker = operationId ? `[UMX:${operationId}]` : '';
  const tagged = { ...payload, reason: `${marker} ${payload.reason || ''}`.trim() };
  return providerOperation("REFUND", operationId || input.transactionReference, tagged, () => initiatePaystackRefundRaw(tagged));
}

/** Read-only provider reconciliation; pagination is explicit and bounded. */
export async function readPaystackPage(path: 'refund' | 'settlement' | `settlement/${string}/transactions`, query: Record<string,string> = {}) {
  const {secretKey,baseUrl}=await getRuntimeConfig();
  const response=await fetch(`${baseUrl}/${path}?${new URLSearchParams(query)}`,{headers:{Authorization:`Bearer ${secretKey}`},signal:AbortSignal.timeout(20_000)});
  const result=await response.json() as {status?:boolean;data?:Array<Record<string,unknown>>;meta?:{page?:number;pageCount?:number;total?:number}};
  if(!response.ok || !result.status || !Array.isArray(result.data)) throw new Error('Provider reconciliation unavailable.');
  return {rows:result.data,meta:result.meta};
}
