// Judging interface for Task 1 and Task 2: routing, actions, and events.
//
// The server keeps the episode state (server/episodes.mjs). This module sends
// the evaluator's actions and re-renders the screens in web/views/ from the
// shared state (state.js). Working time is measured in timer.js.

import { api } from "./api.js";
import { commandPlotTemplate, togglePlotFilter } from "./plot.js";
import { experimentOf, projectOf, resetDrafts, state } from "./state.js";
import { flushTimer, setPaused, syncTimer } from "./timer.js";
import { dashboardTemplate } from "./views/dashboard.js";
import { experimentTemplate } from "./views/experiment.js";
import { initializationTemplate } from "./views/initialization.js";
import { resultTemplate, stepReviewTemplate } from "./views/result.js";

const app = document.querySelector("#app");

// ---- Rendering --------------------------------------------------------------

function render() {
  const scroll = window.scrollY;
  app.innerHTML = state.view ? episodeTemplate() : dashboardTemplate();
  window.scrollTo(0, scroll);
  syncTimer();
}

function episodeTemplate() {
  const project = projectOf();
  const experiment = experimentOf();
  if (experiment.status === "completed" || experiment.status === "failed") {
    return state.viewStepIndex != null
      ? stepReviewTemplate(project, experiment, state.viewStepIndex)
      : resultTemplate(project, experiment);
  }
  if (experiment.status === "initializing") return initializationTemplate(project, experiment);
  return experimentTemplate(project, experiment);
}

// "#/episodes/<id>" shows an episode; anything else shows the episode list.
async function route() {
  const id = location.hash.match(/^#\/episodes\/([\w-]+)/)?.[1];
  Object.assign(state, { generationError: "", listError: "", viewStepIndex: null, viewAttemptIndex: null });
  try {
    if (!state.config) state.config = await api("/api/config");
    if (id) {
      const opened = state.view?.episode.id !== id;
      state.view = await api(`/api/episodes/${id}`);
      if (opened) {
        resetDrafts();
        state.drafts.caption = instructorText(state.view.episode);
      }
    } else {
      state.view = null;
      state.episodeList = await api("/api/episodes");
    }
  } catch (error) {
    state.listError = error.message;
  }
  render();
}

// ---- Actions ----------------------------------------------------------------

// Runs an episode action on the server; resolves to the response, or null
// when it failed (the error is shown on the screen).
async function act(action, body = {}) {
  state.isGenerating = true;
  state.generationError = "";
  render();
  try {
    await flushTimer();
    const response = await api(`/api/episodes/${state.view.episode.id}/${action}`, body);
    state.view = response;
    return response;
  } catch (error) {
    state.generationError = error.message;
    return null;
  } finally {
    state.isGenerating = false;
    render();
  }
}

async function generateModelOutput() {
  const { episode } = state.view;
  let instruction;
  if (episode.task === "task2") {
    // Task 2 needs the instructor's text for the first request of a
    // transition and after an incorrect attempt (the correction).
    const transition = episode.transitions[episode.currentIndex];
    const last = transition.attempts.at(-1);
    const needsText = !transition.instruction || (last && !last.feedback);
    instruction = state.drafts.caption.trim();
    if (needsText && !instruction) {
      showToast("Write an instruction for the model");
      document.querySelector("#human-caption")?.focus();
      return;
    }
  }
  if (await act("request", { instruction })) {
    const latency = state.view.episode.transitions[state.view.episode.currentIndex]?.pending?.latencyMs;
    showToast(`Got the model output${Number.isFinite(latency) ? ` (${latency} ms)` : ""}`);
  }
}

// Task 2: the text of the instruction box for the current transition. It holds
// the latest instruction or correction sent to the model, and is empty when a
// new one has to be written (no instruction yet, or after an incorrect attempt).
function instructorText(episode) {
  if (episode.task !== "task2" || episode.status !== "running") return "";
  const transition = episode.transitions[episode.currentIndex];
  const last = transition.attempts.at(-1);
  if (!transition.instruction || (last?.judgment === "incorrect" && !last.feedback)) return "";
  const correction = transition.attempts.findLast((attempt) => attempt.judgment === "incorrect" && attempt.feedback);
  return correction ? correction.feedback : transition.instruction;
}

async function judge(correct) {
  const { episode } = state.view;
  if (!episode.transitions[episode.currentIndex]?.pending) {
    showToast("Get the model output first");
    return;
  }
  if (episode.task === "task2" && !state.drafts.caption.trim()) {
    showToast("Write the instruction for the model");
    document.querySelector("#human-caption")?.focus();
    return;
  }
  if (await act("judge", { judgment: correct ? "correct" : "incorrect" })) {
    // Task 2: after an incorrect attempt, the box is cleared for the correction.
    state.drafts.caption = "";
    render();
    showToast(correct ? "Recorded as correct" : "Recorded as incorrect");
  }
}

async function acknowledgeFormatError() {
  const feedback = state.drafts.formatFeedback.trim();
  if (state.view.episode.task === "task2" && !feedback) {
    showToast("Write feedback telling the model that the command format is invalid");
    document.querySelector("#format-error-feedback")?.focus();
    return;
  }
  if (await act("judge", { judgment: "invalid", feedback })) {
    state.drafts.formatFeedback = "";
    render();
    showToast("Recorded as a format error (counts as incorrect)");
  }
}

async function answerQuestion() {
  const answer = state.drafts.answer.trim();
  if (!answer) {
    showToast("Write an answer to the question");
    document.querySelector("#question-answer")?.focus();
    return;
  }
  if (await act("judge", { judgment: "question", feedback: answer })) {
    state.drafts.answer = "";
    await generateModelOutput();
  }
}

// Task 2: remove the last attempt and put its instructor message back in the box.
async function undoLastAttempt() {
  const response = await act("rewind");
  if (!response) return;
  state.drafts.caption = response.draft || "";
  state.viewStepIndex = null;
  render();
  showToast("Went back one attempt");
}

async function createEpisode(form) {
  try {
    const created = await api("/api/episodes", {
      task: form.get("task"),
      modelId: form.get("modelId"),
      workId: form.get("workId"),
    });
    location.hash = `#/episodes/${created.episode.id}`;
  } catch (error) {
    state.listError = error.message;
    render();
  }
}

function copyText(text, message = "Copied") {
  if (!text) return;
  navigator.clipboard?.writeText(text).then(() => showToast(message), () => showToast("Could not copy"));
}

let toastTimer;
function showToast(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2200);
}

