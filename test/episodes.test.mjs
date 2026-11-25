import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadEpisodes, loadWorks } from "../server/dataset.mjs";
import { EpisodeStore, MAX_FAILED_ATTEMPTS } from "../server/episodes.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = async (file) => (await readFile(path.join(root, file), "utf8")).trim();
const FOLD = '```json\n{"command_name":"fold","parameters":{"fold_infos":[{"crease_line_edge1":[0,-1],"crease_line_edge2":[0,1],"source_point":[1,0],"target_point":[-1,0],"source_layers":["all"],"theta":180,"fold_type":"valley"}]}}\n```';

// A store whose controller replies with the queued responses and records each request.
async function makeStore() {
  const dataDirectory = path.join(root, "examples", "data");
  const replies = [];
  const requests = [];
  const store = new EpisodeStore({
    dataDirectory,
    logDirectory: await mkdtemp(path.join(tmpdir(), "origamitrace-")),
    works: await loadWorks(dataDirectory),
    episodes: await loadEpisodes(path.join(root, "episodes.csv")),
    prompts: {
      task1System: "system 1",
      task2System: "system 2",
      task1Initial: await read("messages/task_1_initial.txt"),
      retryIncorrect: await read("messages/task_1_retry_incorrect.txt"),
      retryInvalid: await read("messages/task_1_retry_invalid.txt"),
    },
    specification: JSON.parse(await read("knowledge/command_specification.json")),
    modelCaller: async (modelId, systemPrompt, messages) => {
      requests.push({ systemPrompt, messages });
      return { text: replies.shift(), modelId };
    },
  });
  const reply = (text) => replies.push(text);
  const lastRequest = () => shape(requests.at(-1).messages);
  return { store, reply, lastRequest };
}

const shape = (messages) =>
  messages.map((message) => ({
    role: message.role,
    content: message.content.map((block) => (block.image ? "<image>" : block.text)),
  }));

test("Task 1: initial message, fixed feedback, and progression", async () => {
  const { store, reply, lastRequest } = await makeStore();
  let episode = await store.create({ task: "task1", modelId: "gpt-5.6-sol", workId: "044" }); // states 6 -> 8
  assert.equal(episode.transitions.length, 2);

  reply("OK");
  episode = await store.initialize(episode.id);
  const [initial] = lastRequest();
  assert.equal(initial.content[0], await read("messages/task_1_initial.txt"));
  assert.match(initial.content[1], /^\[File: reference-instructions\.csv\]\nstep,instruction\r\n6,"/);
  assert.deepEqual(initial.content.slice(2), ["<image>", "<image>", "<image>"]); // states 6, 7, 8

  reply("not a command");
  episode = await store.requestCommand(episode.id);
  assert.equal(episode.transitions[0].pending.format.valid, false);
  await assert.rejects(store.judge(episode.id, { judgment: "incorrect" }));
  episode = await store.judge(episode.id, { judgment: "invalid" });
  reply(FOLD);
  episode = await store.requestCommand(episode.id);
  episode = await store.judge(episode.id, { judgment: "incorrect" });
  reply(FOLD);
  episode = await store.requestCommand(episode.id);

  const caption = episode.transitions[0].instruction;
  assert.deepEqual(lastRequest().slice(1), [
    { role: "assistant", content: ["OK"] },
    { role: "user", content: ["<image>", caption] },
    { role: "assistant", content: ["not a command"] },
    { role: "user", content: [await read("messages/task_1_retry_invalid.txt")] },
    { role: "assistant", content: [FOLD] },
    { role: "user", content: [await read("messages/task_1_retry_incorrect.txt")] },
  ]);

  episode = await store.judge(episode.id, { judgment: "correct" });
  assert.equal(episode.currentIndex, 1);
  assert.equal(episode.transitions[0].status, "success");
  reply(FOLD);
  episode = await store.requestCommand(episode.id);
  episode = await store.judge(episode.id, { judgment: "correct" });
  assert.equal(episode.status, "completed");
});

test("Task 1: the episode fails after the maximum number of failed attempts", async () => {
  const { store, reply } = await makeStore();
  let episode = await store.create({ task: "task1", modelId: "gpt-5.6-sol", workId: "044" });
  reply("OK");
  episode = await store.initialize(episode.id);
  for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
    reply(FOLD);
    episode = await store.requestCommand(episode.id);
    episode = await store.judge(episode.id, { judgment: "incorrect" });
  }
  assert.equal(episode.status, "failed");
  await assert.rejects(store.requestCommand(episode.id));
});

