import { aiBinding } from "@/lib/cloudflare-bindings";
import { envValue } from "@/lib/runtime-env";

// The 3.1 8B instruct model was retired on 2026-05-30; the console assistant
// already defaulted to this one, and structured answers (the Cinema whiteboard
// schema, the assistant's JSON) need the larger model anyway.
export const DEFAULT_CLOUDFLARE_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/**
 * The model a call will use, resolved the same way `callCloudflareAi` resolves
 * it. Callers that store which model answered (the Cinema whiteboard does) read
 * this rather than re-deriving it and recording a guess.
 */
export async function cloudflareAiModelName() {
  return await envValue("CLOUDFLARE_AI_MODEL") || DEFAULT_CLOUDFLARE_AI_MODEL;
}

export async function isCloudflareAiConfigured() {
  // The Worker binding is the preferred path: no token travels with the
  // request, and the model is billed to the account that owns the Worker.
  if (await aiBinding()) return true;
  const token = await envValue("CLOUDFLARE_AI_TOKEN");
  const accountId = await envValue("CLOUDFLARE_ACCOUNT_ID", ["CLOUDFLARE_ACCOUNT", "ACCOUNT_ID"]);
  return Boolean(token && accountId && !token.startsWith("replace-with") && !accountId.startsWith("replace-with"));
}

export async function cloudflareAiConfigStatus() {
  const bindingReady = Boolean(await aiBinding());
  const token = await envValue("CLOUDFLARE_AI_TOKEN");
  const accountId = await envValue("CLOUDFLARE_ACCOUNT_ID", ["CLOUDFLARE_ACCOUNT", "ACCOUNT_ID"]);
  const model = await envValue("CLOUDFLARE_AI_MODEL") || DEFAULT_CLOUDFLARE_AI_MODEL;
  return {
    bindingReady,
    mode: bindingReady ? "binding" as const : (token && accountId ? "rest" as const : "none" as const),
    hasAccountId: Boolean(accountId && !accountId.startsWith("replace-with")),
    hasAiToken: Boolean(token && !token.startsWith("replace-with")),
    model,
  };
}

/**
 * The text out of a Workers AI reply, in either shape the service returns.
 *
 * The older models answer `{ response }`; the newer ones answer the
 * OpenAI-compatible `{ choices: [{ message: { content } }] }`. Both are read
 * here because which one arrives depends on the model named in the setting,
 * and a model swap must not silently turn every answer into "empty response".
 */
export function normalizeCloudflareAiText(payload: unknown): string {
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
    if (Array.isArray(record.choices)) {
      const choiceText = normalizeCloudflareAiText(record.choices.map((choice) => {
        if (!choice || typeof choice !== "object") return "";
        const entry = choice as Record<string, unknown>;
        return entry.message ?? entry.text ?? entry.delta ?? "";
      }));
      if (choiceText) return choiceText;
    }
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
  const model = await cloudflareAiModelName();

  const binding = await aiBinding();
  if (binding) {
    const data = await binding.run(model, {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      // The platform default reply budget is small enough to cut a structured
      // scene in half; the whiteboard's JSON needs room to close its braces.
      max_tokens: 2_048,
      temperature: 0.2,
    });
    const boundText = normalizeCloudflareAiText(data);
    if (!boundText) throw new Error("Cloudflare AI returned an empty response.");
    return boundText.trim();
  }

  const accountId = await envValue("CLOUDFLARE_ACCOUNT_ID", ["CLOUDFLARE_ACCOUNT", "ACCOUNT_ID"]);
  const token = await envValue("CLOUDFLARE_AI_TOKEN");
  if (!accountId || !token) {
    throw new Error("Cloudflare AI is not configured. Bind Workers AI to the Worker, or set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AI_TOKEN.");
  }
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
      max_tokens: 2_048,
      temperature: 0.2,
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