// ---- Events -----------------------------------------------------------------

const ACTIONS = {
  dashboard: () => (location.hash = ""),
  "open-episode": (button) => (location.hash = `#/episodes/${button.dataset.id}`),
  "pause-work": () => {
    setPaused(true);
    render();
  },
  "resume-work": () => {
    setPaused(false);
    render();
  },
  "initialize-task1": () => act("initialize"),
  generate: generateModelOutput,
  "judge-correct": () => judge(true),
  "judge-incorrect": () => judge(false),
  "acknowledge-format-error": acknowledgeFormatError,
  "undo-last-judgment": async () => {
    if (!(await act("undo"))) return;
    state.drafts.caption = instructorText(state.view.episode);
    render();
    showToast("Undid the last judgment");
  },
  "start-task2": () => {
    const { episode } = state.view;
    createEpisode(new Map([["task", "task2"], ["modelId", episode.modelId], ["workId", episode.workId]]));
  },
  "undo-last-attempt": undoLastAttempt,
  // Task 2: answer the output as a question, judge it, or go back to the choice.
  "review-answer": () => setReviewMode("answer"),
  "review-judge": () => setReviewMode("judge"),
  "review-back": () => setReviewMode(""),
  "answer-question": answerQuestion,
  "view-step": (button) => {
    state.viewStepIndex = Number(button.dataset.stepIndex);
    state.viewAttemptIndex = null;
    render();
  },
  "view-attempt": (button) => {
    state.viewAttemptIndex = Number(button.dataset.attemptIndex);
    render();
  },
  "back-to-result": () => {
    state.viewStepIndex = null;
    state.viewAttemptIndex = null;
    render();
  },
  "copy-instruction": () => {
    const { episode, captions } = state.view;
    copyText(captions[episode.transitions[episode.currentIndex].from]);
  },
  "copy-caption": () => copyText(state.drafts.caption.trim()),
  "copy-feedback": () => copyText(state.config.retryIncorrect, "Copied the feedback"),
};

function setReviewMode(mode) {
  state.reviewMode.mode = mode;
  render();
  document.querySelector(mode === "answer" ? "#question-answer" : "#command-response")?.focus();
}

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (!button || button.disabled) return;
  ACTIONS[button.dataset.action]?.(button);
});

document.addEventListener("input", (event) => {
  const key = event.target.dataset?.draft;
  if (key) state.drafts[key] = event.target.value;
});

document.addEventListener("submit", (event) => {
  if (event.target.dataset.form !== "create") return;
  event.preventDefault();
  createEpisode(new FormData(event.target));
});

// Show the next reference state while the image is pressed.
document.addEventListener("pointerdown", (event) => {
  const img = event.target.closest('.image-stage[data-action="peek-next-image"] img[data-next-src]');
  if (!img) return;
  img.src = img.dataset.nextSrc;
  img.closest(".image-stage").classList.add("peeking");
});

function restorePeekedImage() {
  const stage = document.querySelector(".image-stage.peeking");
  if (!stage) return;
  const img = stage.querySelector("img[data-current-src]");
  if (img) img.src = img.dataset.currentSrc;
  stage.classList.remove("peeking");
}
document.addEventListener("pointerup", restorePeekedImage);
document.addEventListener("pointercancel", restorePeekedImage);

// "All / 1 / 2 / ..." filter: clicking the selected option again hides all.
// Only the overlay is replaced, so that text being typed is kept.
document.addEventListener("click", (event) => {
  const input = event.target.closest('input[name="plot-filter"]');
  if (!input) return;
  if (togglePlotFilter(input.value) === "none") input.checked = false;
  const overlay = document.querySelector(".image-stage .command-coordinate-overlay");
  if (!state.lastPlottedGeneration || !overlay) return;
  const holder = document.createElement("div");
  holder.innerHTML = commandPlotTemplate(state.lastPlottedGeneration).trim();
  if (holder.firstElementChild) overlay.replaceWith(holder.firstElementChild);
});

// Keep <details> open / closed across re-renders (toggle does not bubble).
document.addEventListener(
  "toggle",
  (event) => {
    if (!(event.target instanceof HTMLDetailsElement)) return;
    if (event.target.classList.contains("command-help")) {
      state.commandHelpOpen = event.target.open;
    } else if (event.target.classList.contains("dialogue-log-qa-details")) {
      const step = Number(event.target.dataset.step);
      if (event.target.open) state.expandedQuestionSteps.add(step);
      else state.expandedQuestionSteps.delete(step);
    }
  },
  true,
);

window.addEventListener("hashchange", route);
route();
