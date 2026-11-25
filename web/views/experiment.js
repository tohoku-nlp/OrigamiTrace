// The judging screen of an episode in progress (Task 1 and Task 2).
//
// Left: the steps. Middle: the current state image with the commands of the
// model output drawn on it, and the textual entry (Task 1) or the instructor's
// input (Task 2). Right: the model output and the judgment.

import { commandPlotTemplate, plotFilterTemplate } from "../plot.js";
import { currentReviewMode, state } from "../state.js";
import { escapeHtml, icons } from "../util.js";
import {
  commandHelpTemplate,
  errorTemplate,
  experimentHeader,
  imageStageTemplate,
  imageToolbarTemplate,
  liveMetaTemplate,
  operationSummaryTemplate,
  pauseScope,
  stepListTemplate,
  topbar,
  undoBannerTemplate,
} from "./common.js";

export function experimentTemplate(project, experiment) {
  const step = experiment.steps[experiment.currentStepIndex];
  const task2 = experiment.task === "task2";
  const pending = step.pendingGeneration;
  const lastWrongAttempt = step.errors > 0
    ? [...step.attempts].reverse().find((attempt) => attempt.correct === false)
    : null;
  // Without a new output, the incorrect output of the previous attempt stays on the image.
  state.lastPlottedGeneration = pending || lastWrongAttempt?.generation || null;

  return `
    <div class="app-shell">
      ${topbar()}
      <main class="page experiment-page">
        ${experimentHeader(project, experiment, {
          meta: liveMetaTemplate([
            ["Progress", `${experiment.currentStepIndex + 1} / ${experiment.steps.length}`],
            ["Mistakes", experiment.steps.reduce((sum, item) => sum + item.errors, 0)],
          ]),
        })}
        ${pauseScope(`
          ${undoBannerTemplate()}
          <section class="experiment-grid">
            <aside class="panel steps-panel">
              <p class="panel-kicker">Steps</p>
              ${stepListTemplate(experiment, experiment.currentStepIndex)}
            </aside>
            <section class="panel image-panel">
              ${imageToolbarTemplate("Current state", project, step.number)}
              ${imageColumnTemplate(project, step, pending, lastWrongAttempt)}
              ${task2 ? task2InputTemplate(project, experiment, step, lastWrongAttempt) : task1CaptionTemplate(project, step)}
            </section>
            ${responsePanelTemplate(experiment, step, lastWrongAttempt)}
          </section>
        `)}
        ${commandHelpTemplate()}
      </main>
    </div>
  `;
}

function imageColumnTemplate(project, step, pending, lastWrongAttempt) {
  const previous = !pending && lastWrongAttempt?.generation;
  const summary = pending
    ? operationSummaryTemplate(pending)
    : previous
      ? `<p class="muted previous-wrong-note">↓ Showing the operation of the previous (incorrect) attempt</p>${operationSummaryTemplate(previous)}`
      : "";
  const overlay = pending
    ? commandPlotTemplate(pending)
    : previous
      ? `<div class="previous-wrong-overlay">${commandPlotTemplate(previous)}</div>`
      : "";
  return `
    ${summary}
    ${imageStageTemplate(project, step.number, overlay)}
    ${plotFilterTemplate(state.lastPlottedGeneration)}
  `;
}

function task1CaptionTemplate(project, step) {
  return `
    <div class="instruction-card">
      <div class="instruction-card-header">
        <span>CAPTION</span>
        <button class="btn btn-ghost" data-action="copy-instruction">${icons.copy} Copy</button>
      </div>
      <p>${escapeHtml(project.captions[step.number])}</p>
    </div>
  `;
}

