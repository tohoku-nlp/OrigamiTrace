// Markers of a model command drawn over the display image.
//
//   x  crease_line_edge1 / crease_line_edge2 (the crease is drawn between them)
//   ●  source_point          ◆ target_point          ▲ pocket_point (insertion)
//
// `transform` maps normalized coordinates to display-image pixels:
//   px = originX + x * scaleX,  py = originY - y * scaleY

import { escapeHtml } from "./util.js";

export const PLOT_COLORS = ["#7b2cbf", "#e76f00", "#0077b6", "#c2185b", "#00866a", "#8b5a00"];

// Which fold_info to draw: "all", a 1-based index, or "none" (the selected one
// clicked again). Reset to "all" whenever the shown generation changes.
let plotFilter = { key: null, value: "all" };

export function plotFilterFor(generation) {
  const key = generation ? generation.generatedAt || generation.text || "" : null;
  if (plotFilter.key !== key) plotFilter = { key, value: "all" };
  return plotFilter.value;
}

export function togglePlotFilter(value) {
  plotFilter.value = plotFilter.value === value ? "none" : value;
  return plotFilter.value;
}

// "All / 1 / 2 / ..." under the image, shown only with two or more fold_infos.
export function plotFilterTemplate(generation) {
  const foldInfos = generation?.commandFormat?.foldInfos || [];
  if (foldInfos.length < 2 || !generation?.coordinateTransform) return "";
  const selected = plotFilterFor(generation);
  const option = (value, label, color) => `
    <label class="plot-filter-option${color ? "" : " plot-filter-all"}">
      <input type="radio" name="plot-filter" value="${value}" ${selected === value ? "checked" : ""} />
      ${color ? `<span class="plot-filter-num" style="--plot-color:${color}">${label}</span>` : label}
    </label>`;
  return `
    <div class="plot-filter" role="radiogroup" aria-label="Fold to show">
      <span class="plot-filter-label">Show</span>
      ${option("all", "All", "")}
      ${foldInfos.map((_, index) => option(String(index + 1), index + 1, PLOT_COLORS[index % PLOT_COLORS.length])).join("")}
    </div>
  `;
}

// Which side of the image (top / bottom / left / right) a point is closest to,
// using the triangles formed by the diagonals. Used to stack annotations on the
// same side without collisions.
function nearestEdgeKey(point, transform) {
  const dx = point.x - transform.width / 2;
  const dy = point.y - transform.height / 2;
  if (Math.abs(dx) * transform.height > Math.abs(dy) * transform.width) {
    return dx < 0 ? "left" : "right";
  }
  return dy < 0 ? "top" : "bottom";
}

