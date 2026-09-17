import { envValue } from "@/lib/runtime-env";

const DEFAULT_BASE_URL = "https://sandbox.momodeveloper.mtn.com";

type TokenCache = { token: string; expiresAt: number };
let tokenCache: TokenCache | null = null;

function getConfig() {
  const apiUser = process.env.MTN_MOMO_API_USER;
  const apiKey = process.env.MTN_MOMO_API_KEY;
  const collectionKey = process.env.MTN_MOMO_COLLECTION_KEY;
  const baseUrl = (process.env.MTN_MOMO_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");
  const targetEnvironment = process.env.MTN_MOMO_TARGET_ENVIRONMENT || "sandbox";
  const currency = targetEnvironment === "sandbox" ? "EUR" : (process.env.MTN_MOMO_CURRENCY || "GHS");

  if (!apiUser || !apiKey || !collectionKey) {
    throw new Error("MTN MoMo is not configured yet.");
  }

  return { apiUser, apiKey, collectionKey, baseUrl, targetEnvironment, currency };
}

async function getRuntimeConfig() {
  const apiUser = await envValue("MTN_MOMO_API_USER");
  const apiKey = await envValue("MTN_MOMO_API_KEY");
  const collectionKey = await envValue("MTN_MOMO_COLLECTION_KEY");
  const baseUrl = (await envValue("MTN_MOMO_BASE_URL") || DEFAULT_BASE_URL).replace(/\/$/, "");
  const targetEnvironment = await envValue("MTN_MOMO_TARGET_ENVIRONMENT") || "sandbox";
  const configuredCurrency = await envValue("MTN_MOMO_CURRENCY") || "GHS";
  const currency = targetEnvironment === "sandbox" ? "EUR" : configuredCurrency;

  if (!apiUser || !apiKey || !collectionKey) {
    throw new Error("MTN MoMo is not configured yet.");
  }

  return { apiUser, apiKey, collectionKey, baseUrl, targetEnvironment, currency };
}

export function getMomoCurrency() {
  return getConfig().currency;
}

export async function getMomoCurrencyRuntime() {
  return (await getRuntimeConfig()).currency;
}

export function normalizeGhanaPhone(input: string) {
  const digits = input.replace(/\D/g, "");
  if (/^0\d{9}$/.test(digits)) return `233${digits.slice(1)}`;
  if (/^233\d{9}$/.test(digits)) return digits;
  throw new Error("Enter a valid Ghanaian mobile number, for example 0241234567.");
}

export async function getAccessToken() {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;

  const { apiUser, apiKey, collectionKey, baseUrl } = await getRuntimeConfig();
  const basic = btoa(`${apiUser}:${apiKey}`);
  const response = await fetch(`${baseUrl}/collection/token/`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Ocp-Apim-Subscription-Key": collectionKey,
      "Content-Type": "application/json",
    },
    body: "",
  });

  const result = await response.json().catch(() => ({})) as { access_token?: string; expires_in?: number; error?: string; message?: string };
  if (!response.ok || !result.access_token) {
    throw new Error(result.error || result.message || `MTN token request failed (${response.status}).`);
  }

  const expiresIn = Number(result.expires_in || 3600);
  tokenCache = { token: result.access_token, expiresAt: Date.now() + expiresIn * 1000 };
  return result.access_token;
}

export async function requestToPay(input: {
  referenceId: string;
  externalId: string;
  amount: string;
  phone: string;
  payerMessage: string;
  payeeNote: string;
}) {
  const { collectionKey, baseUrl, targetEnvironment, currency } = await getRuntimeConfig();
  const accessToken = await getAccessToken();

  const response = await fetch(`${baseUrl}/collection/v1_0/requesttopay`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Ocp-Apim-Subscription-Key": collectionKey,
      "X-Target-Environment": targetEnvironment,
      "X-Reference-Id": input.referenceId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      amount: input.amount,
      currency,
      externalId: input.externalId,
      payer: { partyIdType: "MSISDN", partyId: input.phone },
      payerMessage: input.payerMessage,
      payeeNote: input.payeeNote,
    }),
  });

  if (response.status !== 202) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`MTN RequestToPay failed (${response.status})${errorText ? `: ${errorText}` : ""}`);
  }

  return { status: "PENDING" as const, currency };
}

export async function getPaymentStatus(referenceId: string) {
  const { collectionKey, baseUrl, targetEnvironment } = await getRuntimeConfig();
  const accessToken = await getAccessToken();

  const response = await fetch(`${baseUrl}/collection/v1_0/requesttopay/${encodeURIComponent(referenceId)}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Ocp-Apim-Subscription-Key": collectionKey,
      "X-Target-Environment": targetEnvironment,
    },
  });

  const result = await response.json().catch(() => ({})) as {
    financialTransactionId?: string;
    externalId?: string;
    amount?: string;
    currency?: string;
    status?: "PENDING" | "SUCCESSFUL" | "FAILED";
    reason?: string;
  };

  if (!response.ok) throw new Error(`MTN payment status request failed (${response.status}).`);
  return result;
}