// Task 2: the instructor writes the instruction (or, after an incorrect
// attempt, the correction) while looking at the dataset entry.
function task2InputTemplate(project, experiment, step, lastWrongAttempt) {
  // The instructor message that led to lastWrongAttempt: the instruction for
  // the first attempt, otherwise the feedback on the previous attempt.
  const lastWrongIndex = lastWrongAttempt ? step.attempts.indexOf(lastWrongAttempt) : -1;
  const lastWrongInstruction =
    lastWrongIndex === 0
      ? step.originalInstruction
      : lastWrongIndex > 0
        ? step.attempts[lastWrongIndex - 1]?.feedback || ""
        : "";
  return `
    <div class="instruction-card caption-input-card">
      <div class="instruction-card-header">
        <span>HUMAN PARAPHRASE</span>
        <button class="btn btn-ghost" data-action="copy-caption">${icons.copy} Copy</button>
      </div>
      <span class="caption-input-label">${step.originalInstruction ? "Correction to the model" : "Instruction to the model"}</span>
      <textarea id="human-caption" data-draft="caption" class="textarea caption-input" placeholder="${
        step.originalInstruction
          ? "Say concretely what was wrong and how to fix it (e.g. the fold direction is reversed / the wrong layer was moved). The first instruction is kept as is."
          : "Paraphrase the dataset entry below in natural language without referring to the stickers or the blue guide lines.&#10;e.g. “Fold the right corner over to meet the left corner.”"
      }">${escapeHtml(state.drafts.caption)}</textarea>
    </div>
    <div class="instruction-card reference-card">
      <div class="dataset-reference">
        <span>Dataset entry (reference only; not sent to the model)</span>
        <p>${escapeHtml(project.captions[step.number])}</p>
      </div>
      ${
        step.originalInstruction
          ? `
            <div class="dataset-reference">
              <span>Your instruction</span>
              <p>${escapeHtml(step.originalInstruction)}</p>
              <button class="btn btn-secondary btn-sm redo-step-button" data-action="undo-last-attempt" ${state.isGenerating ? "disabled" : ""}>
                ${icons.back} Made a mistake in the instruction: go back one attempt
              </button>
            </div>
          `
          : ""
      }
      ${lastWrongAttempt && lastWrongInstruction ? referenceTemplate("Your previous instruction", lastWrongInstruction) : ""}
      ${lastWrongAttempt ? referenceTemplate("Previous incorrect output (reference only)", lastWrongAttempt.response) : ""}
      ${stepQuestionHistoryTemplate(step)}
    </div>
    ${dialogueLogTemplate(experiment)}
  `;
}

function referenceTemplate(label, text) {
  return `
    <div class="dataset-reference error-reference">
      <span>${label}</span>
      <p>${escapeHtml(text)}</p>
    </div>
  `;
}

function responsePanelTemplate(experiment, step, lastWrongAttempt) {
  const task2 = experiment.task === "task2";
  const pending = step.pendingGeneration;
  const mode = currentReviewMode(pending);
  const formatInvalid = pending?.commandFormat?.valid === false;
  const isQuestionMode = task2 && mode === "answer";
  const { isGenerating } = state;
  return `
    <section class="panel response-panel">
      <p class="panel-kicker" style="margin-left:0">Evaluation</p>
      <h2>Record the model output</h2>
      <p class="muted">Send the current image and the ${task2 ? "instruction" : "caption"} to the model and judge its output.</p>
      <div class="generator-card">
        <div class="generator-info">
          <span class="api-status ready"><span class="api-status-dot"></span>MODEL</span>
          <strong title="${escapeHtml(experiment.modelId)}">${escapeHtml(experiment.modelId)}</strong>
        </div>
        <button class="btn btn-primary" data-action="generate" ${isGenerating || pending ? "disabled" : ""}>
          ${isGenerating ? '<span class="spinner"></span>Generating' : `${icons.play}Get model output`}
        </button>
      </div>
      ${errorTemplate(state.generationError)}
      ${task2 ? `<div class="notice">${icons.alert}<span>Write natural instructions without referring to the stickers or the blue guide lines in the background.</span></div>` : ""}
      ${
        task2 && (step.originalInstruction || step.attempts.length)
          ? `<div class="redo-step-row"><button class="btn btn-secondary btn-sm redo-step-button" data-action="undo-last-attempt" ${isGenerating ? "disabled" : ""}>${icons.back} Made a mistake in the instruction / go back one attempt</button></div>`
          : ""
      }
      <div class="attempts" aria-label="Attempts">
        ${[1, 2, 3].map((number) => attemptChipTemplate(number, step)).join("")}
      </div>
      <div class="field">
        <label for="command-response">${isQuestionMode ? "Question from the model" : "Model output"} <span class="required">REQUIRED</span></label>
        <textarea id="command-response" class="textarea" readonly placeholder="Press “Get model output”.">${escapeHtml(pending?.text || "")}</textarea>
      </div>
      ${judgeActionsTemplate({ task2, step, pending, mode, formatInvalid, lastWrongAttempt })}
    </section>
  `;
}

