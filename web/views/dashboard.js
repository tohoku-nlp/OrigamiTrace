// Episode list and the form to start a new episode.

import { modelLabel, state } from "../state.js";
import { escapeHtml, formatClock, formatDuration, icons } from "../util.js";
import { errorTemplate, statusLabel, topbar } from "./common.js";

export function dashboardTemplate() {
  const { config, episodeList, listError } = state;
  if (!config) return `${topbar()}<main class="page">${errorTemplate(listError)}</main>`;
  const readyModels = config.models.filter((model) => model.ready);
  return `
    <div class="app-shell">
      ${topbar()}
      <main class="page dashboard-page">
        <section class="panel new-episode-panel">
          <p class="panel-kicker" style="margin-left:0">New episode</p>
          <h2>Start an episode</h2>
          ${errorTemplate(listError)}
          ${readyModels.length ? "" : `<div class="notice">${icons.alert}<span>No controller is ready. Set the API keys of the controllers in <code>models.json</code> in <code>.env</code> (see <code>.env.example</code>) and restart the server.</span></div>`}
          <form class="new-episode-form" data-form="create">
            <div class="field">
              <label>Task</label>
              <div class="task-choice">
                <label><input type="radio" name="task" value="task1" checked /> Task 1 · autonomous</label>
                <label><input type="radio" name="task" value="task2" /> Task 2 · human-guided</label>
              </div>
            </div>
            <div class="field">
              <label for="model-select">Controller</label>
              <select id="model-select" name="modelId" class="select">
                ${readyModels.length ? "" : `<option value="" disabled selected>No API key configured</option>`}
                ${config.models.map((model) => `<option value="${model.id}" ${model.ready ? "" : "disabled"}>${escapeHtml(model.label)}${model.ready ? "" : ` (set ${escapeHtml(model.missingEnv.join(", "))})`}</option>`).join("")}
              </select>
            </div>
            <div class="field">
              <label for="work-select">Episode</label>
              <select id="work-select" name="workId" class="select">
                ${config.works.map((work) => `<option value="${work.id}">${work.id} ${escapeHtml(work.designName)} · state ${work.startImage} → ${work.targetImage} (${work.targetImage - work.startImage} transitions)</option>`).join("")}
              </select>
            </div>
            <button class="btn btn-primary" type="submit" ${readyModels.length && config.works.length ? "" : "disabled"}>${icons.play} Start</button>
          </form>
        </section>
        <section class="panel">
          <p class="panel-kicker" style="margin-left:0">Episodes</p>
          ${episodeList.length ? episodeTableTemplate(episodeList) : `<p class="muted">No episodes yet. Each episode is saved as a JSON file in the log directory.</p>`}
        </section>
      </main>
    </div>
  `;
}

function episodeTableTemplate(episodes) {
  return `
    <table class="episode-table">
      <thead><tr><th>Started</th><th>Task</th><th>Controller</th><th>Work</th><th>Progress</th><th>Time</th><th>Status</th></tr></thead>
      <tbody>
        ${episodes.map((episode) => `
          <tr data-action="open-episode" data-id="${episode.id}">
            <td>${formatClock(episode.createdAt)}</td>
            <td>${episode.task === "task1" ? "Task 1" : "Task 2"}</td>
            <td>${escapeHtml(modelLabel(episode.modelId))}</td>
            <td>${escapeHtml(episode.work)}</td>
            <td>${episode.progress} / ${episode.transitions}</td>
            <td>${formatDuration(episode.elapsedMs)}</td>
            <td><span class="episode-status ${episode.status}">${statusLabel(episode.status)}</span></td>
          </tr>`).join("")}
      </tbody>
    </table>
  `;
}
