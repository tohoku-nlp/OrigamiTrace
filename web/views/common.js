// Parts shared by several screens.

import { state } from "../state.js";
import { isPaused, workingTime } from "../timer.js";
import { COMMAND_HELP, escapeHtml, formatDuration, icons } from "../util.js";

export const pad2 = (value) => String(value).padStart(2, "0");

export function errorTemplate(message) {
  return message ? `<div class="api-error">${icons.alert}<span>${escapeHtml(message)}</span></div>` : "";
}

export function statusLabel(status) {
  return { initializing: "Not started", running: "In progress", completed: "Completed", failed: "Failed" }[status] || status;
}

export function topbar() {
  const ready = state.config?.models.filter((model) => model.ready) || [];
  return `
    <header class="topbar">
      <button class="brand" data-action="dashboard" aria-label="Back to the episode list">
        <span class="brand-mark">${icons.origami}</span>
        <span><span class="brand-title">OrigamiTrace Evaluation</span></span>
      </button>
      <div class="topbar-actions">
        <span class="api-status ${ready.length ? "ready" : ""}" title="${escapeHtml(ready.map((model) => model.label).join(", ") || "No API key configured")}">
          <span class="api-status-dot"></span>${ready.length ? "API READY" : "NO API KEY"}
        </span>
      </div>
    </header>
  `;
}

// Title of an episode screen. `meta` is shown on the right.
export function experimentHeader(project, experiment, { meta = "", backAction = "dashboard", readOnly = false, title = project.name } = {}) {
  return `
    <section class="experiment-header">
      <div class="experiment-title">
        <button class="btn btn-secondary" data-action="${backAction}" aria-label="${readOnly ? "Back to the result" : "Back to the episode list"}">${icons.back}</button>
        <span class="task-badge">TASK ${experiment.task === "task1" ? "1" : "2"}</span>
        <div>
          <h1>${escapeHtml(title)}</h1>
          <p class="muted${readOnly ? " step-review-byline" : ""}">${escapeHtml(project.folder)}${readOnly ? " · read-only" : ""}</p>
        </div>
      </div>
      ${meta}
    </section>
  `;
}

// [label, value] pairs, followed by the working time and (optionally) the pause button.
export function liveMetaTemplate(items, { pause = true } = {}) {
  return `
    <div class="experiment-meta">
      ${items.map(([label, value]) => metaItem(label, value)).join("")}
      <div class="meta-item"><span class="meta-label">Time</span><span class="meta-value" id="timer">${formatDuration(workingTime(state.view.episode))}</span></div>
      ${
        !pause || isPaused()
          ? ""
          : `<button class="btn btn-secondary btn-pause" data-action="pause-work" title="Press this when you leave. The working-time clock stops and the evaluation is locked until you resume.">${icons.pause} Pause</button>`
      }
    </div>
  `;
}

function metaItem(label, value) {
  return `<div class="meta-item"><span class="meta-label">${label}</span><span class="meta-value">${value}</span></div>`;
}

// While paused, the content is blurred and cannot be used.
export function pauseScope(content) {
  const paused = isPaused();
  return `
    <div class="pause-scope ${paused ? "is-paused" : ""}">
      ${
        paused
          ? `
            <div class="pause-overlay" role="dialog" aria-modal="true" aria-labelledby="pause-title">
              <div class="pause-card">
                <span class="pause-card-icon">${icons.pause}</span>
                <h2 id="pause-title">Paused</h2>
                <p>The working-time clock is stopped.<br />Getting model outputs, judging, and typing are locked.</p>
                <button class="btn btn-primary" data-action="resume-work">Resume</button>
              </div>
            </div>
          `
          : ""
      }
      <div class="pause-content" ${paused ? "inert" : ""}>${content}</div>
    </div>
  `;
}

// Shown after a correct / incorrect judgment until it is undone (or, in Task 2,
// until the evaluator goes back one attempt in the same step).
export function undoBannerTemplate() {
  if (state.view.undoState == null) return "";
  return `
    <div class="undo-banner">
      ${icons.alert}
      <span>Your last judgment was recorded. You can redo Step ${state.view.undoState}.</span>
      <button class="btn btn-secondary btn-sm" data-action="undo-last-judgment" ${state.isGenerating ? "disabled" : ""}>${icons.back} Undo</button>
    </div>
  `;
}

