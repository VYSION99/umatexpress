const DEFAULT_BASE_URL = "https://api.paystack.co";

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

export function getPaymentProvider() {
  return (process.env.PAYMENT_PROVIDER || "MTN_MOMO").toUpperCase() === "PAYSTACK" ? "PAYSTACK" : "MTN_MOMO";
}

export function getPaystackCurrency() {
  return getConfig().currency;
}

export async function initializePaystackTransaction(input: {
  email: string;
  amount: number;
  reference: string;
  callbackUrl: string;
  metadata: Record<string, string | number>;
}) {
  const { secretKey, baseUrl, currency } = getConfig();
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
  const { secretKey, baseUrl } = getConfig();
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