export function commandPlotTemplate(generation) {
  const plotSelected = plotFilterFor(generation);
  const foldInfos = generation?.commandFormat?.foldInfos || [];
  const operations = generation?.commandFormat?.operations || [];
  const rotationOp = operations.find(
    (operation) => operation.commandName === "rotate_3d" && operation.rotation,
  );
  const transform = generation?.coordinateTransform;
  if ((!foldInfos.length && !rotationOp) || !transform?.width || !transform?.height) {
    return "";
  }

  const colors = PLOT_COLORS;
  const baseSize = Math.min(transform.width, transform.height);
  const markerRadius = Math.max(9, baseSize * 0.01);
  const lineWidth = Math.max(5, baseSize * 0.006);
  const annotationFontSize = Math.max(19, baseSize * 0.026);
  const point = ([x, y]) => ({
    x: transform.originX + x * transform.scaleX,
    y: transform.originY - y * transform.scaleY,
  });

  // Rows of leader annotations are counted per image side, not per fold_info,
  // so that unrelated annotations on different sides do not push each other out.
  const foldLeaderRowCounts = {};
  // How many shown creases share each endpoint. Annotations avoid shared points
  // (e.g. the center of radial folds), where they would pile up.
  const endpointKey = (raw) => `${Math.round(raw[0] * 100)},${Math.round(raw[1] * 100)}`;
  const endpointUseCount = new Map();
  foldInfos.forEach((foldInfo, index) => {
    if (plotSelected !== "all" && plotSelected !== String(index + 1)) return;
    for (const raw of [foldInfo.creaseLineEdge1, foldInfo.creaseLineEdge2]) {
      const key = endpointKey(raw);
      endpointUseCount.set(key, (endpointUseCount.get(key) || 0) + 1);
    }
  });
  // With two or more creases shown, the fold annotations are placed in columns
  // outside the paper on the left and right (near the creases they would overlap).
  const visibleFoldCount = foldInfos.filter(
    (_, index) => plotSelected === "all" || plotSelected === String(index + 1),
  ).length;
  const calloutText = (foldInfo, index) => {
    const layersText = formatSourceLayers(foldInfo.sourceLayers);
    return `${index + 1} ${foldTypeAndThetaText(foldInfo)}${layersText ? ` · ${layersText}` : ""}`;
  };
  const widestCallout = Math.max(
    0,
    ...foldInfos.map((foldInfo, index) =>
      plotSelected === "all" || plotSelected === String(index + 1)
        ? estimateTextWidth(calloutText(foldInfo, index), annotationFontSize)
        : 0,
    ),
  );
  // Use the columns only when there is room outside the coordinate frame;
  // otherwise annotate at the crease ends.
  const calloutReach = (transform.scaleX || transform.scaleY || 1) * 1.12;
  const calloutsFit =
    transform.originX + calloutReach + widestCallout + 12 <= transform.width &&
    transform.originX - calloutReach - widestCallout - 12 >= 0;
  const useCallouts = visibleFoldCount >= 2 && calloutsFit;
  const callouts = [];
  const groups = foldInfos.map((foldInfo, index) => {
    if (plotSelected !== "all" && plotSelected !== String(index + 1)) return "";
    const color = colors[index % colors.length];
    const edge1 = point(foldInfo.creaseLineEdge1);
    const edge2 = point(foldInfo.creaseLineEdge2);
    // The crease is drawn only between the two x markers (extending it to the
    // image border makes several creases indistinguishable).
    const creaseLine = { start: edge1, end: edge2 };
    const source = point(foldInfo.sourcePoint);
    const target = point(foldInfo.targetPoint);
    const targetRadius = markerRadius * 1.5;
    const targetPoints = [
      `${target.x},${target.y - targetRadius}`,
      `${target.x + targetRadius},${target.y}`,
      `${target.x},${target.y + targetRadius}`,
      `${target.x - targetRadius},${target.y}`,
    ].join(" ");
    const sourceRadius = markerRadius * 1.5;

    // Layer label (all layers / layer N), placed beside the source marker on the
    // side away from the image center, where it overlaps the other markers less.
    const layersText = formatSourceLayers(foldInfo.sourceLayers);
    const layersSide = source.x >= transform.originX ? "right" : "left";
    const layersGap = sourceRadius + annotationFontSize * 0.5;
    const layersAnnotation = layersText
      ? plainAnnotationTemplate(
          source.x + (layersSide === "right" ? layersGap : -layersGap),
          source.y + (source.y <= transform.originY ? -1 : 1) * annotationFontSize * 0.35,
          layersText,
          color,
          annotationFontSize,
          lineWidth,
          layersSide,
        )
      : "";

    const creaseMid = { x: (edge1.x + edge2.x) / 2, y: (edge1.y + edge2.y) / 2 };
    const foldTypeText = foldTypeAndThetaText(foldInfo);
    // Fold-type label (valley / mountain + angle): attached to the crease endpoint
    // farther from the source/target markers and led out toward the image border.
    // Falls back to the crease midpoint when both endpoints are close to the markers.
    const distToPoints = (p) =>
      Math.min(
        Math.hypot(p.x - source.x, p.y - source.y),
        Math.hypot(p.x - target.x, p.y - target.y),
      );
    // Only endpoints not shared with other creases are candidates.
    const endpointCandidates = [
      [edge1, foldInfo.creaseLineEdge1],
      [edge2, foldInfo.creaseLineEdge2],
    ]
      .filter(([, raw]) => (endpointUseCount.get(endpointKey(raw)) || 0) <= 1)
      .map(([pointOnImage]) => pointOnImage);
    const farEndpoint = endpointCandidates.length
      ? endpointCandidates.reduce((best, p) => (distToPoints(p) > distToPoints(best) ? p : best))
      : null;
    const endpointClear = Boolean(farEndpoint) && distToPoints(farEndpoint) >= annotationFontSize * 2.5;
    const foldAnchor = endpointClear ? farEndpoint : creaseMid;
    const foldLeaderDir = foldAnchor.x <= transform.originX ? -1 : 1;
    const foldLeaderVDir = foldAnchor.y <= transform.originY ? -1 : 1;
    const foldLeaderSideKey = nearestEdgeKey(foldAnchor, transform);
    const foldLeaderRow = foldLeaderRowCounts[foldLeaderSideKey] || 0;
    foldLeaderRowCounts[foldLeaderSideKey] = foldLeaderRow + 1;
    const foldTypeAnnotation = foldTypeText
      ? leaderAnnotationTemplate(
          foldAnchor.x,
          foldAnchor.y,
          endpointClear ? markerRadius : 0,
          foldTypeText,
          color,
          annotationFontSize,
          lineWidth,
          foldLeaderDir,
          foldLeaderRow,
          foldLeaderVDir,
        )
      : "";
    if (useCallouts && foldTypeText) {
      callouts.push({
        index,
        anchor: foldAnchor,
        radius: endpointClear ? markerRadius : 0,
        color,
        text: calloutText(foldInfo, index),
      });
    }
    // A fold_info with pocket_point / destination_layer also inserts the folded
    // flap into a layer gap: draw the insertion point (▲) in the same color.
    let insertMarkup = "";
    if (foldInfo.pocketPoint && foldInfo.destinationLayer) {
      const pocket = point(foldInfo.pocketPoint);
      const pocketSize = markerRadius * 1.6;
      const pocketPoints = [
        `${pocket.x},${pocket.y - pocketSize}`,
        `${pocket.x + pocketSize},${pocket.y + pocketSize * 0.8}`,
        `${pocket.x - pocketSize},${pocket.y + pocketSize * 0.8}`,
      ].join(" ");
      const destinationText = destinationAnnotationText(foldInfo.destinationLayer);
      const destinationAnnotation = destinationText
        ? leaderAnnotationTemplate(
            pocket.x,
            pocket.y,
            pocketSize,
            destinationText,
            color,
            annotationFontSize,
            lineWidth,
            pocket.x <= transform.originX ? -1 : 1,
            0,
            1,
          )
        : "";
      insertMarkup = `
        <polygon points="${pocketPoints}" fill="${color}" stroke="white" stroke-width="${lineWidth}" />
        ${destinationAnnotation}
      `;
    }

    return `
      <g class="fold-info-plot" data-fold-info="${index + 1}">
        <line
          class="crease-line-plot"
          x1="${creaseLine.start.x}" y1="${creaseLine.start.y}"
          x2="${creaseLine.end.x}" y2="${creaseLine.end.y}"
          stroke="${color}" stroke-width="${lineWidth}"
        />
        ${crossMarkerTemplate(edge1, markerRadius, color, lineWidth)}
        ${crossMarkerTemplate(edge2, markerRadius, color, lineWidth)}
        <circle cx="${source.x}" cy="${source.y}" r="${sourceRadius}" fill="${color}" stroke="white" stroke-width="${lineWidth}" />
        <polygon points="${targetPoints}" fill="${color}" stroke="white" stroke-width="${lineWidth}" />
        ${useCallouts ? "" : layersAnnotation}
        ${useCallouts ? `<!--plot-callout-${index}-->` : foldTypeAnnotation}
        ${insertMarkup}
      </g>
    `;
  }).join("");

  const rotationGroup = rotationOp && plotSelected !== "none"
    ? rotationOverlayTemplate(rotationOp.rotation, transform, baseSize)
    : "";

  return `
    <svg
      class="command-coordinate-overlay"
      viewBox="0 0 ${transform.width} ${transform.height}"
      preserveAspectRatio="xMidYMid meet"
      aria-label="Command markers"
    >${placeCallouts(groups, callouts, transform, annotationFontSize, lineWidth)}${rotationGroup}</svg>
  `;
}

