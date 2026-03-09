"""
Napkin Lens — app.py
====================
Flask server. Steps 1-3 (upload, calibration, detection).

Run:
    source .venv/bin/activate
    python app.py

Then open http://localhost:5000 in your browser.
"""

import io
import os
import csv
import math
import uuid
from flask import Flask, render_template, request, jsonify, url_for, Response
from werkzeug.utils import secure_filename
from PIL import Image
from core.detect import run_detection, extract_geometry

app = Flask(__name__)

# -- Config -------------------------------------------------------------------
UPLOAD_FOLDER      = os.path.join("static", "uploads")
ALLOWED_EXTENSIONS = {"png", "jpg", "jpeg", "bmp", "tiff", "tif", "webp"}
MAX_DISPLAY_DIM    = 900

app.config["UPLOAD_FOLDER"]      = UPLOAD_FOLDER
app.config["MAX_CONTENT_LENGTH"] = 32 * 1024 * 1024

os.makedirs(UPLOAD_FOLDER, exist_ok=True)


def allowed_file(filename):
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


def make_display_size(orig_w, orig_h, max_dim=MAX_DISPLAY_DIM):
    scale = min(max_dim / orig_w, max_dim / orig_h, 1.0)
    return int(orig_w * scale), int(orig_h * scale), scale


# -- Routes -------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/upload", methods=["POST"])
def upload():
    if "image" not in request.files:
        return jsonify({"error": "No file provided"}), 400
    file = request.files["image"]
    if not file or not allowed_file(file.filename):
        return jsonify({"error": "Unsupported file type"}), 400
    ext      = file.filename.rsplit(".", 1)[1].lower()
    filename = f"{uuid.uuid4().hex}.{ext}"
    filepath = os.path.join(app.config["UPLOAD_FOLDER"], filename)
    file.save(filepath)
    with Image.open(filepath) as img:
        orig_w, orig_h = img.size
    display_w, display_h, display_scale = make_display_size(orig_w, orig_h)
    return jsonify({
        "filename":      filename,
        "image_url":     url_for("static", filename=f"uploads/{filename}"),
        "orig_w":        orig_w,
        "orig_h":        orig_h,
        "display_w":     display_w,
        "display_h":     display_h,
        "display_scale": display_scale,
    })


@app.route("/calibrate", methods=["POST"])
def calibrate():
    data = request.get_json()
    try:
        x1            = float(data["x1"])
        y1            = float(data["y1"])
        x2            = float(data["x2"])
        y2            = float(data["y2"])
        known_mm      = float(data["known_mm"])
        display_scale = float(data["display_scale"])
    except (KeyError, TypeError, ValueError) as e:
        return jsonify({"error": f"Invalid parameters: {e}"}), 400
    if known_mm <= 0:
        return jsonify({"error": "Distance must be greater than 0"}), 400
    ox1, oy1 = x1 / display_scale, y1 / display_scale
    ox2, oy2 = x2 / display_scale, y2 / display_scale
    px_dist = math.hypot(ox2 - ox1, oy2 - oy1)
    if px_dist < 5:
        return jsonify({"error": "Points are too close together"}), 400
    px_per_mm = px_dist / known_mm
    mm_per_px = known_mm / px_dist
    return jsonify({
        "px_dist":    round(px_dist, 2),
        "px_per_mm":  round(px_per_mm, 4),
        "mm_per_px":  round(mm_per_px, 6),
        "known_mm":   known_mm,
    })


@app.route("/detect", methods=["POST"])
def detect():
    data     = request.get_json()
    filename = data.get("filename")
    if not filename:
        return jsonify({"error": "No filename provided"}), 400
    filepath = os.path.join(app.config["UPLOAD_FOLDER"], filename)
    if not os.path.exists(filepath):
        return jsonify({"error": "File not found — please re-upload"}), 404
    roi = data.get("roi")  # optional {x, y, w, h} in original image pixels
    result = run_detection(filepath, roi=roi)
    if "error" in result:
        return jsonify(result), 500
    return jsonify(result)


