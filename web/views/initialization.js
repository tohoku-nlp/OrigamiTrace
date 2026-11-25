// Task 1: the screen before the first step, which sends all reference images
// and textual entries of the segment once.

import { state } from "../state.js";
import { escapeHtml, icons } from "../util.js";
import { errorTemplate, experimentHeader, liveMetaTemplate, pad2, topbar } from "./common.js";

export function initializationTemplate(project, experiment) {
  const { episode } = state.view;
  const numbers = [];
  for (let n = episode.startImage; n <= episode.targetImage; n += 1) numbers.push(n);
  const transitions = episode.transitions;
  return `
    <div class="app-shell">
      ${topbar()}
      <main class="page experiment-page">
        ${experimentHeader(project, experiment, {
          title: `${project.name} · Initial input`,
          meta: liveMetaTemplate(
            [
              ["Images", numbers.length],
              ["Instructions", transitions.length],
            ],
            { pause: false },
          ),
        })}
        <section class="initialization-grid">
          <section class="panel initialization-data">
            <div class="initialization-heading">
              <div>
                <p class="panel-kicker">All reference data</p>
                <h2>All images and instructions of the segment</h2>
              </div>
              <span class="range-pill">${pad2(episode.startImage)} — ${pad2(episode.targetImage)}</span>
            </div>
            <div class="reference-gallery">
              ${numbers.map((n) => `
                <figure class="reference-item">
                  <img src="${escapeHtml(project.originalImagePath(n))}" alt="Reference image ${n}" />
                  <figcaption>IMAGE ${pad2(n)}</figcaption>
                </figure>
              `).join("")}
            </div>
            <ol class="instruction-list">
              ${transitions.map((transition) => `
                <li><span>${pad2(transition.from)}</span><p>${escapeHtml(transition.instruction)}</p></li>
              `).join("")}
            </ol>
          </section>
          <aside class="panel initialization-action">
            <p class="panel-kicker" style="margin-left:0">Initialization</p>
            <h2>Send once at the start</h2>
            <p class="muted">All images and one CSV file with all instructions are sent to the model. After the model replies <code>OK</code>, the steps begin.</p>
            <div class="initialization-summary">
              <div><span>Images</span><strong>${numbers.length}</strong></div>
              <div><span>Instructions</span><strong>${transitions.length}</strong></div>
            </div>
            ${errorTemplate(state.generationError)}
            <button class="btn btn-primary initialization-button" data-action="initialize-task1" ${state.isGenerating ? "disabled" : ""}>
              ${state.isGenerating ? '<span class="spinner"></span>Sending' : `${icons.play}Send the initial data`}
            </button>
          </aside>
        </section>
      </main>
    </div>
  `;
}
