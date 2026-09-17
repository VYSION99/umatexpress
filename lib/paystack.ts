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
  return (process.env.PAYMENT_PROVIDER || "MTN_MOMO").toUpperCase() === "PAYSTACK" ? "PAYSTACK" : "MTN_MOMO";
}

export async function getPaymentProviderRuntime() {
  return (await envValue("PAYMENT_PROVIDER") || "MTN_MOMO").toUpperCase() === "PAYSTACK" ? "PAYSTACK" : "MTN_MOMO";
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
