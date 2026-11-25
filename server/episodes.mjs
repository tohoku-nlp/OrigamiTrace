// Episode protocol for Task 1 and Task 2 (see "Evaluation protocol" in the README).
//
// The conversation sent to the model is rebuilt from the recorded attempts,
// so an episode can be resumed from its log file after a restart.

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

import { validateCommandResponse } from "./command-format.mjs";

export const MAX_FAILED_ATTEMPTS = 3;
// Each request contains at most 20 images (the limit of Amazon Bedrock). In
// Task 1 the oldest turns after the initial message are dropped to stay within
// this limit.
const MAX_IMAGES_PER_REQUEST = 20;
// Images are sent as JPEG, resized to fit in 896 x 896.
const IMAGE_MAX_DIMENSION = 896;
const IMAGE_JPEG_QUALITY = 78;
// Upper bound for one working-time report from the interface.
const MAX_TIME_REPORT_MS = 10 * 60 * 1000;

export class EpisodeStore {
  // `modelCaller(modelId, systemPrompt, messages)` sends one request to a
  // controller and resolves to { text, modelId, stopReason, usage, latencyMs }.
  constructor({ dataDirectory, logDirectory, works, episodes, prompts, specification, modelCaller }) {
    Object.assign(this, { dataDirectory, logDirectory, works, prompts, specification, modelCaller });
    this.episodeDefinitions = new Map(episodes.map((episode) => [episode.id, episode]));
    this.episodes = new Map();
    // episode id -> state before the last correct/incorrect judgment (not persisted).
    // Recording a format error or answering a question does not replace it.
    this.undoSnapshots = new Map();
    this.imageCache = new Map();
    this.saveQueues = new Map(); // episode id -> promise of the last write
  }

  async loadLogs() {
    await mkdir(this.logDirectory, { recursive: true });
    for (const name of await readdir(this.logDirectory)) {
      if (!name.endsWith(".json")) continue;
      try {
        const episode = JSON.parse(await readFile(path.join(this.logDirectory, name), "utf8"));
        if (episode.id && this.works.has(episode.workId)) this.episodes.set(episode.id, episode);
      } catch {
        console.warn(`Skipping unreadable log: ${name}`);
      }
    }
  }

  list() {
    return [...this.episodes.values()]
      .map((episode) => summarize(episode))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id) {
    const episode = this.episodes.get(id);
    if (!episode) throw httpError(404, "Episode not found.");
    return episode;
  }

  async create({ task, modelId, workId }) {
    if (!["task1", "task2"].includes(task)) throw httpError(400, "task must be task1 or task2.");
    const work = this.works.get(workId);
    const definition = this.episodeDefinitions.get(workId);
    if (!work || !definition) throw httpError(400, `No episode is defined for work ${workId}.`);
    const { startImage, targetImage } = definition;
    for (let n = startImage; n <= targetImage; n += 1) {
      if (!work.images[n - 1]) throw httpError(400, `Image ${n} of ${work.folder} is missing.`);
    }

    const createdAt = new Date().toISOString();
    const episode = {
      id: `${createdAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "")}_${task}_${workId}_${randomUUID().slice(0, 6)}`,
      task,
      modelId,
      workId,
      work: work.folder,
      startImage,
      targetImage,
      status: task === "task1" ? "initializing" : "running",
      createdAt,
      completedAt: null,
      initialization: null,
      currentIndex: 0,
      transitions: Array.from({ length: targetImage - startImage }, (_, index) => ({
        from: startImage + index,
        to: startImage + index + 1,
        instruction: task === "task1" ? work.captions[startImage + index - 1] : "",
        status: "pending",
        failedAttempts: 0,
        attempts: [],
        pending: null,
        elapsedMs: 0,
      })),
    };
    this.episodes.set(episode.id, episode);
    await this.save(episode);
    return episode;
  }

