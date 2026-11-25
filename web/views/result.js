// Completed or failed episodes: the result, and each step read-only.

import { commandPlotTemplate, plotFilterTemplate } from "../plot.js";
import { state } from "../state.js";
import { workingTime } from "../timer.js";
import { escapeHtml, formatClock, formatDuration, icons } from "../util.js";
import {
  experimentHeader,
  imageStageTemplate,
  imageToolbarTemplate,
  operationSummaryTemplate,
  stepListTemplate,
  topbar,
  undoBannerTemplate,
} from "./common.js";

// Episode-level metrics as in the paper: S_trans (1 if the target state was
// reached) and A_step (fraction of completed transitions).
function metrics(experiment) {
  const completed = experiment.steps.filter((step) => step.status === "success").length;
  const total = experiment.steps.length;
  return {
    completed,
    total,
    sTrans: completed === total ? 1 : 0,
    aStep: total ? completed / total : 0,
    errors: experiment.steps.reduce((sum, step) => sum + step.errors, 0),
    attempts: experiment.steps.reduce((sum, step) => sum + step.attempts.length, 0),
  };
}

export function resultTemplate(project, experiment) {
  const { episode } = state.view;
  const success = experiment.status === "completed";
  const result = metrics(experiment);
  const time = workingTime(episode);
  return `
    <div class="app-shell">
      ${topbar()}
      <main class="page">
        <button class="btn btn-secondary" data-action="dashboard">${icons.back} Episodes</button>
        ${undoBannerTemplate()}
        <section class="result-card">
          <div class="result-icon ${success ? "" : "failed"}">${success ? icons.finish : icons.alert}</div>
          <p class="eyebrow">${experiment.task === "task1" ? "Task 1" : "Task 2"} result</p>
          <h1>${success ? "The episode is completed" : "The episode ended after 3 failed attempts on a step"}</h1>
          <p class="page-lead">${escapeHtml(project.name)} · ${escapeHtml(project.folder)}. Saved as <code>${escapeHtml(episode.id)}.json</code> in the log directory.</p>
          <p class="result-byline">Model: <strong>${escapeHtml(experiment.modelId)}</strong></p>
          <div class="result-metrics">
            <div class="metric"><span>Completed steps</span><strong>${result.completed} / ${result.total}</strong></div>
            <div class="metric"><span>S_trans</span><strong>${result.sTrans}</strong></div>
            <div class="metric"><span>A_step</span><strong>${result.aStep.toFixed(2)}</strong></div>
            <div class="metric"><span>Total errors</span><strong>${result.errors}</strong></div>
          </div>
          <div class="result-metrics result-metrics-2col">
            <div class="metric"><span>Average request time</span><strong>${formatDuration(result.attempts ? time / result.attempts : 0)}</strong></div>
            <div class="metric"><span>Working time</span><strong>${formatDuration(time)}</strong></div>
          </div>
          <div class="result-actions">
            ${
              experiment.task === "task1"
                ? `<button class="btn btn-success" data-action="start-task2">${icons.play} Go on to Task 2</button>`
                : ""
            }
            ${
              experiment.status === "failed" && experiment.task === "task2"
                ? `<button class="btn btn-primary" data-action="undo-last-attempt">${icons.back} Go back one attempt</button>`
                : ""
            }
          </div>
        </section>
        <section class="panel steps-panel steps-panel-result">
          <p class="panel-kicker">Steps</p>
          <h2>View each step (read-only)</h2>
          ${stepListTemplate(experiment, -1, true)}
        </section>
      </main>
    </div>
  `;
}

// One step of a completed or failed episode, with all its attempts. Selecting
// an attempt draws its commands on the image.
export function stepReviewTemplate(project, experiment, stepIndex) {
  const step = experiment.steps[stepIndex];
  const task2 = experiment.task === "task2";
  const selectedIndex =
    step.attempts.length === 0
      ? -1
      : Math.min(state.viewAttemptIndex ?? step.attempts.length - 1, step.attempts.length - 1);
  const selected = step.attempts[selectedIndex]?.generation || null;
  state.lastPlottedGeneration = selected;
  return `
    <div class="app-shell">
      ${topbar()}
      <main class="page experiment-page">
        ${experimentHeader(project, experiment, {
          backAction: "back-to-result",
          readOnly: true,
        })}
        <section class="experiment-grid">
          <aside class="panel steps-panel">
            <p class="panel-kicker">Steps</p>
            ${stepListTemplate(experiment, stepIndex, true)}
          </aside>
          <section class="panel image-panel">
            ${imageToolbarTemplate("State", project, step.number)}
            ${operationSummaryTemplate(selected)}
            ${imageStageTemplate(project, step.number, commandPlotTemplate(selected))}
            ${plotFilterTemplate(selected)}
            ${
              step.attempts.length > 1
                ? `<p class="muted image-attempt-note">Showing attempt ${selectedIndex + 1} (select another attempt in the list)</p>`
                : ""
            }
            <div class="instruction-card">
              <div class="instruction-card-header"><span>${task2 ? "HUMAN PARAPHRASE" : "CAPTION"}</span></div>
              <p>${escapeHtml(task2 ? step.originalInstruction || "(this step was not reached)" : project.captions[step.number])}</p>
              ${
                task2
                  ? `<div class="dataset-reference">
                      <span>Dataset entry (not sent to the model)</span>
                      <p>${escapeHtml(project.captions[step.number])}</p>
                    </div>`
                  : ""
              }
            </div>
          </section>
          <section class="panel response-panel">
            <p class="panel-kicker" style="margin-left:0">Attempts</p>
            <h2>Model outputs (${step.attempts.length})</h2>
            ${
              step.attempts.length === 0
                ? `<p class="muted">No attempts in this step.</p>`
                : step.attempts.map((attempt, index) => attemptDetailTemplate(attempt, index, index === selectedIndex)).join("")
            }
          </section>
        </section>
      </main>
    </div>
  `;
}

function attemptDetailTemplate(attempt, index, selected) {
  const [chipClass, label] = attempt.isQuestion
    ? ["", "Question from the model"]
    : attempt.isFormatError
      ? ["", "Format error"]
      : attempt.correct
        ? ["success", "Correct"]
        : ["error", "Incorrect"];
  return `
    <div class="attempt-detail ${selected ? "selected" : ""}" data-action="view-attempt" data-attempt-index="${index}" title="Show this attempt on the image">
      <div class="attempt-detail-header">
        <span class="attempt-chip ${chipClass}">${index + 1}</span>
        <strong>${escapeHtml(label)}</strong>
        ${attempt.recordedAt ? `<span class="muted">${formatClock(attempt.recordedAt)}</span>` : ""}
      </div>
      <pre class="attempt-response">${escapeHtml(attempt.response || "")}</pre>
      ${
        attempt.isQuestion
          ? `<p class="muted">Answer: ${escapeHtml(attempt.feedback)}</p>`
          : `${attempt.formatError ? `<p class="muted">${escapeHtml(attempt.formatError)}</p>` : ""}
             ${attempt.feedback ? `<p class="muted">Feedback: ${escapeHtml(attempt.feedback)}</p>` : ""}`
      }
    </div>
  `;
}