// Approximate width of a bold label (full-width characters count as 1 em, others as 0.6 em).
function estimateTextWidth(text, fontSize) {
  return [...String(text)].reduce((width, ch) => width + (ch.charCodeAt(0) > 0xff ? 1 : 0.6), 0) * fontSize;
}

// Fold annotations in columns outside the paper (left and right), ordered by the
// height of their anchors so that leader lines rarely cross.
function placeCallouts(groupsMarkup, callouts, transform, fontSize, strokeWidth) {
  if (!callouts.length) return groupsMarkup;
  const scale = transform.scaleX || transform.scaleY || 1;
  const widest = Math.max(...callouts.map((callout) => estimateTextWidth(callout.text, fontSize)));
  const margin = 12;
  const columnX = {
    right: Math.min(transform.originX + scale * 1.12, transform.width - widest - margin),
    left: Math.max(transform.originX - scale * 1.12, widest + margin),
  };
  const gap = fontSize * 1.35;
  const placed = new Map();
  for (const side of ["left", "right"]) {
    const items = callouts
      .filter((callout) => (callout.anchor.x >= transform.originX ? "right" : "left") === side)
      .sort((a, b) => a.anchor.y - b.anchor.y);
    let previous = -Infinity;
    const ys = items.map((callout) => (previous = Math.max(callout.anchor.y, previous + gap)));
    // Shift the column up if it overflows at the bottom, and down if at the top.
    const overflow = ys.length ? ys[ys.length - 1] - (transform.height - fontSize) : 0;
    const shift = overflow > 0 ? -overflow : 0;
    const top = ys.length ? ys[0] + shift : 0;
    const fix = top < fontSize ? fontSize - top : 0;
    items.forEach((callout, i) => placed.set(callout.index, { side, y: ys[i] + shift + fix }));
  }
  return callouts.reduce((markup, callout) => {
    const { side, y } = placed.get(callout.index);
    const dir = side === "right" ? 1 : -1;
    const x = columnX[side];
    const startAngle = Math.atan2(y - callout.anchor.y, x - callout.anchor.x);
    const start = {
      x: callout.anchor.x + Math.cos(startAngle) * callout.radius,
      y: callout.anchor.y + Math.sin(startAngle) * callout.radius,
    };
    const elbow = { x: x - dir * fontSize * 0.6, y };
    const pathD = `M${start.x},${start.y} L${elbow.x},${elbow.y} L${x},${y}`;
    const label = `
      <path d="${pathD}" fill="none" stroke="white" stroke-width="${strokeWidth * 1.4}" stroke-linecap="round" stroke-linejoin="round" />
      <path d="${pathD}" fill="none" stroke="${callout.color}" stroke-width="${strokeWidth * 0.6}" stroke-linecap="round" stroke-linejoin="round" />
      <text
        x="${x + dir * fontSize * 0.3}" y="${y + fontSize * 0.35}"
        text-anchor="${dir < 0 ? "end" : "start"}" font-size="${fontSize}" font-weight="700"
        fill="${callout.color}" stroke="white" stroke-width="${strokeWidth * 0.9}" paint-order="stroke"
      >${escapeHtml(callout.text)}</text>
    `;
    return markup.replace(`<!--plot-callout-${callout.index}-->`, label);
  }, groupsMarkup);
}

