#!/usr/bin/env python3
"""Generate display images with the normalized coordinate frame used by the judging UI.

The simulator commands use a coordinate system centered on the paper:
the origin is the area centroid of the paper region, the y axis points upward,
and one unit is the largest distance from the centroid to the paper boundary
along x or y, so the paper fits in [-1, 1] x [-1, 1].

For each image this script finds that frame, draws the [-1, 1] square onto a
copy of the image, and records the frame in ``coordinate_manifest.json``. The
judging UI uses the manifest to place the markers of a predicted command on the
display image. The images sent to the model are always the original,
unmodified images.

The frames used in the experiments were visually verified and are listed in
``tools/frame_registry.json`` (keyed by the SHA-256 of the original image file).
Images found there use the verified frame; other images are detected by color.

Usage:
    python tools/normalize_coordinates.py <data_dir> [--works 001_Long-Horned_Samurai_Helmet ...]

Input layout (the Dataverse release layout):
    <data_dir>/images/<work>/<work>__NN.jpg
Output:
    <data_dir>/display/<work>/<work>__NN.jpg
    <data_dir>/display/<work>/coordinate_manifest.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from multiprocessing import Pool
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageOps
from scipy import ndimage

IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}
DEFAULT_REGISTRY = Path(__file__).with_name("frame_registry.json")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("data_dir", type=Path, help="dataset root that contains images/")
    parser.add_argument("--works", nargs="*", help="work folder names to process (default: all)")
    parser.add_argument("--max-dimension", type=int, default=1600)
    parser.add_argument("--jpeg-quality", type=int, default=88)
    parser.add_argument("--h-min", type=float, default=4.0, help="lower HSV hue bound (0..180 scale)")
    parser.add_argument("--h-max", type=float, default=100.0, help="upper HSV hue bound (0..180 scale)")
    parser.add_argument("--s-min", type=int, default=100, help="lower HSV saturation bound (0..255)")
    parser.add_argument("--v-min", type=int, default=25, help="lower HSV value bound (0..255)")
    parser.add_argument("--axes", action="store_true", help="also draw the x and y axes")
    parser.add_argument(
        "--frame-registry",
        type=Path,
        default=DEFAULT_REGISTRY,
        help="verified frames to use instead of detection (default: tools/frame_registry.json)",
    )
    parser.add_argument("--no-registry", action="store_true", help="always detect the paper by color")
    parser.add_argument("--overwrite", action="store_true", help="regenerate existing outputs")
    parser.add_argument("--workers", type=int, default=os.cpu_count() or 1)
    return parser.parse_args()


# ---------------------------------------------------------------------------
# Paper detection
# ---------------------------------------------------------------------------


def _group_nearby_large_components(
    labels: np.ndarray,
    count: int,
    gap_bridge_px: int = 60,
    seed_fraction: float = 0.01,
    downsample: int = 8,
) -> np.ndarray:
    """Merge large components that are close to each other into one label.

    Dot stickers and printed guide lines fall outside the paper color range and
    can split one paper surface into several components. Only large components
    seed the grouping, so small noise is not chained together.
    """
    if count == 0:
        return labels

    raw_sizes = np.bincount(labels.ravel(), minlength=count + 1)
    raw_sizes[0] = 0
    seed_threshold = max(int(labels.size * seed_fraction), 2000)
    seed_labels = np.flatnonzero(raw_sizes >= seed_threshold)
    if seed_labels.size <= 1:
        return labels

    seed_mask = np.isin(labels, seed_labels)
    small_seed_mask = seed_mask[::downsample, ::downsample]
    small_radius = max(1, gap_bridge_px // downsample)
    small_dilated = ndimage.binary_dilation(small_seed_mask, iterations=small_radius)
    small_groups, _ = ndimage.label(small_dilated, structure=np.ones((3, 3), dtype=np.uint8))

    group_labels = np.kron(small_groups, np.ones((downsample, downsample), dtype=small_groups.dtype))
    group_labels = group_labels[: labels.shape[0], : labels.shape[1]]
    if group_labels.shape != labels.shape:
        padded = np.zeros(labels.shape, dtype=group_labels.dtype)
        padded[: group_labels.shape[0], : group_labels.shape[1]] = group_labels
        group_labels = padded

    label_to_group = np.zeros(count + 1, dtype=np.int64)
    next_solo_id = int(group_labels.max()) + 1
    for label_id, component_slice in enumerate(ndimage.find_objects(labels, max_label=count), start=1):
        if component_slice is None:
            continue
        sub_labels = labels[component_slice]
        sub_group = group_labels[component_slice]
        pixel_positions = np.nonzero(sub_labels == label_id)
        group_id = int(sub_group[pixel_positions[0][0], pixel_positions[1][0]])
        if group_id == 0:
            group_id = next_solo_id
            next_solo_id += 1
        label_to_group[label_id] = group_id

    return label_to_group[labels]


def _foreground_mask(image: Image.Image, h_min: float, h_max: float, s_min: int, v_min: int, prune: bool) -> np.ndarray:
    """Select the significant orange-to-green components and fill their interior."""
    hsv = np.asarray(image.convert("HSV"))
    # Convert Pillow's 0..255 hue to the common 0..180 scale.
    hue = hsv[..., 0].astype(np.float32) * (180.0 / 255.0)
    saturation = hsv[..., 1]
    value = hsv[..., 2]

    color_candidates = (hue >= h_min) & (hue <= h_max) & (saturation >= s_min)

    # Keep only hues that are well represented on the bright paper surface;
    # shadows shift the hue in dark regions.
    hue_bins = np.floor(hue).astype(np.int16)
    bright_pixels = color_candidates & (value >= max(v_min, 120))
    hue_histogram = np.bincount(hue_bins[bright_pixels], minlength=181)
    local_hue_support = np.convolve(hue_histogram, np.ones(5, dtype=np.int64), mode="same")
    support_threshold = max(500, int(hue.size * 0.002))
    supported_hues = ndimage.binary_dilation(local_hue_support >= support_threshold, iterations=3)
    if supported_hues.any():
        color_candidates &= supported_hues[hue_bins]

    candidates = color_candidates & (value >= v_min)
    # Cut thin color bands that span almost the whole image width (cutting mat at the edge).
    candidates[candidates.mean(axis=1) >= 0.9, :] = False
    labels, count = ndimage.label(candidates, structure=np.ones((3, 3), dtype=np.uint8))
    if count == 0:
        raise ValueError("no foreground candidates; adjust the HSV thresholds")

    labels = _group_nearby_large_components(labels, count)
    component_sizes = np.bincount(labels.ravel())
    component_sizes[0] = 0

    # Drop thin strips along the image border (the edge of the shooting table).
    image_height, image_width = candidates.shape
    for label_id, component_slice in enumerate(ndimage.find_objects(labels), start=1):
        if component_slice is None:
            continue
        y_slice, x_slice = component_slice
        component_height = y_slice.stop - y_slice.start
        component_width = x_slice.stop - x_slice.start
        horizontal_edge_strip = (
            component_height < image_height * 0.05
            and component_width > image_width * 0.35
            and (y_slice.start < image_height * 0.05 or y_slice.stop > image_height * 0.95)
        )
        vertical_edge_strip = (
            component_width < image_width * 0.05
            and component_height > image_height * 0.35
            and (x_slice.start < image_width * 0.05 or x_slice.stop > image_width * 0.95)
        )
        if horizontal_edge_strip or vertical_edge_strip:
            component_sizes[label_id] = 0

    # Do not mistake a green cutting mat at the image border for the paper.
    border_pixels = np.concatenate((labels[0, :], labels[-1, :], labels[1:-1, 0], labels[1:-1, -1]))
    border_counts = np.bincount(border_pixels, minlength=component_sizes.size)
    border_threshold = max(20, int(border_pixels.size * 0.01))
    border_labels = np.flatnonzero(border_counts > border_threshold)
    non_border_sizes = component_sizes.copy()
    non_border_sizes[border_labels] = 0
    meaningful_component_size = max(int(component_sizes.max() * 0.02), int(hue.size * 0.001))
    if non_border_sizes.max() >= meaningful_component_size:
        component_sizes = non_border_sizes
    else:
        # The paper itself reaches the border: keep only the largest component.
        largest_label = int(component_sizes.argmax())
        largest_size = component_sizes[largest_label]
        component_sizes[:] = 0
        component_sizes[largest_label] = largest_size

    component_threshold = max(int(component_sizes.max() * 0.02), int(hue.size * 0.001))
    mask = np.isin(labels, np.flatnonzero(component_sizes >= component_threshold))

    # Close thin printed lines, then fill holes so stickers count as paper area.
    closing_structure = ndimage.iterate_structure(ndimage.generate_binary_structure(2, 1), 7)
    mask = ndimage.binary_closing(mask, structure=closing_structure)
    mask = ndimage.binary_fill_holes(mask)
    return _prune_weak_attachments(mask) if prune else mask


def _prune_weak_attachments(mask: np.ndarray, radius: int = 50) -> np.ndarray:
    """Morphological opening that cuts thin attachments (e.g. to a wooden table)."""
    if not mask.any():
        return mask
    eroded = ndimage.binary_erosion(mask, iterations=radius, border_value=0)
    if not eroded.any():
        return mask
    return ndimage.binary_dilation(eroded, iterations=radius)


def _mask_with_tips(image: Image.Image, h_min: float, h_max: float, s_min: int, v_min: int) -> np.ndarray:
    """Pruned mask, with thin paper tips that the pruning removed restored.

    A removed region is restored when its hue lies in the paper's hue range,
    it is at least 65% as bright as the paper, it is connected to the paper,
    and it does not touch the 3% border band.
    """
    raw = _foreground_mask(image, h_min, h_max, s_min, v_min, prune=False)
    pruned = _prune_weak_attachments(raw)
    if not pruned.any():
        return raw
    hsv = np.asarray(image.convert("HSV")).astype(np.float32)
    hue = hsv[..., 0] * (180.0 / 255.0)
    value = hsv[..., 2]
    lo, hi = np.percentile(hue[pruned], [5, 95])
    v_paper = float(np.median(value[pruned]))
    tips = raw & ~pruned & (hue >= lo - 5) & (hue <= hi + 5) & (value >= v_paper * 0.65)
    band = max(4, int(min(raw.shape) * 0.03))
    border = np.zeros_like(raw)
    border[:band, :] = border[-band:, :] = True
    border[:, :band] = border[:, -band:] = True
    labels, _ = ndimage.label(tips, structure=np.ones((3, 3), dtype=np.uint8))
    touching = np.unique(labels[border & tips])
    tips &= ~np.isin(labels, touching[touching > 0])
    merged = pruned | tips
    labels, _ = ndimage.label(merged, structure=np.ones((3, 3), dtype=np.uint8))
    keep = np.unique(labels[pruned])
    return np.isin(labels, keep[keep > 0])


def _looks_like_border_misdetection(mask: np.ndarray) -> bool:
    if not mask.any():
        return False
    h, w = mask.shape
    m = max(4, int(min(h, w) * 0.02))
    labels, count = ndimage.label(mask, structure=np.ones((3, 3), dtype=np.uint8))
    if count > 1:
        sizes = np.bincount(labels.ravel())
        largest = int(sizes[1:].argmax()) + 1
        for label_id, sl in enumerate(ndimage.find_objects(labels), start=1):
            if label_id == largest or sl is None:
                continue
            ys, xs = sl
            hh, ww = ys.stop - ys.start, xs.stop - xs.start
            near = ys.start < m * 2 or xs.start < m * 2 or ys.stop > h - m * 2 or xs.stop > w - m * 2
            if near and max(hh, ww) / max(1, min(hh, ww)) >= 5:
                return True
    band = np.zeros_like(mask)
    band[:m, :] = band[-m:, :] = True
    band[:, :m] = band[:, -m:] = True
    if mask[band].mean() > 0.05:
        return True
    cx, cy, scale = coordinate_frame(mask)
    overflow = max(0.0, scale - cx, scale - cy, cx + scale - w, cy + scale - h) / min(w, h)
    return overflow > 0.30


def paper_mask(image: Image.Image, h_min: float, h_max: float, s_min: int, v_min: int) -> np.ndarray:
    """Detect the paper region.

    If the detection looks like it picked up a mat or table at the image border,
    the 3% border band is painted white and detection is retried; the retry is
    used only when it shrinks the frame by at least 10%.
    """
    mask = _mask_with_tips(image, h_min, h_max, s_min, v_min)
    if _looks_like_border_misdetection(mask):
        arr = np.asarray(image.convert("RGB")).copy()
        band = int(min(image.size) * 0.03)
        arr[:band, :] = arr[-band:, :] = 255
        arr[:, :band] = arr[:, -band:] = 255
        retry = _mask_with_tips(Image.fromarray(arr), h_min, h_max, s_min, v_min)
        if retry.any() and coordinate_frame(retry)[2] < coordinate_frame(mask)[2] * 0.9:
            mask = retry
    return mask


def coordinate_frame(mask: np.ndarray) -> tuple[float, float, float]:
    """Return the area centroid (cx, cy) and the half side length of the square, in pixels."""
    ys, xs = np.nonzero(mask)
    if xs.size == 0:
        raise ValueError("empty foreground mask")
    cx = float(xs.mean())
    cy = float(ys.mean())
    scale = float(max(np.abs(xs - cx).max(), np.abs(ys - cy).max()))
    if scale == 0:
        raise ValueError("foreground has no extent")
    return cx, cy, scale


# ---------------------------------------------------------------------------
# Drawing
# ---------------------------------------------------------------------------


def _load_font(size: int) -> ImageFont.ImageFont:
    for path in (
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ):
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            pass
    return ImageFont.load_default()


def draw_frame(
    image: Image.Image, cx: float, cy: float, scale: float, draw_axes: bool
) -> tuple[Image.Image, float, float]:
    """Draw the [-1, 1] square, the origin and the corner labels.

    When a corner label would fall outside the image, the canvas is extended
    instead of moving the label. Returns (image, cx, cy) in the extended canvas.
    """
    line_width = max(1, round(scale * 0.0075))
    left, top, right, bottom = cx - scale, cy - scale, cx + scale, cy + scale

    font = _load_font(max(16, round(scale * 0.06)))
    padding = max(3, round(scale * 0.008))
    label_gap = max(2, line_width)
    measure = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    corners = (
        ((left, top), "(-1, 1)", "top-left"),
        ((right, top), "(1, 1)", "top-right"),
        ((right, bottom), "(1, -1)", "bottom-right"),
        ((left, bottom), "(-1, -1)", "bottom-left"),
    )
    boxes = []
    for (x, y), text, position in corners:
        box = measure.textbbox((0, 0), text, font=font)
        text_w, text_h = box[2] - box[0], box[3] - box[1]
        tx = x + padding if position.endswith("left") else x - padding - text_w
        ty = y - label_gap - padding - text_h if position.startswith("top") else y + label_gap + padding
        boxes.append((text, tx, ty, tx - padding, ty - padding, tx + text_w + padding, ty + text_h + padding))

    img_w, img_h = image.size
    pad_left = max(0, round(-min(0, *(b[3] for b in boxes))))
    pad_top = max(0, round(-min(0, *(b[4] for b in boxes))))
    pad_right = max(0, round(max(0, *(b[5] - img_w for b in boxes))))
    pad_bottom = max(0, round(max(0, *(b[6] - img_h for b in boxes))))

    canvas = Image.new("RGBA", (img_w + pad_left + pad_right, img_h + pad_top + pad_bottom), (255, 255, 255, 255))
    canvas.paste(image.convert("RGBA"), (pad_left, pad_top))
    overlay = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    cx, cy = cx + pad_left, cy + pad_top
    left, top, right, bottom = left + pad_left, top + pad_top, right + pad_left, bottom + pad_top

    draw.rectangle((left, top, right, bottom), outline=(0, 0, 0, 210), width=line_width)
    if draw_axes:
        axis_width = max(1, round(line_width * 0.7))
        draw.line((left, cy, right, cy), fill=(0, 0, 0, 165), width=axis_width)
        draw.line((cx, top, cx, bottom), fill=(0, 0, 0, 165), width=axis_width)

    radius = max(4, round(scale * 0.012))
    draw.ellipse(
        (cx - radius, cy - radius, cx + radius, cy + radius),
        fill=(0, 0, 0, 230),
        outline=(0, 0, 0, 255),
        width=max(1, round(line_width * 0.5)),
    )
    for text, tx, ty, box_left, box_top, box_right, box_bottom in boxes:
        draw.rounded_rectangle(
            (box_left + pad_left, box_top + pad_top, box_right + pad_left, box_bottom + pad_top),
            radius=max(2, padding // 2),
            fill=(255, 255, 255, 175),
        )
        draw.text((tx + pad_left, ty + pad_top), text, font=font, fill=(20, 20, 20, 220))

    return Image.alpha_composite(canvas, overlay).convert("RGB"), cx, cy


# ---------------------------------------------------------------------------
# Batch processing
# ---------------------------------------------------------------------------


def process_image(job: dict) -> dict:
    input_path: Path = job["input_path"]
    output_path: Path = job["output_path"]
    record = {"image": input_path.name}
    try:
        raw = Image.open(input_path)
        orientation = raw.getexif().get(0x0112, 1)
        # Apply EXIF orientation so the frame matches what browsers display.
        image = ImageOps.exif_transpose(raw).convert("RGB")
        # Registered frames are in pixels of the unrotated image, so they are
        # used only when no EXIF rotation applies.
        registered = job["registered_frame"] if orientation in (None, 1) else None
        if registered:
            cx, cy, scale = registered["cx"], registered["cy"], registered["scale"]
            record["frame_source"] = "registry"
        else:
            mask = paper_mask(image, job["h_min"], job["h_max"], job["s_min"], job["v_min"])
            cx, cy, scale = coordinate_frame(mask)
            record["frame_source"] = "detected"
        result, cx, cy = draw_frame(image, cx, cy, scale, draw_axes=job["axes"])
    except ValueError as error:
        print(f"  failed: {input_path.name}: {error}", flush=True)
        return {**record, "status": "failed", "error": str(error)}

    canvas_size = result.size
    if max(result.size) > job["max_dimension"]:
        result.thumbnail((job["max_dimension"], job["max_dimension"]), Image.Resampling.LANCZOS)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    options = {"quality": job["jpeg_quality"], "optimize": True, "subsampling": 0}
    result.save(output_path, **(options if output_path.suffix.lower() in {".jpg", ".jpeg"} else {}))
    print(f"  {input_path.name}", flush=True)
    return {
        **record,
        "status": "generated",
        # Frame in the drawing canvas (before resizing) ...
        "canvas_size": {"width": canvas_size[0], "height": canvas_size[1]},
        "centroid_px": {"x": cx, "y": cy},
        "scale_px_per_normalized_unit": scale,
        # ... and the size of the saved display image.
        "output_size": {"width": result.width, "height": result.height},
    }


def main() -> None:
    args = parse_args()
    images_root = args.data_dir / "images"
    if not images_root.is_dir():
        raise SystemExit(f"not found: {images_root}")
    works = sorted(p for p in images_root.iterdir() if p.is_dir())
    registry = {}
    if not args.no_registry and args.frame_registry.is_file():
        registry = json.loads(args.frame_registry.read_text(encoding="utf-8")).get("frames", {})
    if args.works:
        wanted = set(args.works)
        works = [p for p in works if p.name in wanted]

    for work in works:
        out_dir = args.data_dir / "display" / work.name
        manifest_path = out_dir / "coordinate_manifest.json"
        if manifest_path.is_file() and not args.overwrite:
            print(f"{work.name}: exists (use --overwrite to regenerate)")
            continue
        print(work.name)
        jobs = [
            {
                "input_path": path,
                "output_path": out_dir / path.name,
                "max_dimension": args.max_dimension,
                "jpeg_quality": args.jpeg_quality,
                "h_min": args.h_min,
                "h_max": args.h_max,
                "s_min": args.s_min,
                "v_min": args.v_min,
                "axes": args.axes,
                "registered_frame": registry.get(hashlib.sha256(path.read_bytes()).hexdigest()),
            }
            for path in sorted(work.iterdir())
            if path.is_file() and path.suffix.lower() in IMAGE_SUFFIXES
        ]
        workers = max(1, min(args.workers, len(jobs)))
        if workers > 1:
            with Pool(workers) as pool:
                records = pool.map(process_image, jobs)
        else:
            records = [process_image(job) for job in jobs]
        out_dir.mkdir(parents=True, exist_ok=True)
        manifest_path.write_text(json.dumps({"images": records}, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