export function stepItemTemplate(step, index, currentIndex, clickable = false) {
  const current = index === currentIndex;
  const statusIcon = step.status === "success" ? "✓" : step.status === "failed" ? "×" : current ? "●" : "·";
  const statusText =
    step.status === "success"
      ? "Done"
      : step.status === "failed"
        ? "Failed"
        : current
          ? `Attempt ${step.errors + 1}`
          : "Waiting";
  const tag = clickable ? "button" : "div";
  const attrs = clickable ? `data-action="view-step" data-step-index="${index}"` : "";
  const lockedClass = !clickable && index > currentIndex ? "locked" : "";
  return `
    <${tag} class="step-item ${current ? "current" : ""} ${lockedClass}" ${attrs}>
      <span class="step-number">${pad2(step.number)}</span>
      <span class="step-copy"><strong>Step ${step.number}</strong><span>${statusText}</span></span>
      <span class="step-status">${statusIcon}</span>
    </${tag}>
  `;
}

export function stepListTemplate(experiment, currentIndex, clickable = false) {
  return `
    <div class="step-list">
      ${experiment.steps.map((item, index) => stepItemTemplate(item, index, currentIndex, clickable)).join("")}
    </div>
  `;
}

// The state image with the commands drawn on it. Holding the image shows the
// next reference state (see the pointer handlers in app.js).
export function imageStageTemplate(project, imageNumber, overlay = "") {
  const current = project.displayImagePath(imageNumber);
  const nextExists = imageNumber + 1 <= state.view.episode.targetImage;
  return `
    <div class="image-stage" data-action="peek-next-image">
      <img
        src="${escapeHtml(current)}"
        alt="${escapeHtml(project.name)} state ${imageNumber}"
        data-current-src="${escapeHtml(current)}"
        ${nextExists ? `data-next-src="${escapeHtml(project.displayImagePath(imageNumber + 1))}"` : ""}
      />
      ${overlay}
      <span class="image-label">${escapeHtml(project.images[imageNumber]?.name || "")}</span>
      ${nextExists ? `<span class="image-peek-hint">Press and hold to show the next reference state</span>` : ""}
    </div>
  `;
}

export function imageToolbarTemplate(title, project, imageNumber) {
  return `
    <div class="image-toolbar">
      <h2>${title}</h2>
      <span class="image-count muted">IMAGE ${pad2(imageNumber)} / ${pad2(project.imageCount)}</span>
    </div>
  `;
}

const OPERATION_LABELS = {
  fold: "Fold",
  make_crease: "Make crease",
  insert: "Insert",
  rotate_3d: "Rotate",
  finish: "Finish",
};

// The operations in the model output (with valley / mountain for folds).
export function operationSummaryTemplate(generation) {
  const operations = generation?.commandFormat?.operations;
  if (!operations?.length) return "";
  const chips = operations
    .map((operation) => {
      const label = OPERATION_LABELS[operation.commandName] || operation.commandName;
      const foldTypes = (operation.foldTypes || []).filter((foldType) => ["valley", "mountain"].includes(foldType));
      const suffix = foldTypes.length ? ` (${foldTypes.join(", ")})` : "";
      return `<span class="operation-chip">${escapeHtml(label)}${escapeHtml(suffix)}</span>`;
    })
    .join("");
  return `<div class="operation-summary"><span class="operation-summary-label">Operations</span>${chips}</div>`;
}

export function commandHelpTemplate() {
  return `
    <details class="command-help" ${state.commandHelpOpen ? "open" : ""}>
      <summary class="command-help-summary">${icons.info}<span>Command reference</span><span class="command-help-hint">click to open / close</span></summary>
      <div class="command-help-body">
        <p class="command-help-intro">Example model outputs and the meaning of each field. Refer to this when the markers alone are not enough to judge.</p>
        <p class="command-help-note">Coordinates [x, y] have the center of the paper at [0, 0], +x to the right and +y upward.</p>
        ${COMMAND_HELP.map(
          (item) => `
          <section class="command-help-item">
            <h3>${escapeHtml(item.title)}</h3>
            <div class="command-help-cols">
              <pre class="command-help-json">${escapeHtml(item.json)}</pre>
              <table class="command-help-table">
                <thead><tr><th>Field</th><th>Meaning</th></tr></thead>
                <tbody>
                  ${item.rows.map(([key, meaning]) => `<tr><td><code>${escapeHtml(key)}</code></td><td>${escapeHtml(meaning)}</td></tr>`).join("")}
                </tbody>
              </table>
            </div>
          </section>`,
        ).join("")}
      </div>
    </details>
  `;
}
