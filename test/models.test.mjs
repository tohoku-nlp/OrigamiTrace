import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { callModel, loadModels } from "../server/models.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = { OPENAI_API_KEY: "sk-test", AWS_BEARER_TOKEN_BEDROCK: "bedrock-test", AWS_REGION: "us-west-2" };
const messages = [
  { role: "user", content: [{ image: { format: "jpeg", bytes: "QUJD" } }, { text: "Fold in half." }] },
  { role: "assistant", content: [{ text: "OK" }] },
];

// Replaces fetch with one that records the request and returns `reply`.
function stubFetch(t, reply) {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(reply), { status: 200 });
  });
  return requests;
}

async function writeModels(models) {
  const file = path.join(await mkdtemp(path.join(tmpdir(), "origamitrace-")), "models.json");
  await writeFile(file, JSON.stringify({ models }));
  return file;
}

test("models.json: the paper's controllers and their readiness", async () => {
  const models = await loadModels(path.join(root, "models.json"), env);
  assert.deepEqual(models.map((model) => [model.id, model.ready]), [
    ["gpt-5.6-sol", true],
    ["google.gemma-4-31b", true],
    ["google.gemma-3-12b-it", true],
  ]);
  assert.equal(models[1].endpoint, "https://bedrock-mantle.us-west-2.api.aws/openai/v1/chat/completions");

  const withoutKeys = await loadModels(path.join(root, "models.json"), {});
  assert.deepEqual(withoutKeys.map((model) => model.missingEnv), [
    ["OPENAI_API_KEY"],
    ["AWS_BEARER_TOKEN_BEDROCK"],
    ["AWS_BEARER_TOKEN_BEDROCK"],
  ]);
  assert.equal(withoutKeys[1].endpoint, "https://bedrock-mantle.us-east-1.api.aws/openai/v1/chat/completions");
});

test("openai-chat: GPT 5.6 Sol request", async (t) => {
  const [model] = await loadModels(path.join(root, "models.json"), env);
  const requests = stubFetch(t, { choices: [{ message: { content: " done " }, finish_reason: "stop" }], usage: { total_tokens: 9 } });
  const result = await callModel(model, "system", messages, env);

  assert.equal(requests[0].url, "https://api.openai.com/v1/chat/completions");
  assert.equal(requests[0].headers.Authorization, "Bearer sk-test");
  assert.deepEqual(requests[0].body, {
    model: "gpt-5.6-sol",
    messages: [
      { role: "system", content: "system" },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,QUJD" } },
          { type: "text", text: "Fold in half." },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "OK" }] },
    ],
    max_completion_tokens: 32000,
    reasoning_effort: "low",
  });
  assert.equal(result.text, "done");
  assert.equal(result.stopReason, "stop");
  assert.equal(result.modelId, "gpt-5.6-sol");
});

test("bedrock-converse: Gemma 3 12B IT request", async (t) => {
  const model = (await loadModels(path.join(root, "models.json"), env))[2];
  const requests = stubFetch(t, { output: { message: { content: [{ text: "done" }] } }, stopReason: "end_turn" });
  await callModel(model, "system", messages, env);

  assert.equal(requests[0].url, "https://bedrock-runtime.us-west-2.amazonaws.com/model/google.gemma-3-12b-it/converse");
  assert.deepEqual(requests[0].body, {
    system: [{ text: "system" }],
    messages: [
      { role: "user", content: [{ image: { format: "jpeg", source: { bytes: "QUJD" } } }, { text: "Fold in half." }] },
      { role: "assistant", content: [{ text: "OK" }] },
    ],
    inferenceConfig: { maxTokens: 2048, temperature: 0 },
  });
});

test("a local OpenAI-compatible server needs no API key", async (t) => {
  const file = await writeModels([
    { id: "Qwen/Qwen3-VL-8B-Instruct", api: "openai-chat", endpoint: "http://localhost:${VLLM_PORT:-8000}/v1/chat/completions" },
  ]);
  const [model] = await loadModels(file, {});
  assert.equal(model.ready, true);
  const requests = stubFetch(t, { choices: [{ message: { content: "done" } }] });
  await callModel(model, "system", messages, {});
  assert.equal(requests[0].url, "http://localhost:8000/v1/chat/completions");
  assert.equal(requests[0].headers.Authorization, undefined);
  assert.equal(requests[0].body.model, "Qwen/Qwen3-VL-8B-Instruct");
});

test("models.json errors are reported", async () => {
  await assert.rejects(loadModels(await writeModels([{ id: "a", api: "unknown", endpoint: "x" }]), {}), /unknown api/);
  await assert.rejects(loadModels(await writeModels([{ id: "a", api: "openai-chat" }]), {}), /needs "endpoint"/);
  await assert.rejects(
    loadModels(await writeModels([
      { id: "a", api: "openai-chat", endpoint: "x" },
      { id: "a", api: "openai-chat", endpoint: "x" },
    ]), {}),
    /duplicate id/,
  );
});