@app.route("/measure", methods=["POST"])
def measure():
    data = request.get_json()
    try:
        elements  = data["elements"]
        mm_per_px = float(data["mm_per_px"])
    except (KeyError, TypeError, ValueError) as e:
        return jsonify({"error": f"Invalid parameters: {e}"}), 400

    # Sort elements left to right by bbox x
    elements_sorted = sorted(elements, key=lambda e: e.get("bbox", {}).get("x", 0))

    surfaces = []
    surf_num = 1

    for i, el in enumerate(elements_sorted):
        el_id         = el["id"]
        color         = el.get("color", "#4a9eff")
        is_split      = el.get("_split", False)
        bbox          = el.get("bbox")
        rect_fallback = el.get("_rectFallback", False)
        is_last       = (i == len(elements_sorted) - 1)

        # Extract geometry for this element
        if is_split and rect_fallback and bbox:
            w_px = float(bbox["w"])
            h_px = float(bbox["h"])
            geom = {
                "R1_mm":        None,
                "R2_mm":        None,
                "thickness_mm": round(w_px * mm_per_px, 3),
                "diameter_mm":  round(h_px * mm_per_px, 3),
                "material":     "N-BK7",
            }
            error = None
        else:
            geom  = extract_geometry(el["points"], mm_per_px)
            error = None if geom else "Could not extract geometry"
            if not geom:
                geom = {
                    "R1_mm": None, "R2_mm": None,
                    "thickness_mm": None, "diameter_mm": None,
                    "material": "N-BK7",
                }

        # Compute air gap from right edge of this element to left edge of next
        air_gap_mm = 0.0
        if bbox and not is_last:
            next_bbox = elements_sorted[i + 1].get("bbox")
            if next_bbox:
                gap_px     = float(next_bbox["x"]) - (float(bbox["x"]) + float(bbox["w"]))
                air_gap_mm = round(max(0.0, gap_px) * mm_per_px, 3)

        diameter = geom.get("diameter_mm")

        # Surface 1 of this element: R1, thickness=element thickness, glass=material
        surf1 = {
            "surface":       surf_num,
            "element_id":    el_id,
            "element_color": color,
            "surface_role":  "R1",
            "R_mm":          geom["R1_mm"],
            "thickness_mm":  geom["thickness_mm"],
            "diameter_mm":   diameter,
            "glass":         geom.get("material", "N-BK7"),
            "_split":        is_split,
        }
        if error:
            surf1["error"] = error
        surfaces.append(surf1)
        surf_num += 1

        # Surface 2 of this element: R2, thickness=air gap, glass=AIR
        # Last element: thickness=0 (image space, user can edit)
        surf2 = {
            "surface":          surf_num,
            "element_id":       el_id,
            "element_color":    color,
            "surface_role":     "R2",
            "R_mm":             geom["R2_mm"],
            "thickness_mm":     air_gap_mm if not is_last else 0.0,
            "diameter_mm":      diameter,
            "glass":            "AIR",
            "_split":           is_split,
            "_is_last_surface": is_last,
        }
        if error:
            surf2["error"] = error
        surfaces.append(surf2)
        surf_num += 1

    return jsonify({"measurements": surfaces})


# -- Export ------------------------------------------------------------------

@app.route("/export/csv", methods=["POST"])
def export_csv():
    data = request.get_json()
    try:
        surfaces  = data["surfaces"]
        filename  = data.get("filename", "prescription")
    except (KeyError, TypeError) as e:
        return jsonify({"error": f"Invalid parameters: {e}"}), 400

    # Build CSV in memory
    output = io.StringIO()
    writer = csv.writer(output)

    # Header row
    writer.writerow([
        "Surface", "Element", "Role",
        "R (mm)", "Thickness (mm)", "Diameter (mm)", "Glass"
    ])

    for s in surfaces:
        writer.writerow([
            s.get("surface", ""),
            s.get("element_id", ""),
            s.get("surface_role", ""),
            s.get("R_mm",         ""),
            s.get("thickness_mm", ""),
            s.get("diameter_mm",  ""),
            s.get("glass",        ""),
        ])

    # Build a clean download filename from the uploaded image name
    base = os.path.splitext(filename)[0] if filename else "prescription"
    csv_name = f"{base}_prescription.csv"

    output.seek(0)
    return Response(
        output.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition": f"attachment; filename={csv_name}"}
    )


# -- Run ----------------------------------------------------------------------

if __name__ == "__main__":
    app.run(debug=True, port=5000)