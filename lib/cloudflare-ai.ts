import { envValue } from "@/lib/runtime-env";

export const DEFAULT_CLOUDFLARE_AI_MODEL = "@cf/meta/llama-3.1-8b-instruct";

export async function isCloudflareAiConfigured() {
  const token = await envValue("CLOUDFLARE_AI_TOKEN");
  const accountId = await envValue("CLOUDFLARE_ACCOUNT_ID", ["CLOUDFLARE_ACCOUNT", "ACCOUNT_ID"]);
  return Boolean(token && accountId && !token.startsWith("replace-with") && !accountId.startsWith("replace-with"));
}

export async function cloudflareAiConfigStatus() {
  const token = await envValue("CLOUDFLARE_AI_TOKEN");
  const accountId = await envValue("CLOUDFLARE_ACCOUNT_ID", ["CLOUDFLARE_ACCOUNT", "ACCOUNT_ID"]);
  const model = await envValue("CLOUDFLARE_AI_MODEL") || DEFAULT_CLOUDFLARE_AI_MODEL;
  return {
    hasAccountId: Boolean(accountId && !accountId.startsWith("replace-with")),
    hasAiToken: Boolean(token && !token.startsWith("replace-with")),
    model,
  };
}

function normalizeCloudflareAiText(payload: unknown): string {
  if (typeof payload === "string") return payload.trim();
  if (Array.isArray(payload)) {
    const text = payload
      .map((item) => normalizeCloudflareAiText(item))
      .filter(Boolean)
      .join("\n");
    if (text) return text;
  }
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const candidates = [
      record.response,
      record.text,
      record.content,
      record.output,
      record.answer,
      record.message,
      record.reply,
    ];
    for (const candidate of candidates) {
      const normalized = normalizeCloudflareAiText(candidate);
      if (normalized) return normalized;
    }
    const nested = record.result ?? record.data;
    if (nested) return normalizeCloudflareAiText(nested);
  }
  return "";
}

export async function callCloudflareAi(systemPrompt: string, userPrompt: string) {
  if (!(await isCloudflareAiConfigured())) {
    throw new Error("Cloudflare AI is not configured. Add CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AI_TOKEN to the environment.");
  }

  const accountId = await envValue("CLOUDFLARE_ACCOUNT_ID", ["CLOUDFLARE_ACCOUNT", "ACCOUNT_ID"]);
  const token = await envValue("CLOUDFLARE_AI_TOKEN");
  if (!accountId || !token) {
    throw new Error("Cloudflare AI is not configured. Add CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AI_TOKEN to the environment.");
  }
  const model = await envValue("CLOUDFLARE_AI_MODEL") || DEFAULT_CLOUDFLARE_AI_MODEL;
  const modelPath = model.split("/").map((part) => encodeURIComponent(part)).join("/");

  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${modelPath}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || "Cloudflare AI request failed.");
  }

  const data = await response.json();
  const text = normalizeCloudflareAiText(data);
  if (!text) {
    throw new Error("Cloudflare AI returned an empty response.");
  }

  return text.trim();
}