  // Task 1: send all reference images and textual entries once.
  async initialize(id) {
    const episode = this.get(id);
    if (episode.task !== "task1" || episode.status !== "initializing") {
      throw httpError(409, "This episode does not need initialization.");
    }
    const result = await this.generate(episode, await this.task1InitialMessages(episode));
    episode.initialization = { response: result.text, ...metadata(result) };
    episode.status = "running";
    await this.save(episode);
    return episode;
  }

  // Ask the controller for the current transition.
  // Task 2: `instruction` is the instructor's message for this turn. The first
  // message of a transition becomes its instruction; after an incorrect
  // attempt, the message is recorded as the corrective feedback on that attempt.
  async requestCommand(id, { instruction } = {}) {
    const episode = this.get(id);
    const transition = this.currentTransition(episode);
    if (transition.pending) throw httpError(409, "Judge the current response first.");

    if (episode.task === "task2") {
      const text = String(instruction || "").trim();
      const last = transition.attempts.at(-1);
      const needsInput = !transition.instruction || (last && !last.feedback);
      if (needsInput && !text) throw httpError(400, "Write an instruction for the model.");
      if (!transition.instruction) transition.instruction = text;
      else if (needsInput) last.feedback = text;
    }

    const messages = await this.conversation(episode);
    let result;
    try {
      result = await this.generate(episode, messages);
    } catch (error) {
      await this.save(episode); // keep the instruction/feedback that was written
      throw error;
    }
    transition.pending = {
      response: result.text,
      format: validateCommandResponse(result.text, this.specification, {
        allowQuestion: episode.task === "task2",
      }),
      ...metadata(result),
    };
    await this.save(episode);
    return episode;
  }

  // judgment: "correct" | "incorrect" | "invalid" | "question"
  // feedback: Task 2 only (corrective feedback, or the answer to a question).
  async judge(id, { judgment, feedback }) {
    const episode = this.get(id);
    const transition = this.currentTransition(episode);
    const pending = transition.pending;
    if (!pending) throw httpError(409, "There is no response to judge.");

    const formatInvalid = pending.format.valid === false;
    if (formatInvalid && judgment !== "invalid") {
      throw httpError(400, "The response does not follow the command format; record it as invalid.");
    }
    if (!formatInvalid && !["correct", "incorrect", "question"].includes(judgment)) {
      throw httpError(400, "Unknown judgment.");
    }
    if (judgment === "question" && episode.task !== "task2") {
      throw httpError(400, "Questions are only answered in Task 2.");
    }

    const text = String(feedback || "").trim();
    let attemptFeedback = null;
    if (episode.task === "task1") {
      if (judgment === "incorrect") attemptFeedback = this.prompts.retryIncorrect;
      if (judgment === "invalid") attemptFeedback = this.prompts.retryInvalid;
    } else {
      // Task 2: the answer to a question and the feedback on an invalid response
      // are written when judging. The feedback on an incorrect response is
      // written afterwards and sent with the next request (requestCommand).
      if (judgment === "question" && !text) throw httpError(400, "Write an answer to the question.");
      if (judgment === "invalid" && !text) throw httpError(400, "Write feedback on the command format.");
      if (judgment === "question" || judgment === "invalid") attemptFeedback = text;
    }

    if (judgment === "correct" || judgment === "incorrect") this.undoSnapshots.set(id, structuredClone(episode));
    transition.attempts.push({
      ...pending,
      judgment,
      feedback: attemptFeedback,
      judgedAt: new Date().toISOString(),
    });
    transition.pending = null;

    if (judgment === "correct") {
      transition.status = "success";
      if (episode.currentIndex === episode.transitions.length - 1) {
        finish(episode, "completed");
      } else {
        episode.currentIndex += 1;
      }
    } else if (judgment !== "question") {
      transition.failedAttempts += 1;
      if (transition.failedAttempts >= MAX_FAILED_ATTEMPTS) {
        transition.status = "failed";
        finish(episode, "failed");
      }
    }
    await this.save(episode);
    return episode;
  }