// Fold type and angle, shown on each crease.
export function foldTypeAndThetaText(foldInfo) {
  const foldTypeLabel = foldInfo.foldType === "valley" ? "Valley" : foldInfo.foldType === "mountain" ? "Mountain" : "";
  const thetaLabel = Number.isFinite(foldInfo.theta) ? `${Math.round(foldInfo.theta)}°` : "";
  return [foldTypeLabel, thetaLabel].filter(Boolean).join(" ");
}

export function formatSourceLayers(layers) {
  if (!Array.isArray(layers) || !layers.length) return "";
  if (layers.length === 1 && layers[0] === "all") return "All layers";
  return `${layers.length === 1 ? "Layer" : "Layers"} ${layers.join(", ")}`;
}

export function destinationAnnotationText(destinationLayer) {
  if (!Array.isArray(destinationLayer) || destinationLayer.length !== 2) return "";
  const [upper, lower] = destinationLayer;
  return `Between layers ${upper} and ${lower}`;
}

// A label placed next to a marker without a leader line.
// side: "below" (centered), "left" (right-aligned), "right" (left-aligned).
function plainAnnotationTemplate(x, y, text, color, fontSize, strokeWidth, side = "below") {
  const anchor = side === "left" ? "end" : side === "right" ? "start" : "middle";
  return `
    <text
      x="${x}" y="${y}"
      text-anchor="${anchor}" font-size="${fontSize}" font-weight="700"
      fill="${color}" stroke="white" stroke-width="${strokeWidth * 0.9}" paint-order="stroke"
    >${escapeHtml(text)}</text>
  `;
}

