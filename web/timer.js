// Working time, as reported in the paper (Appendix F): how long each transition
// was the current one on screen while its episode was in progress, including
// waiting for model responses. The clock stops while the evaluator has paused
// or the tab is hidden. In Task 1, the initialization counts toward the first
// transition.
//
// Time is accumulated here and sent to the server (POST /api/episodes/:id/time)
// every few seconds, before each action, and when the page is closed.

import { api } from "./api.js";
import { state } from "./state.js";
import { formatDuration } from "./util.js";

const TICK_MS = 1000;
const REPORT_INTERVAL_MS = 10_000;
// A longer gap between ticks means the computer was asleep; it is not counted.
const SUSPEND_GAP_MS = 30_000;
// The server accepts at most this much per report.
const MAX_REPORT_MS = 10 * 60 * 1000;
const PAUSE_STORAGE_KEY = "origamitrace:paused";

// The transition being timed: { episodeId, transitionIndex, lastTick, accumulated }.
let clock = null;
// Time not yet confirmed by the server, keyed by "episodeId|transitionIndex".
const unsent = new Map();
const inFlight = new Map();
let lastReport = Date.now();

// Pausing is kept in this browser, so that it survives reloads; only the
// Resume button ends it.
let paused = (() => {
  try {
    return localStorage.getItem(PAUSE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
})();

export function isPaused() {
  return paused;
}

export function setPaused(value) {
  paused = value;
  try {
    if (value) localStorage.setItem(PAUSE_STORAGE_KEY, "1");
    else localStorage.removeItem(PAUSE_STORAGE_KEY);
  } catch {
    // Without storage, the pause still holds in this tab.
  }
  syncTimer();
}

// Starts, stops, or switches the clock to match what is on screen.
// Called after every render.
export function syncTimer() {
  const episode = state.view?.episode;
  const shouldRun =
    episode && ["initializing", "running"].includes(episode.status) && !document.hidden && !paused;
  const target = shouldRun ? { episodeId: episode.id, transitionIndex: episode.currentIndex } : null;
  if (clock && target && clock.episodeId === target.episodeId && clock.transitionIndex === target.transitionIndex) {
    return;
  }
  if (clock) {
    collect();
    sendUnsent();
  }
  clock = target ? { ...target, lastTick: Date.now(), accumulated: 0 } : null;
}

// Sends all measured time; awaited before each action so that the server's
// response already includes it.
export async function flushTimer() {
  collect();
  await sendUnsent();
}

export function transitionTime(episode, index) {
  const key = keyOf(episode.id, index);
  let total = (episode.transitions[index]?.elapsedMs || 0) + (unsent.get(key) || 0) + (inFlight.get(key) || 0);
  if (clock && clock.episodeId === episode.id && clock.transitionIndex === index) {
    total += clock.accumulated + Math.min(Date.now() - clock.lastTick, SUSPEND_GAP_MS);
  }
  return total;
}

export function workingTime(episode) {
  return episode.transitions.reduce((sum, _transition, index) => sum + transitionTime(episode, index), 0);
}

function keyOf(episodeId, transitionIndex) {
  return `${episodeId}|${transitionIndex}`;
}

function advance() {
  if (!clock) return;
  const now = Date.now();
  const delta = now - clock.lastTick;
  clock.lastTick = now;
  if (delta > 0 && delta <= SUSPEND_GAP_MS) clock.accumulated += delta;
}

// Moves the time measured so far from the clock to `unsent`.
function collect() {
  advance();
  if (!clock || clock.accumulated <= 0) return;
  const key = keyOf(clock.episodeId, clock.transitionIndex);
  unsent.set(key, (unsent.get(key) || 0) + clock.accumulated);
  clock.accumulated = 0;
}

async function sendUnsent() {
  lastReport = Date.now();
  const batch = [...unsent.entries()];
  unsent.clear();
  await Promise.all(
    batch.map(async ([key, total]) => {
      const ms = Math.min(total, MAX_REPORT_MS);
      if (total > ms) unsent.set(key, total - ms);
      const [episodeId, index] = key.split("|");
      const transitionIndex = Number(index);
      inFlight.set(key, (inFlight.get(key) || 0) + ms);
      try {
        const { elapsedMs } = await api(`/api/episodes/${episodeId}/time`, { transitionIndex, elapsedMs: ms });
        const episode = state.view?.episode;
        if (episode?.id === episodeId && episode.transitions[transitionIndex]) {
          episode.transitions[transitionIndex].elapsedMs = elapsedMs;
        }
      } catch {
        unsent.set(key, (unsent.get(key) || 0) + ms); // retried with the next report
      } finally {
        const left = inFlight.get(key) - ms;
        if (left > 0) inFlight.set(key, left);
        else inFlight.delete(key);
      }
    }),
  );
}

setInterval(() => {
  advance();
  const timer = document.querySelector("#timer");
  if (timer && state.view) timer.textContent = formatDuration(workingTime(state.view.episode));
  if (Date.now() - lastReport >= REPORT_INTERVAL_MS) {
    collect();
    sendUnsent();
  }
}, TICK_MS);

document.addEventListener("visibilitychange", syncTimer);

// When the page is closed, send the rest without waiting for a response.
window.addEventListener("pagehide", () => {
  collect();
  for (const [key, total] of unsent) {
    const [episodeId, index] = key.split("|");
    const body = JSON.stringify({ transitionIndex: Number(index), elapsedMs: Math.min(total, MAX_REPORT_MS) });
    navigator.sendBeacon?.(`/api/episodes/${episodeId}/time`, new Blob([body], { type: "application/json" }));
  }
  unsent.clear();
});