function attemptChipTemplate(number, step) {
  let className = "";
  // Format errors count as attempts; answered questions do not.
  const judgedAttempts = step.attempts.filter((attempt) => !attempt.isQuestion).length;
  if (number <= step.errors) className = "error";
  if (step.status === "success" && number === judgedAttempts) className = "success";
  if (step.status === "pending" && number === step.errors + 1) className = "active";
  return `<span class="attempt-chip ${className}" title="Attempt ${number}">${number}</span>`;
}

// What the evaluator can do with the pending output:
//   invalid format        -> record it (Task 2: with feedback on the format)
//   Task 2, not yet chosen -> treat it as a command to judge, or as a question
//   Task 2, question      -> answer it (not counted as an attempt)
//   otherwise             -> correct / incorrect (also shown before the output
//                            arrives; judging then asks for the output first)
function judgeActionsTemplate({ task2, step, pending, mode, formatInvalid, lastWrongAttempt }) {
  const disabled = state.isGenerating ? "disabled" : "";
  if (formatInvalid) {
    return `
      <div class="notice format-error-notice">
        ${icons.alert}
        <span>
          <strong>The command format is invalid</strong>
          <small>${escapeHtml(step.pendingGeneration.commandFormat.reason || "The output does not follow the JSON specification.")}</small>
        </span>
      </div>
      ${
        task2
          ? `
            <span class="caption-input-label">Feedback to the model (tell it that the command format is invalid)</span>
            <textarea id="format-error-feedback" data-draft="formatFeedback" class="textarea caption-input" placeholder="e.g. The output is not in JSON format. Please output it again in the specified format.">${escapeHtml(state.drafts.formatFeedback)}</textarea>
          `
          : ""
      }
      <div class="judge-actions" style="grid-template-columns: 1fr;">
        <button class="btn btn-primary" data-action="acknowledge-format-error" ${disabled}>${task2 ? "Record with this feedback" : "OK"}</button>
      </div>
      <p class="footer-note">Recorded as a format error, which counts as an incorrect attempt (the episode ends after 3 failed attempts on a step).${task2 ? " The feedback above is sent to the model with the next request." : ""}</p>
    `;
  }
  if (task2 && pending && !mode) {
    return `
      <div class="notice">${icons.alert}<span>Treat this output as a command to judge, or as a question to answer?</span></div>
      <div class="judge-actions">
        <button class="btn btn-secondary" data-action="review-answer" ${disabled}>${icons.alert} Answer as a question</button>
        <button class="btn btn-primary" data-action="review-judge" ${disabled}>${icons.check} Judge</button>
      </div>
    `;
  }
  const backToChoice = `
    <div class="review-back-row">
      <button class="btn btn-ghost btn-sm" data-action="review-back" ${disabled}>${icons.back} Back to the choice</button>
    </div>
  `;
  if (task2 && mode === "answer") {
    return `
      <div class="notice">${icons.alert}<span>Answer the question to continue. It is not judged and does not count as an attempt.</span></div>
      <div class="field">
        <label for="question-answer">Answer to the question <span class="required">REQUIRED</span></label>
        <textarea id="question-answer" data-draft="answer" class="textarea" placeholder="Write your answer">${escapeHtml(state.drafts.answer)}</textarea>
      </div>
      ${backToChoice}
      <div class="judge-actions" style="grid-template-columns: 1fr;">
        <button class="btn btn-primary" data-action="answer-question" ${disabled}>${icons.play} Send the answer</button>
      </div>
      <p class="footer-note">After sending the answer, the model is asked again for this step.</p>
    `;
  }
  const task1Retry = !task2 && step.errors > 0 && lastWrongAttempt;
  return `
    ${task1Retry ? referenceTemplate("Previous incorrect output (reference only)", lastWrongAttempt.response) : ""}
    ${task1Retry ? feedbackTemplate() : ""}
    ${task2 && pending ? backToChoice : ""}
    <div class="judge-actions">
      <button class="btn btn-success" data-action="judge-correct" ${disabled}>${icons.check} Correct</button>
      <button class="btn btn-danger" data-action="judge-incorrect" ${disabled}>${icons.close} Incorrect</button>
    </div>
    <p class="footer-note">Each judgment is saved with its time. The episode ends after 3 failed attempts on a step.</p>
  `;
}

