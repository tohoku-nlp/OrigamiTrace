#!/usr/bin/env node
// HTTP server for the OrigamiTrace simulator-based evaluation.
//
//   node server/server.mjs [--data <dir>] [--logs <dir>] [--models <file>] [--port <n>] [--host <addr>]

import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { loadEpisodes, loadWorks } from "./dataset.mjs";
import { EpisodeStore, httpError, MAX_FAILED_ATTEMPTS } from "./episodes.mjs";
import { callModel, loadModels } from "./models.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { values: args } = parseArgs({
  options: {
    data: { type: "string", default: path.join(repoRoot, "examples", "data") },
    logs: { type: "string", default: path.join(repoRoot, "logs") },
    models: { type: "string", default: path.join(repoRoot, "models.json") },
    port: { type: "string", default: process.env.PORT || "4174" },
    host: { type: "string", default: "127.0.0.1" },
  },
});

const env = { ...(await readDotEnv(path.join(repoRoot, ".env"))), ...process.env };
const dataDirectory = path.resolve(args.data);
const prompts = await loadPrompts();
const specification = JSON.parse(
  await readFile(path.join(repoRoot, "knowledge", "command_specification.json"), "utf8"),
);
const episodes = await loadEpisodes(path.join(repoRoot, "episodes.csv"));
const works = await loadWorks(dataDirectory);
const models = await loadModels(path.resolve(args.models), env);
const modelById = new Map(models.map((model) => [model.id, model]));
const store = new EpisodeStore({
  dataDirectory,
  logDirectory: path.resolve(args.logs),
  works,
  episodes,
  prompts,
  specification,
  modelCaller: (modelId, systemPrompt, messages) => {
    const model = modelById.get(modelId);
    if (!model) throw new Error(`Model "${modelId}" is not defined in ${args.models}.`);
    return callModel(model, systemPrompt, messages, env);
  },
});
await store.loadLogs();

const episodeById = new Map(episodes.map((episode) => [episode.id, episode]));
const workList = [...works.values()]
  .filter((work) => episodeById.has(work.id))
  .map((work) => ({
    id: work.id,
    folder: work.folder,
    designName: episodeById.get(work.id).designName,
    startImage: episodeById.get(work.id).startImage,
    targetImage: episodeById.get(work.id).targetImage,
    hasDisplayImages: work.frames.size > 0,
  }));

const routes = [
  ["GET", /^\/api\/config$/, () => ({
    models: models.map(({ id, label, ready, missingEnv }) => ({ id, label, ready, missingEnv })),
    works: workList,
    maxFailedAttempts: MAX_FAILED_ATTEMPTS,
    retryIncorrect: prompts.retryIncorrect,
  })],
  ["GET", /^\/api\/episodes$/, () => store.list()],
  ["POST", /^\/api\/episodes$/, async (_, body) => {
    const model = modelById.get(body.modelId);
    if (!model) throw httpError(400, "Unknown model.");
    if (!model.ready) throw httpError(400, `${model.label}: set ${model.missingEnv.join(", ")} in .env.`);
    return view(await store.create(body));
  }],
  ["GET", /^\/api\/episodes\/([\w-]+)$/, ([id]) => view(store.get(id))],
  ["POST", /^\/api\/episodes\/([\w-]+)\/initialize$/, async ([id]) => view(await store.initialize(id))],
  ["POST", /^\/api\/episodes\/([\w-]+)\/request$/, async ([id], body) => view(await store.requestCommand(id, body))],
  ["POST", /^\/api\/episodes\/([\w-]+)\/judge$/, async ([id], body) => view(await store.judge(id, body))],
  ["POST", /^\/api\/episodes\/([\w-]+)\/undo$/, async ([id]) => view(await store.undo(id))],
  ["POST", /^\/api\/episodes\/([\w-]+)\/time$/, async ([id], body) => {
    const episode = await store.addWorkingTime(id, body);
    return { elapsedMs: episode.transitions[body.transitionIndex].elapsedMs };
  }],
  ["POST", /^\/api\/episodes\/([\w-]+)\/rewind$/, async ([id]) => {
    const { episode, draft } = await store.rewind(id);
    return { ...view(episode), draft };
  }],
];

