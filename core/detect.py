"""
core/detect.py
==============
All lens detection and geometry extraction logic.
No Flask, no UI — pure image processing functions.

This module is the heart of Napkin Lens. It can be used independently
of the web app, e.g. for batch processing or testing.
"""

import cv2
import numpy as np
import base64
import math


# ── Image style detection ─────────────────────────────────────────────────────

def detect_image_style(img_bgr, gray):
    """
    Analyse the image to determine:
      - bg_dark:   True if background is dark (lenses are light shapes)
      - is_filled: True if lens elements are solid filled shapes
                   False if they are open line drawings

    Returns: (bg_dark, is_filled, debug_info)
    debug_info is a dict of intermediate values useful for the UI.
    """
    h, w = gray.shape

    # Sample corners to determine background brightness
    corners = [
        gray[0, 0], gray[0, w-1], gray[h-1, 0], gray[h-1, w-1],
        gray[0, w//2], gray[h-1, w//2],
    ]
    bg_brightness = float(np.mean(corners))
    bg_dark = bg_brightness < 128

    # Mean saturation — high = coloured fills (marketing diagrams)
    hsv = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2HSV)
    sat_mean = float(np.mean(hsv[:, :, 1]))

    # Check for filled closed contours above a minimum size
    if bg_dark:
        _, thresh = cv2.threshold(gray, 40, 255, cv2.THRESH_BINARY)
    else:
        _, thresh = cv2.threshold(gray, 200, 255, cv2.THRESH_BINARY_INV)

    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    img_area = h * w
    filled = [c for c in contours if img_area * 0.003 < cv2.contourArea(c) < img_area * 0.5]
    is_filled = len(filled) >= 1

    debug_info = {
        "bg_brightness": round(bg_brightness, 1),
        "bg_dark":       bg_dark,
        "sat_mean":      round(sat_mean, 1),
        "is_coloured":   sat_mean > 30,
        "is_filled":     is_filled,
        "style_label":   ("Dark bg" if bg_dark else "Light bg") + " / " +
                         ("Filled" if is_filled else "Line drawing"),
    }

    return bg_dark, is_filled, debug_info


# ── Contour finding ───────────────────────────────────────────────────────────

def find_contours_filled(gray, bg_dark):
    """
    Mode 1: Find contours of filled lens shapes.
    Returns (contours, hierarchy, thresh_image)
    thresh_image is returned so the UI can show it as a debug view.
    """
    blurred = cv2.GaussianBlur(gray, (3, 3), 0)

    if bg_dark:
        _, thresh = cv2.threshold(blurred, 40, 255, cv2.THRESH_BINARY)
    else:
        thresh = cv2.adaptiveThreshold(
            blurred, 255,
            cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv2.THRESH_BINARY_INV, 15, 3
        )

    contours, hierarchy = cv2.findContours(thresh, cv2.RETR_TREE, cv2.CHAIN_APPROX_NONE)
    return contours, hierarchy, thresh


def find_contours_line(gray, bg_dark):
    """
    Mode 2: Find contours from open line drawings using Canny edges.
    Returns (contours, hierarchy, edge_image)
    """
    blurred = cv2.GaussianBlur(gray, (3, 3), 0)
    edges = cv2.Canny(blurred, 20, 80)
    contours, hierarchy = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    return contours, hierarchy, edges


# ── Lens candidate filtering ──────────────────────────────────────────────────

def bbox_overlap_fraction(inner, outer):
    """
    Returns what fraction of `inner`'s bounding box is contained within
    `outer`'s bounding box. Used to detect duplicate nested contours.

    When adaptive thresholding finds both the outer and inner edge of the
    same lens shape, one bounding box will be almost entirely inside the
    other. If overlap > 0.85 we treat them as the same element and keep
    only the larger (outer) one.
    """
    ix, iy, iw, ih = inner
    ox, oy, ow, oh = outer

    # Intersection
    x_overlap = max(0, min(ix+iw, ox+ow) - max(ix, ox))
    y_overlap = max(0, min(iy+ih, oy+oh) - max(iy, oy))
    intersection = x_overlap * y_overlap
    inner_area = iw * ih
    return intersection / inner_area if inner_area > 0 else 0