// A label led out from an anchor on the crease by a diagonal line and a short
// horizontal segment, so that it can be traced back to its crease.
// direction: 1 = right, -1 = left. vDir: 1 = down, -1 = up.
// row: index among labels on the same side; each row is shifted outward.
function leaderAnnotationTemplate(anchorX, anchorY, anchorRadius, text, color, fontSize, strokeWidth, direction = 1, row = 0, vDir = 1) {
  const dir = direction < 0 ? -1 : 1;
  const vd = vDir < 0 ? -1 : 1;
  const diagonal = fontSize * 1.4;
  const horizontal = fontSize * 0.9;
  const rowDrop = row * fontSize * 1.9;
  const rowOut = row * fontSize * 0.6;
  const start = {
    x: anchorX + dir * anchorRadius * 0.7,
    y: anchorY + vd * (anchorRadius * 0.7 + rowDrop),
  };
  const elbow = {
    x: start.x + dir * (diagonal * 0.7 + rowOut),
    y: start.y + vd * diagonal * 0.7,
  };
  const end = { x: elbow.x + dir * horizontal, y: elbow.y };
  const pathD = `M${start.x},${start.y} L${elbow.x},${elbow.y} L${end.x},${end.y}`;
  return `
    <path
      d="${pathD}" fill="none" stroke="white" stroke-width="${strokeWidth * 1.4}"
      stroke-linecap="round" stroke-linejoin="round"
    />
    <path
      d="${pathD}" fill="none" stroke="${color}" stroke-width="${strokeWidth * 0.6}"
      stroke-linecap="round" stroke-linejoin="round"
    />
    <text
      x="${end.x + dir * fontSize * 0.3}" y="${end.y + fontSize * 0.35}"
      text-anchor="${dir < 0 ? "end" : "start"}" font-size="${fontSize}" font-weight="700"
      fill="${color}" stroke="white" stroke-width="${strokeWidth * 0.9}" paint-order="stroke"
    >${escapeHtml(text)}</text>
  `;
}