test("Task 1: at most 20 images per request, keeping the initial message", async () => {
  const { store, reply, lastRequest } = await makeStore();
  let episode = await store.create({ task: "task1", modelId: "gpt-5.6-sol", workId: "065" }); // 10 transitions
  reply("OK");
  episode = await store.initialize(episode.id);
  for (let index = 0; index < 10; index += 1) {
    reply(FOLD);
    episode = await store.requestCommand(episode.id);
    episode = await store.judge(episode.id, { judgment: "correct" });
  }
  const messages = lastRequest();
  const images = messages.flatMap((message) => message.content).filter((block) => block === "<image>");
  assert.equal(images.length, 20); // 11 initial + 10 steps = 21 -> oldest step turn dropped
  assert.equal(messages[0].content.filter((block) => block === "<image>").length, 11);
  assert.deepEqual(messages[1], { role: "assistant", content: ["OK"] });
  assert.equal(messages[2].role, "user");
  assert.equal(episode.status, "completed");
});

test("Task 2: instructions, questions, feedback and invalid responses", async () => {
  const { store, reply, lastRequest } = await makeStore();
  let episode = await store.create({ task: "task2", modelId: "gpt-5.6-sol", workId: "044" });
  assert.equal(episode.status, "running");
  await assert.rejects(store.requestCommand(episode.id), /instruction/);

  reply("Which way?");
  episode = await store.requestCommand(episode.id, { instruction: "Fold it in half." });
  assert.equal(episode.transitions[0].pending.format.kind, "question");
  episode = await store.judge(episode.id, { judgment: "question", feedback: "Left to right." });
  reply(FOLD);
  episode = await store.requestCommand(episode.id);
  episode = await store.judge(episode.id, { judgment: "incorrect" });
  await assert.rejects(store.requestCommand(episode.id), /instruction/);
  reply("```json\n{broken}\n```");
  episode = await store.requestCommand(episode.id, { instruction: "Fold along the other diagonal." });
  await assert.rejects(store.judge(episode.id, { judgment: "invalid" }), /feedback/);
  episode = await store.judge(episode.id, { judgment: "invalid", feedback: "Output valid JSON." });
  reply(FOLD);
  episode = await store.requestCommand(episode.id);

  assert.deepEqual(lastRequest(), [
    { role: "user", content: ["<image>", "Fold it in half."] },
    { role: "assistant", content: ["Which way?"] },
    { role: "user", content: ["Left to right."] },
    { role: "assistant", content: [FOLD] },
    { role: "user", content: ["Fold along the other diagonal."] },
    { role: "assistant", content: ["```json\n{broken}\n```"] },
    { role: "user", content: ["Output valid JSON."] },
  ]);
  episode = await store.judge(episode.id, { judgment: "correct" });
  assert.equal(episode.transitions[0].failedAttempts, 2);
  assert.equal(episode.currentIndex, 1);

  // Undo restores the state before the last judgment.
  episode = await store.undo(episode.id);
  assert.equal(episode.currentIndex, 0);
  assert.ok(episode.transitions[0].pending);
});