// The episode state plus what the UI needs to show it.
function view(episode) {
  const work = works.get(episode.workId);
  const images = {};
  for (let n = episode.startImage; n <= episode.targetImage; n += 1) {
    const name = work.images[n - 1];
    const frame = work.frames.get(name);
    images[n] = {
      name,
      original: `/data/images/${encodeURIComponent(work.folder)}/${encodeURIComponent(name)}`,
      display: frame ? `/data/display/${encodeURIComponent(work.folder)}/${encodeURIComponent(name)}` : null,
      frame: frame || null,
    };
  }
  return {
    episode,
    imageCount: work.images.length,
    designName: episodeById.get(episode.workId)?.designName || episode.work,
    captions: Object.fromEntries(episode.transitions.map((t) => [t.from, work.captions[t.from - 1]])),
    images,
    // The state number of the transition whose judgment can be undone, or null.
    undoState: undoState(store.undoSnapshots.get(episode.id)),
  };
}

function undoState(snapshot) {
  return snapshot ? snapshot.transitions[snapshot.currentIndex].from : null;
}

const webRoot = path.join(repoRoot, "web");
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  try {
    if (url.pathname.startsWith("/api/")) {
      for (const [method, pattern, handler] of routes) {
        const match = url.pathname.match(pattern);
        if (!match || request.method !== method) continue;
        const body = method === "POST" ? await readJsonBody(request) : null;
        return sendJson(response, 200, await handler(match.slice(1), body || {}));
      }
      throw httpError(404, "Not found.");
    }
    if (url.pathname.startsWith("/data/")) {
      const [, , kind, ...rest] = url.pathname.split("/");
      if (!["images", "display"].includes(kind)) throw httpError(404, "Not found.");
      return await sendFile(response, safeJoin(path.join(dataDirectory, kind), rest.map(decodeURIComponent)));
    }
    const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    return await sendFile(response, safeJoin(webRoot, [file]));
  } catch (error) {
    const status = error.status || 500;
    if (status === 500) console.error(error);
    sendJson(response, status, { error: error.message || "Internal error" });
  }
});

server.listen(Number(args.port), args.host, () => {
  const ready = models.filter((model) => model.ready).map((model) => model.label);
  console.log(`Data:   ${dataDirectory} (${workList.length} works with an episode)`);
  console.log(`Logs:   ${path.resolve(args.logs)}`);
  console.log(`Models: ${ready.join(", ") || "none ready (set the API keys in .env; see .env.example)"}`);
  console.log(`Open http://${args.host === "0.0.0.0" ? "localhost" : args.host}:${args.port}/`);
});

// ---- Prompts ----------------------------------------------------------------

async function loadPrompts() {
  const read = async (relativePath) =>
    (await readFile(path.join(repoRoot, relativePath), "utf8")).trim();
  // System prompt = instructions/task_N.md followed by the three knowledge
  // files, each serialized as compact JSON under its own heading.
  const knowledge = [];
  for (const [heading, file] of [
    ["Command specification", "command_specification.json"],
    ["Basic examples", "basic_examples.json"],
    ["Additional useful examples", "additional_useful_examples.json"],
  ]) {
    knowledge.push(`# ${heading}\n${JSON.stringify(JSON.parse(await read(`knowledge/${file}`)))}`);
  }
  return {
    task1System: [await read("instructions/task_1.md"), ...knowledge].join("\n\n"),
    task2System: [await read("instructions/task_2.md"), ...knowledge].join("\n\n"),
    task1Initial: await read("messages/task_1_initial.txt"),
    retryIncorrect: await read("messages/task_1_retry_incorrect.txt"),
    retryInvalid: await read("messages/task_1_retry_invalid.txt"),
  };
}

// ---- HTTP helpers -----------------------------------------------------------

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

function safeJoin(root, segments) {
  const resolved = path.resolve(root, ...segments);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw httpError(403, "Forbidden.");
  return resolved;
}

async function sendFile(response, filePath) {
  let info;
  try {
    info = await stat(filePath);
  } catch {
    throw httpError(404, "Not found.");
  }
  if (!info.isFile()) throw httpError(404, "Not found.");
  response.writeHead(200, {
    "Content-Type": CONTENT_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream",
    "Content-Length": info.size,
    "Cache-Control": "no-cache",
  });
  createReadStream(filePath).pipe(response);
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(body);
}

async function readJsonBody(request, maxBytes = 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw httpError(413, "Request body too large.");
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw httpError(400, "Invalid JSON.");
  }
}

async function readDotEnv(filePath) {
  const values = {};
  let text;
  try {
    text = await readFile(filePath, "utf8");
  } catch {
    return values;
  }
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || line.trim().startsWith("#")) continue;
    values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return values;
}