// rotate_3d: elliptical arrows fixed at the top right of the image. theta_x and
// theta_y rotate out of the image plane, which an arrow cannot show exactly; the
// tall / wide ellipses suggest the axis and the label gives the value. theta_z is
// shown as is (positive = counterclockwise).
function rotationOverlayTemplate(rotation, transform, baseSize) {
  const axes = [
    { key: "thetaX", label: "X", value: rotation.thetaX, shape: "tall" },
    { key: "thetaY", label: "Y", value: rotation.thetaY, shape: "wide" },
    { key: "thetaZ", label: "Z", value: rotation.thetaZ, shape: "circle" },
  ].filter((axis) => Number.isFinite(axis.value) && Math.abs(axis.value) > 0.5);
  if (!axes.length) return "";

  const color = "#22303c";
  const strokeWidth = Math.max(4, baseSize * 0.006);
  const iconRadius = Math.max(36, baseSize * 0.07);
  const gap = iconRadius * 2.6;
  const padding = iconRadius * 1.5;
  const cx = transform.width - padding - iconRadius;
  const startY = padding + iconRadius;

  const icons = axes
    .map((axis, index) => {
      const cy = startY + index * gap;
      const rx = axis.shape === "tall" ? iconRadius * 0.55 : iconRadius;
      const ry = axis.shape === "wide" ? iconRadius * 0.55 : iconRadius;
      const arrow = rotationArrowTemplate(cx, cy, rx, ry, axis.value > 0, color, strokeWidth);
      const rounded = Math.round(axis.value);
      const labelText = `${axis.label} ${rounded > 0 ? "+" : ""}${rounded}°`;
      const fontSize = Math.max(20, baseSize * 0.03);
      return `
        <g class="rotation-axis-plot">
          <circle cx="${cx}" cy="${cy}" r="${iconRadius * 1.4}" fill="white" fill-opacity="0.6" />
          ${arrow}
          <text
            x="${cx}" y="${cy + iconRadius * 1.4 + fontSize * 1.1}"
            text-anchor="middle" font-size="${fontSize}" font-weight="700"
            fill="${color}" stroke="white" stroke-width="${strokeWidth * 1.6}" paint-order="stroke"
          >${labelText}</text>
        </g>
      `;
    })
    .join("");

  return `<g class="rotation-plot">${icons}</g>`;
}

function rotationArrowTemplate(cx, cy, rx, ry, isPositive, color, strokeWidth) {
  const startDeg = 20;
  const sweepDeg = isPositive ? 300 : -300;
  const steps = 28;
  const points = [];
  for (let i = 0; i <= steps; i += 1) {
    const deg = startDeg + (sweepDeg * i) / steps;
    const rad = (deg * Math.PI) / 180;
    points.push({ x: cx + rx * Math.cos(rad), y: cy - ry * Math.sin(rad) });
  }
  const pathD = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");

  const last = points[points.length - 1];
  const prev = points[points.length - 2];
  const dx = last.x - prev.x;
  const dy = last.y - prev.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const px = -uy;
  const py = ux;
  const arrowSize = strokeWidth * 3.4;
  const tip = { x: last.x + ux * arrowSize * 0.6, y: last.y + uy * arrowSize * 0.6 };
  const base1 = {
    x: last.x - ux * arrowSize * 0.5 + px * arrowSize * 0.5,
    y: last.y - uy * arrowSize * 0.5 + py * arrowSize * 0.5,
  };
  const base2 = {
    x: last.x - ux * arrowSize * 0.5 - px * arrowSize * 0.5,
    y: last.y - uy * arrowSize * 0.5 - py * arrowSize * 0.5,
  };
  const arrowPoints = `${tip.x},${tip.y} ${base1.x},${base1.y} ${base2.x},${base2.y}`;

  return `
    <path d="${pathD}" fill="none" stroke="white" stroke-width="${strokeWidth * 2.2}" stroke-linecap="round" />
    <path d="${pathD}" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" />
    <polygon points="${arrowPoints}" fill="${color}" stroke="white" stroke-width="${strokeWidth * 0.6}" stroke-linejoin="round" />
  `;
}

function crossMarkerTemplate(point, size, color, strokeWidth) {
  const outlineWidth = strokeWidth * 2.4;
  return `
    <line x1="${point.x - size}" y1="${point.y - size}" x2="${point.x + size}" y2="${point.y + size}" stroke="white" stroke-width="${outlineWidth}" stroke-linecap="round" />
    <line x1="${point.x - size}" y1="${point.y + size}" x2="${point.x + size}" y2="${point.y - size}" stroke="white" stroke-width="${outlineWidth}" stroke-linecap="round" />
    <line x1="${point.x - size}" y1="${point.y - size}" x2="${point.x + size}" y2="${point.y + size}" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" />
    <line x1="${point.x - size}" y1="${point.y + size}" x2="${point.x + size}" y2="${point.y - size}" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" />
  `;
}