// Task 1: the fixed feedback sent with the retry.
function feedbackTemplate() {
  return `
    <div class="feedback-box">
      <label>Feedback sent with the retry</label>
      <p class="feedback-text">${escapeHtml(state.config.retryIncorrect)}</p>
      <button class="btn btn-secondary" data-action="copy-feedback">${icons.copy} Copy feedback</button>
    </div>
  `;
}

// Task 2: the instructions written for earlier steps (without the model outputs).
function dialogueLogTemplate(experiment) {
  const entries = experiment.steps
    .slice(0, experiment.currentStepIndex)
    .filter((step) => step.originalInstruction);
  if (!entries.length) return "";
  return `
    <div class="dialogue-log">
      <p class="dialogue-log-header">Dialogue log</p>
      <div class="dialogue-log-list">
        ${entries.map((step) => dialogueLogEntryTemplate(step)).join("")}
      </div>
    </div>
  `;
}

function dialogueLogEntryTemplate(step) {
  const statusClass = step.status === "success" ? "success" : step.status === "failed" ? "error" : "";
  const statusMark = step.status === "success" ? "✓" : step.status === "failed" ? "×" : "";
  const questions = step.attempts.filter((attempt) => attempt.isQuestion);
  return `
    <div class="dialogue-log-entry">
      <div class="dialogue-log-entry-head">
        <span class="dialogue-log-step">Step ${step.number}</span>
        ${statusMark ? `<span class="dialogue-log-status ${statusClass}">${statusMark}</span>` : ""}
      </div>
      <p class="dialogue-log-text">${escapeHtml(step.originalInstruction)}</p>
      ${
        questions.length
          ? `
            <details class="dialogue-log-qa-details" data-step="${step.number}" ${state.expandedQuestionSteps.has(step.number) ? "open" : ""}>
              <summary class="dialogue-log-qa-summary">${questions.length} question${questions.length > 1 ? "s" : ""}<span class="dialogue-log-qa-hint">click to show</span></summary>
              ${questions.map((attempt) => questionTemplate(attempt)).join("")}
            </details>
          `
          : ""
      }
    </div>
  `;
}

// Questions already answered in the current step.
function stepQuestionHistoryTemplate(step) {
  const questions = step.attempts.filter((attempt) => attempt.isQuestion);
  if (!questions.length) return "";
  return `
    <div class="dialogue-log step-question-history">
      <p class="dialogue-log-header">Questions in this step</p>
      <div class="dialogue-log-list">
        ${questions.map((attempt) => questionTemplate(attempt)).join("")}
      </div>
    </div>
  `;
}

function questionTemplate(attempt) {
  return `
    <div class="dialogue-log-qa">
      <p class="dialogue-log-qa-line"><span class="dialogue-log-qa-label">Q</span>${escapeHtml(attempt.response)}</p>
      <p class="dialogue-log-qa-line"><span class="dialogue-log-qa-label">A</span>${escapeHtml(attempt.feedback)}</p>
    </div>
  `;
}