  // Working time measured by the interface: the time this transition was the
  // current one on screen, excluding pauses and hidden tabs (in Task 1, the
  // initialization is counted in the first transition).
  async addWorkingTime(id, { transitionIndex, elapsedMs }) {
    const episode = this.get(id);
    const transition = episode.transitions[transitionIndex];
    if (!transition) throw httpError(400, "Unknown transition.");
    if (!(Number.isFinite(elapsedMs) && elapsedMs > 0 && elapsedMs <= MAX_TIME_REPORT_MS)) {
      throw httpError(400, "elapsedMs is out of range.");
    }
    transition.elapsedMs = (transition.elapsedMs || 0) + Math.round(elapsedMs);
    await this.save(episode);
    return episode;
  }

  // Revert the last judgment (to correct a mis-click). Working time is kept.
  async undo(id) {
    const current = this.get(id);
    const restored = this.undoSnapshots.get(id);
    if (!restored) throw httpError(409, "Nothing to undo.");
    this.undoSnapshots.delete(id);
    restored.transitions.forEach((transition, index) => {
      transition.elapsedMs = current.transitions[index].elapsedMs;
    });
    this.episodes.set(id, restored);
    await this.save(restored);
    return restored;
  }

  // Task 2: go back one attempt, e.g. when the instructor made a typo in an
  // instruction. Removes the unjudged response, or else the last judged
  // attempt, and returns the instructor message that produced it as `draft`
  // so that it can be rewritten. Other transitions are not changed.
  async rewind(id) {
    const episode = this.get(id);
    if (episode.task !== "task2") throw httpError(400, "Only Task 2 episodes can be rewound.");
    const transition = episode.transitions[episode.currentIndex];
    if (!transition.pending && !transition.attempts.length && !transition.instruction) {
      throw httpError(409, "There is no attempt to go back to.");
    }
    if (!transition.pending && transition.attempts.length) {
      const removed = transition.attempts.pop();
      if (removed.judgment === "incorrect" || removed.judgment === "invalid") {
        transition.failedAttempts = Math.max(0, transition.failedAttempts - 1);
      }
    }
    let draft = "";
    if (!transition.attempts.length) {
      draft = transition.instruction;
      transition.instruction = "";
    } else {
      const previous = transition.attempts.at(-1);
      if (previous.judgment !== "question") {
        draft = previous.feedback || "";
        previous.feedback = null;
      }
    }
    transition.pending = null;
    transition.status = "pending";
    if (episode.status !== "running") {
      episode.status = "running";
      episode.completedAt = null;
    }
    // The last judgment can no longer be undone if it was made in this transition.
    if (this.undoSnapshots.get(id)?.currentIndex === episode.currentIndex) this.undoSnapshots.delete(id);
    await this.save(episode);
    return { episode, draft };
  }

  currentTransition(episode) {
    if (episode.status !== "running") throw httpError(409, `The episode is ${episode.status}.`);
    return episode.transitions[episode.currentIndex];
  }

  // ---- Conversation ---------------------------------------------------------

  async task1InitialMessages(episode) {
    const work = this.works.get(episode.workId);
    const rows = episode.transitions.map(
      (transition) => `${transition.from},${csvCell(transition.instruction)}`,
    );
    const csv = ["step,instruction", ...rows].join("\r\n");
    const content = [
      { text: this.prompts.task1Initial },
      { text: `[File: reference-instructions.csv]\n${csv}` },
    ];
    for (let n = episode.startImage; n <= episode.targetImage; n += 1) {
      content.push(await this.imageBlock(work, n));
    }
    return [{ role: "user", content }];
  }

