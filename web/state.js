// Client state shared by the views (web/views/) and the actions (app.js).
//
// The server keeps the episode itself (server/episodes.mjs); `state.view` is
// the last response of GET /api/episodes/:id. `experimentOf()` converts the
// episode into the step/attempt structure used by the templates.

export const state = {
  config: null, // GET /api/config
  episodeList: [], // GET /api/episodes
  view: null, // GET /api/episodes/:id
  isGenerating: false,
  generationError: "",
  listError: "",
  // Text typed by the evaluator, kept across re-renders.
  drafts: { caption: "", formatFeedback: "", answer: "" },
  // Task 2: whether the pending output is answered as a question or judged ("answer" | "judge").
  reviewMode: { key: null, mode: "" },
  // Completed / failed episodes: which step and attempt are shown read-only.
  viewStepIndex: null,
  viewAttemptIndex: null,
  commandHelpOpen: false,
  expandedQuestionSteps: new Set(),
  // The output whose commands are drawn on the image (redrawn by the plot filter).
  lastPlottedGeneration: null,
};

export function resetDrafts() {
  Object.assign(state.drafts, { caption: "", formatFeedback: "", answer: "" });
}

export function modelLabel(id) {
  return state.config?.models.find((model) => model.id === id)?.label || id;
}

// The work being evaluated, in the shape the templates expect.
export function projectOf() {
  const { episode, images, captions, designName, imageCount } = state.view;
  return {
    name: designName,
    folder: episode.work,
    imageCount,
    images,
    captions,
    displayImagePath: (n) => images[n]?.display || images[n]?.original || "",
    originalImagePath: (n) => images[n]?.original || "",
  };
}

function generationOf(record, imageNumber) {
  if (!record) return null;
  return {
    text: record.response,
    commandFormat: record.format,
    coordinateTransform: state.view.images[imageNumber]?.frame || null,
    generatedAt: record.generatedAt,
    latencyMs: record.latencyMs,
  };
}

export function experimentOf() {
  const { episode } = state.view;
  return {
    task: episode.task,
    modelId: episode.modelId,
    status: episode.status,
    currentStepIndex: episode.currentIndex,
    steps: episode.transitions.map((transition) => ({
      number: transition.from,
      status: transition.status,
      errors: transition.failedAttempts,
      originalInstruction: episode.task === "task2" ? transition.instruction : "",
      pendingGeneration: generationOf(transition.pending, transition.from),
      attempts: transition.attempts.map((attempt) => ({
        response: attempt.response,
        correct: attempt.judgment === "correct" ? true : attempt.judgment === "question" ? null : false,
        isFormatError: attempt.judgment === "invalid",
        isQuestion: attempt.judgment === "question",
        formatError: attempt.format?.valid === false ? attempt.format.reason : "",
        feedback: attempt.feedback || "",
        recordedAt: attempt.judgedAt,
        latencyMs: attempt.latencyMs,
        generation: generationOf(attempt, transition.from),
      })),
    })),
  };
}

// The review mode is reset whenever a new output arrives.
export function currentReviewMode(generation) {
  const key = generation?.generatedAt || null;
  if (state.reviewMode.key !== key) state.reviewMode = { key, mode: "" };
  return state.reviewMode.mode;
}
