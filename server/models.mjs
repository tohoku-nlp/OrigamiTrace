// LLM controllers.
//
// Controllers are defined in models.json (see the README for the fields). Each
// definition names one of the APIs below; the rest of the server only sees
// messages in one provider-neutral format:
//
//   { role: "user" | "assistant", content: [{ text }, { image: { format: "jpeg", bytes: <base64> } }] }
//
// and a result { text, stopReason, usage, modelId, latencyMs }.

import { readFile } from "node:fs/promises";

const APIS = {
  // OpenAI Chat Completions API and compatible servers.
  "openai-chat": {
    headers: (apiKey) => (apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    body: (model, systemPrompt, messages) => ({
      model: model.id,
      messages: [
        { role: "system", content: systemPrompt },
        ...messages.map((message) => ({
          role: message.role,
          content: message.content.map((block) =>
            block.image
              ? { type: "image_url", image_url: { url: `data:image/${block.image.format};base64,${block.image.bytes}` } }
              : { type: "text", text: block.text },
          ),
        })),
      ],
    }),
    parse: (response) => {
      const choice = response.choices?.[0];
      const content = choice?.message?.content;
      const text = typeof content === "string" ? content.trim() : joinText(content);
      return { text, stopReason: choice?.finish_reason, usage: response.usage };
    },
  },

  // Amazon Bedrock Converse API.
  "bedrock-converse": {
    headers: (apiKey) => ({ Authorization: `Bearer ${apiKey}` }),
    body: (_model, systemPrompt, messages) => ({
      system: [{ text: systemPrompt }],
      messages: messages.map((message) => ({
        role: message.role,
        content: message.content.map((block) =>
          block.image
            ? { image: { format: block.image.format, source: { bytes: block.image.bytes } } }
            : { text: block.text },
        ),
      })),
    }),
    parse: (response) => ({
      text: joinText(response.output?.message?.content),
      stopReason: response.stopReason,
      usage: response.usage,
    }),
  },
};

const DEFAULT_TIMEOUT_SECONDS = 300;

// Reads the controller definitions and resolves them against the environment.
// A controller is `ready` when the environment variables it uses are set;
// `missingEnv` lists the ones that are not.
export async function loadModels(filePath, env) {
  const { models } = JSON.parse(await readFile(filePath, "utf8"));
  const seen = new Set();
  return models.map((definition, index) => {
    const where = `${filePath}: models[${index}]`;
    for (const field of ["id", "api", "endpoint"]) {
      if (typeof definition[field] !== "string" || !definition[field]) {
        throw new Error(`${where} needs "${field}".`);
      }
    }
    if (!APIS[definition.api]) {
      throw new Error(`${where}: unknown api "${definition.api}" (expected ${Object.keys(APIS).join(", ")}).`);
    }
    if (seen.has(definition.id)) throw new Error(`${where}: duplicate id "${definition.id}".`);
    seen.add(definition.id);
    const missingEnv = new Set();
    const endpoint = expandEnv(definition.endpoint, env, missingEnv);
    if (definition.apiKeyEnv && !env[definition.apiKeyEnv]) missingEnv.add(definition.apiKeyEnv);
    return {
      id: definition.id,
      label: definition.label || definition.id,
      api: definition.api,
      endpoint,
      apiKeyEnv: definition.apiKeyEnv || null,
      parameters: definition.parameters || {},
      timeoutSeconds: definition.timeoutSeconds || DEFAULT_TIMEOUT_SECONDS,
      missingEnv: [...missingEnv],
      ready: missingEnv.size === 0,
    };
  });
}

// Sends one request. `parameters` from models.json are added to the request
// body as they are, so any decoding setting of the API can be used.
export async function callModel(model, systemPrompt, messages, env) {
  const api = APIS[model.api];
  if (!model.ready) throw new Error(`${model.missingEnv.join(", ")} not set (see .env.example).`);
  const apiKey = model.apiKeyEnv ? env[model.apiKeyEnv] : null;

  const startedAt = Date.now();
  const response = await postJson(
    model.endpoint,
    api.headers(apiKey),
    { ...api.body(model, systemPrompt, messages), ...model.parameters },
    model.timeoutSeconds * 1000,
  );
  const result = api.parse(response);
  if (!result.text) throw new Error(`${model.label} returned no text output.`);
  return { ...result, modelId: model.id, latencyMs: Date.now() - startedAt };
}

async function postJson(endpoint, headers, body, timeoutMs) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: abort.signal,
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = json.error?.message || json.message || json.Message || "";
      throw new Error(`API request failed (${response.status}) ${message}`.trim());
    }
    return json;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`The API did not respond within ${Math.round(timeoutMs / 1000)} s.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function joinText(blocks) {
  return (blocks || []).map((block) => block.text || "").join("").trim();
}

// "${NAME}" and "${NAME:-default}" in endpoints are replaced with environment
// values; unset names without a default are added to `missing`.
function expandEnv(value, env, missing) {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name, fallback) => {
    if (env[name]) return env[name];
    if (fallback !== undefined) return fallback;
    missing.add(name);
    return "";
  });
}