  async conversation(episode) {
    const work = this.works.get(episode.workId);
    const messages = [];
    if (episode.task === "task1") {
      messages.push(...(await this.task1InitialMessages(episode)));
      messages.push({ role: "assistant", content: [{ text: episode.initialization.response }] });
    }
    for (const transition of episode.transitions.slice(0, episode.currentIndex + 1)) {
      if (!transition.instruction) break;
      messages.push({
        role: "user",
        content: [await this.imageBlock(work, transition.from), { text: transition.instruction }],
      });
      for (const attempt of transition.attempts) {
        messages.push({ role: "assistant", content: [{ text: attempt.response }] });
        if (attempt.feedback) messages.push({ role: "user", content: [{ text: attempt.feedback }] });
      }
    }
    return episode.task === "task1" ? capImages(messages, MAX_IMAGES_PER_REQUEST) : messages;
  }

  async generate(episode, messages) {
    const systemPrompt = episode.task === "task1" ? this.prompts.task1System : this.prompts.task2System;
    try {
      return await this.modelCaller(episode.modelId, systemPrompt, messages);
    } catch (error) {
      throw httpError(502, error.message);
    }
  }

  async imageBlock(work, imageNumber) {
    const filePath = path.join(this.dataDirectory, "images", work.folder, work.images[imageNumber - 1]);
    const original = await readFile(filePath);
    const key = createHash("sha256").update(original).digest("hex");
    if (!this.imageCache.has(key)) {
      // rotate() applies the EXIF orientation, as browsers do.
      const resized = await sharp(original)
        .rotate()
        .resize({
          width: IMAGE_MAX_DIMENSION,
          height: IMAGE_MAX_DIMENSION,
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({ quality: IMAGE_JPEG_QUALITY })
        .toBuffer();
      this.imageCache.set(key, resized.toString("base64"));
    }
    return { image: { format: "jpeg", bytes: this.imageCache.get(key) } };
  }

  // Writes are queued per episode, so that a time report arriving during a
  // model request cannot interleave with another write of the same file.
  save(episode) {
    const write = async () => {
      const filePath = path.join(this.logDirectory, `${episode.id}.json`);
      const temporary = `${filePath}.tmp`;
      await mkdir(this.logDirectory, { recursive: true });
      await writeFile(temporary, JSON.stringify(episode, null, 2) + "\n");
      await rename(temporary, filePath);
    };
    const next = (this.saveQueues.get(episode.id) || Promise.resolve()).then(write, write);
    this.saveQueues.set(episode.id, next);
    return next;
  }
}

// Keep the initial message (and the model's reply to it) and drop the oldest
// later turns until the request has at most `limit` images.
function capImages(messages, limit) {
  const countImages = (list) =>
    list.reduce((sum, message) => sum + message.content.filter((block) => block.image).length, 0);
  if (countImages(messages) <= limit) return messages;
  const prefixLength = messages[1]?.role === "assistant" ? 2 : 1;
  const prefix = messages.slice(0, prefixLength);
  const rest = messages.slice(prefixLength);
  let drop = 0;
  while (drop < rest.length && countImages([...prefix, ...rest.slice(drop)]) > limit) {
    drop += 1; // drop one user turn ...
    while (drop < rest.length && rest[drop].role === "assistant") drop += 1; // ... and its replies
  }
  return [...prefix, ...rest.slice(drop)];
}

function finish(episode, status) {
  episode.status = status;
  episode.completedAt = new Date().toISOString();
}

function metadata(result) {
  return {
    modelId: result.modelId,
    stopReason: result.stopReason ?? null,
    usage: result.usage ?? null,
    latencyMs: result.latencyMs ?? null,
    generatedAt: new Date().toISOString(),
  };
}

function summarize(episode) {
  return {
    id: episode.id,
    task: episode.task,
    modelId: episode.modelId,
    workId: episode.workId,
    work: episode.work,
    status: episode.status,
    createdAt: episode.createdAt,
    completedAt: episode.completedAt,
    progress: episode.transitions.filter((transition) => transition.status === "success").length,
    transitions: episode.transitions.length,
    elapsedMs: totalWorkingTime(episode),
  };
}

export function totalWorkingTime(episode) {
  return episode.transitions.reduce((sum, transition) => sum + (transition.elapsedMs || 0), 0);
}

function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
