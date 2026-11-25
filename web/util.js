export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function formatClock(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// mm:ss
export function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor((milliseconds || 0) / 1000));
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(Math.floor(totalSeconds / 60))}:${pad(totalSeconds % 60)}`;
}

export const icons = {
  origami: `<svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
    <path d="M4 7.5 15.7 4l12.1 5.2-8.5 6.1L28 26 15.6 21 5 26l3.1-12.1L4 7.5Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>
    <path d="m4 7.5 11.6 13.4L15.7 4l3.6 11.3L28 9.2M8.1 13.9l11.2 1.4" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>
  </svg>`,
  play: `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m9 6 8 6-8 6V6Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>`,
  back: `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m15 18-6-6 6-6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  copy: `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.7"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" stroke="currentColor" stroke-width="1.7"/></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m5 12 4 4L19 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  close: `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  alert: `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 8v5m0 3h.01M10.3 4.8 2.8 18a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 4.8a2 2 0 0 0-3.4 0Z" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  finish: `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 3v18M6 5h11l-2 4 2 4H6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  pause: `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 5v14M15 5v14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>`,
  info: `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.7"/><path d="M12 11v5m0-8h.01" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
};

// Reference for evaluators: example commands and what each field means.
export const COMMAND_HELP = [
  {
    title: "1. fold",
    json: `{
  "command_name": "fold",
  "parameters": {
    "fold_infos": [{
      "crease_line_edge1": [0, -0.9],
      "crease_line_edge2": [0, 0.9],
      "source_point": [0.8, 0],
      "target_point": [-0.8, 0],
      "source_layers": ["all"],
      "theta": 180,
      "fold_type": "valley"
    }]
  }
}`,
    rows: [
      ["crease_line_edge1 / edge2", "The line through these two points is the crease (dashed line on the image)."],
      ["source_point", "A point on the moving side before the fold (● on the image)."],
      ["target_point", "Where source_point goes after the fold (◆ on the image)."],
      ["source_layers", 'Layers to move: ["all"] for all layers, [1] for the top layer only.'],
      ["theta", "Fold angle in degrees. 180 folds the paper completely flat."],
      ["fold_type", '"valley" or "mountain".'],
      ["fold_infos", "Several elements mean several folds performed at the same time."],
    ],
  },
  {
    title: "2. fold with insertion (tuck the folded flap between layers)",
    json: `{
  "command_name": "fold",
  "parameters": {
    "fold_infos": [{
      "crease_line_edge1": [-0.6, 0.25],
      "crease_line_edge2": [0.6, 0.25],
      "source_point": [0, 0.75],
      "target_point": [0, -0.25],
      "source_layers": [1],
      "theta": 180,
      "fold_type": "valley",
      "pocket_point": [0, 0],
      "destination_layer": [1, 2]
    }]
  }
}`,
    rows: [
      ["pocket_point", "Where the flap at source_point is inserted after the fold (▲ on the image)."],
      ["destination_layer", "The two layers around the insertion: [1, 2] inserts between layers 1 and 2."],
      ["(note)", "Both fields are omitted for a fold without insertion."],
    ],
  },
  {
    title: "3. make_crease",
    json: `{
  "command_name": "make_crease",
  "parameters": {
    "fold_infos": [ ... ]
  }
}`,
    rows: [
      ["command_name", "Folds as specified and unfolds again, leaving only the crease."],
      ["parameters", "Same fields as fold."],
    ],
  },
  {
    title: "4. rotate_3d",
    json: `{
  "command_name": "rotate_3d",
  "parameters": {
    "theta_x": 0,
    "theta_y": 0,
    "theta_z": -90
  }
}`,
    rows: [
      ["theta_x", "Rotation about the x axis (tilting the paper toward or away from the viewer)."],
      ["theta_y", "Rotation about the y axis (e.g. turning the paper over from left to right)."],
      ["theta_z", "Rotation in the image plane: + is counterclockwise, − is clockwise. The example turns 90° clockwise."],
    ],
  },
  {
    title: "5. finish",
    json: `{ "command_name": "finish", "parameters": {} }`,
    rows: [["finish", "The model is complete; no further operation. No parameters."]],
  },
];