def deduplicate_contours(candidates):
    """
    Remove spurious contours in two passes:

    Pass 1 — WRAPPERS: Drop any contour whose bounding box contains
    2 or more other candidates. This catches the outer rectangle that
    sometimes appears around a whole lens group.

    Pass 2 — DUPLICATES: Among the survivors, drop any contour that is
    >85% contained inside a larger survivor. This catches the inner/outer
    edge pair that adaptive thresholding produces for a single lens.

    Everything else is a real lens element — keep it.
    """
    if not candidates:
        return candidates

    bboxes = [cv2.boundingRect(c) for c in candidates]

    # Pass 1: remove wrappers
    def count_contained_in(i, bbox_list):
        return sum(1 for j, b in enumerate(bbox_list)
                   if i != j and bbox_overlap_fraction(b, bbox_list[i]) > 0.85)

    survivors = [(cnt, bbox) for i, (cnt, bbox) in enumerate(zip(candidates, bboxes))
                 if count_contained_in(i, bboxes) < 2]

    if not survivors:
        # Fallback: if everything was flagged as wrapper just return all candidates
        survivors = list(zip(candidates, bboxes))

    # Pass 2: remove duplicates among survivors only
    surv_cnts   = [c for c, _ in survivors]
    surv_bboxes = [b for _, b in survivors]
    kept = []

    for i, (cnt, bbox) in enumerate(survivors):
        area_i = cv2.contourArea(cnt)
        is_dup = any(
            bbox_overlap_fraction(bbox, surv_bboxes[j]) > 0.85
            and cv2.contourArea(surv_cnts[j]) > area_i
            for j in range(len(survivors)) if j != i
        )
        if not is_dup:
            kept.append(cnt)

    # Sort left to right — optical axis order
    kept.sort(key=lambda c: cv2.boundingRect(c)[0])
    return kept


def filter_lens_candidates(contours, img_shape):
    """
    From all contours, keep only those that look like lens elements,
    then deduplicate nested contours from the same physical element.

    Criteria:
      - Area between 0.2% and 98% of image (generous — dedup handles the rest)
      - Aspect ratio (h/w) > 1.2  — lenses are taller than wide
      - Solidity > 0.35           — reasonably convex shape

    Returns candidates sorted left-to-right (optical axis order).
    """
    h_img, w_img = img_shape[:2]
    img_area     = h_img * w_img
    candidates   = []
    n_too_small  = 0
    n_aspect     = 0
    n_solidity   = 0

    for cnt in contours:
        area = cv2.contourArea(cnt)

        if area < img_area * 0.002:
            n_too_small += 1
            continue

        x, y, cw, ch = cv2.boundingRect(cnt)
        aspect = ch / cw if cw > 0 else 0
        if aspect < 1.2:
            n_aspect += 1
            continue

        hull_area = cv2.contourArea(cv2.convexHull(cnt))
        solidity  = area / hull_area if hull_area > 0 else 0
        if solidity < 0.35:
            n_solidity += 1
            continue

        candidates.append(cnt)

    # Remove nested duplicates (inner/outer edge of same lens)
    candidates = deduplicate_contours(candidates)

    debug = {
        "rejected_too_small": n_too_small,
        "rejected_aspect":    n_aspect,
        "rejected_solidity":  n_solidity,
        "accepted":           len(candidates),
    }

    return candidates, debug


# ── Main detection entry point ────────────────────────────────────────────────