test("Task 2: going back one attempt returns the instructor message as a draft", async () => {
  const { store, reply } = await makeStore();
  let episode = await store.create({ task: "task2", modelId: "gpt-5.6-sol", workId: "044" });
  reply(FOLD);
  episode = await store.requestCommand(episode.id, { instruction: "Fold it in hlaf." });
  let draft;
  ({ episode, draft } = await store.rewind(episode.id));
  assert.equal(draft, "Fold it in hlaf.");
  assert.equal(episode.transitions[0].instruction, "");
  assert.equal(episode.transitions[0].pending, null);

  reply(FOLD);
  episode = await store.requestCommand(episode.id, { instruction: "Fold it in half." });
  episode = await store.judge(episode.id, { judgment: "incorrect" });
  reply(FOLD);
  episode = await store.requestCommand(episode.id, { instruction: "Wrong feedback." });
  episode = await store.judge(episode.id, { judgment: "incorrect" });
  ({ episode, draft } = await store.rewind(episode.id)); // removes the second judged attempt
  assert.equal(draft, "Wrong feedback.");
  assert.equal(episode.transitions[0].attempts.length, 1);
  assert.equal(episode.transitions[0].attempts[0].feedback, null);
  assert.equal(episode.transitions[0].failedAttempts, 1);
});

test("working time is added per transition, kept on undo, and saved", async () => {
  const { store, reply } = await makeStore();
  let episode = await store.create({ task: "task1", modelId: "gpt-5.6-sol", workId: "044" });
  await store.addWorkingTime(episode.id, { transitionIndex: 0, elapsedMs: 4000 }); // initialization
  reply("OK");
  episode = await store.initialize(episode.id);
  reply(FOLD);
  episode = await store.requestCommand(episode.id);
  episode = await store.judge(episode.id, { judgment: "correct" });
  await store.addWorkingTime(episode.id, { transitionIndex: 1, elapsedMs: 2500 });
  episode = await store.undo(episode.id);
  assert.deepEqual(episode.transitions.map((transition) => transition.elapsedMs), [4000, 2500]);
  assert.equal(store.list()[0].elapsedMs, 6500);

  await assert.rejects(store.addWorkingTime(episode.id, { transitionIndex: 5, elapsedMs: 1000 }), /Unknown transition/);
  await assert.rejects(store.addWorkingTime(episode.id, { transitionIndex: 0, elapsedMs: -1 }), /out of range/);

  // Concurrent writes of the same episode are queued; the file holds the final state.
  await Promise.all([1, 2, 3].map(() => store.addWorkingTime(episode.id, { transitionIndex: 0, elapsedMs: 1000 })));
  const saved = JSON.parse(await readFile(path.join(store.logDirectory, `${episode.id}.json`), "utf8"));
  assert.equal(saved.transitions[0].elapsedMs, 7000);
});

test("undo: only correct/incorrect judgments can be undone, as in the original interface", async () => {
  const { store, reply } = await makeStore();
  let episode = await store.create({ task: "task2", modelId: "gpt-5.6-sol", workId: "044" });
  reply("Which layer?");
  episode = await store.requestCommand(episode.id, { instruction: "Fold up." });
  episode = await store.judge(episode.id, { judgment: "question", feedback: "All layers." });
  assert.equal(store.undoSnapshots.has(episode.id), false);
  reply(FOLD);
  episode = await store.requestCommand(episode.id);
  episode = await store.judge(episode.id, { judgment: "incorrect" });
  assert.equal(store.undoSnapshots.get(episode.id).currentIndex, 0);
  reply("```json\n{}\n```");
  episode = await store.requestCommand(episode.id, { instruction: "Fold it the other way." });
  episode = await store.judge(episode.id, { judgment: "invalid", feedback: "Use the command format." });
  assert.equal(store.undoSnapshots.has(episode.id), true); // the incorrect judgment is still undoable
  episode = await store.undo(episode.id);
  assert.deepEqual(episode.transitions[0].attempts.map((attempt) => attempt.judgment), ["question"]);
  assert.ok(episode.transitions[0].pending);

  // Going back one attempt in the same transition discards it.
  episode = await store.judge(episode.id, { judgment: "incorrect" });
  await store.rewind(episode.id);
  assert.equal(store.undoSnapshots.has(episode.id), false);
});