def run_detection(image_path, roi=None):
    """
    Full detection pipeline for one image.

    roi: optional dict {x, y, w, h} in original image pixels.
         If provided, detection runs only on that region.
         Returned element coordinates are translated back to full-image space.

    Returns a dict ready to be sent as JSON to the frontend.
    """
    img_bgr = cv2.imread(image_path)
    if img_bgr is None:
        return {"error": f"Could not read image: {image_path}"}

    full_h, full_w = img_bgr.shape[:2]

    # Apply ROI crop if provided
    roi_offset_x = 0
    roi_offset_y = 0
    if roi:
        rx  = max(0, int(roi["x"]))
        ry  = max(0, int(roi["y"]))
        rw  = min(int(roi["w"]), full_w - rx)
        rh  = min(int(roi["h"]), full_h - ry)
        if rw > 10 and rh > 10:
            img_bgr      = img_bgr[ry:ry+rh, rx:rx+rw]
            roi_offset_x = rx
            roi_offset_y = ry

    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)

    # 1. Detect image style
    bg_dark, is_filled, style_info = detect_image_style(img_bgr, gray)

    # 2. Find contours
    if is_filled:
        contours, hierarchy, thresh_img = find_contours_filled(gray, bg_dark)
    else:
        contours, hierarchy, thresh_img = find_contours_line(gray, bg_dark)

    # 3. Filter to lens candidates
    candidates, filter_debug = filter_lens_candidates(contours, gray.shape)

    # 4. Build element list — translate coords back to full-image space
    elements = []
    colours = [
        "#ff3232", "#32c832", "#3264ff", "#ffc800",
        "#ff00c8", "#00c8c8", "#ff8c00", "#b400ff",
    ]

    for i, cnt in enumerate(candidates):
        x, y, cw, ch = cv2.boundingRect(cnt)

        # Offset back to full-image coordinates
        x_full = x + roi_offset_x
        y_full = y + roi_offset_y

        pts = cnt[:, 0, :].tolist()
        # Adaptive subsampling — keep at least 80 points for reliable circle fitting
        step = max(1, len(pts) // 80)
        pts_simplified = [[p[0] + roi_offset_x, p[1] + roi_offset_y]
                          for p in pts[::step]]

        elements.append({
            "id":     i + 1,
            "color":  colours[i % len(colours)],
            "bbox":   {"x": int(x_full), "y": int(y_full),
                       "w": int(cw),     "h": int(ch)},
            "points": pts_simplified,
            "cx":     int(x_full + cw // 2),
            "cy":     int(y_full + ch // 2),
        })

    # 5. Encode threshold image as base64 PNG for the debug view
    thresh_rgb = cv2.cvtColor(thresh_img, cv2.COLOR_GRAY2BGR)
    _, buf = cv2.imencode(".png", thresh_rgb)
    thresh_b64 = "data:image/png;base64," + base64.b64encode(buf).decode("utf-8")

    return {
        "style":      style_info,
        "elements":   elements,
        "debug":      filter_debug,
        "thresh_b64": thresh_b64,
        "orig_w":     int(gray.shape[1]),
        "orig_h":     int(gray.shape[0]),
    }


# ── Geometry extraction ───────────────────────────────────────────────────────

def trim_arc(points, frac=0.15):
    """Remove top and bottom fraction of arc points to exclude bevel edges."""
    if len(points) < 4:
        return points
    y_min, y_max = points[:, 1].min(), points[:, 1].max()
    y_low  = y_min + frac * (y_max - y_min)
    y_high = y_max - frac * (y_max - y_min)
    trimmed = points[(points[:, 1] > y_low) & (points[:, 1] < y_high)]
    return trimmed if len(trimmed) >= 4 else points


def isolate_surface_points(pts, side, n_slices=None, trim_frac=0.15):
    """
    Isolate points belonging to a single curved surface (R1 or R2) from a
    closed element contour.

    Strategy: divide the contour height into horizontal slices. For each slice,
    take only the extreme x point (min for left surface, max for right surface).
    This naturally excludes the flat rim edges at top/bottom and the opposite
    surface points, leaving a clean arc for circle fitting.

    side: "left" → R1 surface (minimum x per slice)
          "right" → R2 surface (maximum x per slice)
    trim_frac: fraction of height to ignore at top and bottom (rim bevel)
    """
    if len(pts) < 8:
        return pts

    y_min = pts[:, 1].min()
    y_max = pts[:, 1].max()
    height = y_max - y_min
    if height < 1:
        return pts

    # Trim top and bottom to avoid rim edge contamination
    y_lo = y_min + trim_frac * height
    y_hi = y_max - trim_frac * height
    inner = pts[(pts[:, 1] >= y_lo) & (pts[:, 1] <= y_hi)]
    if len(inner) < 4:
        inner = pts

    # Adaptive slice count — roughly one slice per 3 points, min 10 max 60
    if n_slices is None:
        n_slices = max(10, min(60, len(inner) // 3))

    # Slice vertically and pick extreme x per slice
    slice_h  = (inner[:, 1].max() - inner[:, 1].min()) / n_slices
    if slice_h <= 0:
        return inner

    surface_pts = []
    for k in range(n_slices):
        y_start = inner[:, 1].min() + k * slice_h
        y_end   = y_start + slice_h
        band    = inner[(inner[:, 1] >= y_start) & (inner[:, 1] < y_end)]
        if len(band) == 0:
            continue
        if side == "left":
            idx = int(np.argmin(band[:, 0]))
        else:
            idx = int(np.argmax(band[:, 0]))
        surface_pts.append(band[idx])

    if len(surface_pts) < 4:
        return inner
    return np.array(surface_pts, dtype=np.float32)


def circle_fit(points):
    """
    Least-squares circle fit through a set of 2D points.
    Returns (cx, cy, R) in pixel units.
    Falls back to a bounding-box estimate if the fit is degenerate.
    """
    if len(points) < 4:
        return (int(np.mean(points[:, 0])), int(np.mean(points[:, 1])),
                float(np.std(points[:, 0]) + np.std(points[:, 1])))
    try:
        x = points[:, 0].astype(np.float64)
        y = points[:, 1].astype(np.float64)
        A = np.column_stack([2*x, 2*y, np.ones_like(x)])
        b = x**2 + y**2
        cx, cy, c = np.linalg.lstsq(A, b, rcond=None)[0]
        R = math.sqrt(cx**2 + cy**2 + c)
        if math.isnan(R) or R <= 0 or R > 1e6:
            raise ValueError("Degenerate")
        return (int(cx), int(cy), float(R))
    except Exception:
        x_range = float(points[:, 0].max() - points[:, 0].min())
        return (int(np.mean(points[:, 0])), int(np.mean(points[:, 1])), x_range)


def apply_sign_convention(cx, surf_x, R_mm, is_left):
    """Standard optics sign convention (left surface: +R if centre is right of vertex)."""
    if is_left:
        return  R_mm if cx > surf_x else -R_mm
    else:
        return -R_mm if cx < surf_x else  R_mm


def extract_geometry(contour_points, mm_per_px):
    """
    Extract R1, R2, thickness, diameter from a single lens element contour.

    Uses isolate_surface_points() to cleanly separate the left (R1) and right
    (R2) curved surfaces from the full closed contour before circle fitting.
    This handles both filled diagrams and open line drawings correctly.

    contour_points: list of [x, y] pairs (the full contour from run_detection)
    mm_per_px:      scale factor from calibration

    Returns a dict of measurements, or None if extraction fails.
    """
    pts = np.array(contour_points, dtype=np.float32)
    if len(pts) < 8:
        return None

    # Isolate each surface by picking extreme-x point per horizontal slice
    left_arc  = isolate_surface_points(pts, side="left")
    right_arc = isolate_surface_points(pts, side="right")

    if len(left_arc) < 4 or len(right_arc) < 4:
        return None

    cx1, cy1, R1_px = circle_fit(left_arc)
    cx2, cy2, R2_px = circle_fit(right_arc)

    # Thickness at vertical midpoint — use overlap region of both arcs
    y_low  = int(max(left_arc[:, 1].min(),  right_arc[:, 1].min()))
    y_high = int(min(left_arc[:, 1].max(), right_arc[:, 1].max()))
    if y_high <= y_low:
        y_low, y_high = int(pts[:, 1].min()), int(pts[:, 1].max())
    y_mid = (y_low + y_high) // 2

    def surface_x_at_y(cx, cy, R, arc_pts, y):
        dy     = y - cy
        inside = R**2 - dy**2
        if inside < 0:
            idx = int(np.argmin(np.abs(arc_pts[:, 1] - y)))
            return float(arc_pts[idx, 0])
        dx    = math.sqrt(inside)
        x_med = float(np.median(arc_pts[:, 0]))
        x1, x2 = cx - dx, cx + dx
        return x1 if abs(x1 - x_med) <= abs(x2 - x_med) else x2

    x_left  = surface_x_at_y(cx1, cy1, R1_px, left_arc,  y_mid)
    x_right = surface_x_at_y(cx2, cy2, R2_px, right_arc, y_mid)

    thickness_px = abs(x_right - x_left)
    diameter_px  = float(pts[:, 1].max() - pts[:, 1].min())

    R1_mm        = apply_sign_convention(cx1, x_left,  R1_px * mm_per_px, is_left=True)
    R2_mm        = apply_sign_convention(cx2, x_right, R2_px * mm_per_px, is_left=False)
    thickness_mm = thickness_px * mm_per_px
    diameter_mm  = diameter_px  * mm_per_px

    return {
        "R1_mm":        round(R1_mm, 3),
        "R2_mm":        round(R2_mm, 3),
        "thickness_mm": round(thickness_mm, 3),
        "diameter_mm":  round(diameter_mm, 3),
        "material":     "N-BK7",
    }