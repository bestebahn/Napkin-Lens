# Napkin Lens

Because sometimes the best ideas start from a napkin. Extract a lens prescription from a cross-section diagram -> Get it into your simulation.

---

## The idea

Optical design usually starts in one of a few ways: you search patents, you pull from a design database, or you define your requirements and let a tool generate a starting point.

But sometimes the starting point is a diagram. A figure from a paper, a sketch from a meeting, something that exists visually but not yet numerically. Getting from that image to a working optical design has always meant doing it by hand.

Napkin Lens automates that step using computer vision. Upload the diagram, calibrate the scale, and it extracts radii of curvature, thicknesses, and air gaps into a format you can use.

---

## What it does

**Five-step workflow:**

1. **Upload** a lens cross-section diagram (patent figure, paper, hand sketch | preferably without rays)
2. **Calibrate** — mark a known dimension on the image to set the scale
3. **Detect** — OpenCV finds the lens elements and their contours
4. **Review** — per-surface table in OpticStudio Lens Data Editor format (R1, R2, thickness, air gap)
5. **Export** — download as CSV, with Optiland and ZMX export coming

**Under the hood:**
- Flask backend, OpenCV detection pipeline
- Contour isolation handles outline-only drawings where the optical axis splits elements into top/bottom pairs
- `isolate_surface_points()` cleanly separates R1/R2 surfaces from flat rim edges
- Air gaps auto-calculated from bounding box positions
- Light/dark mode, because you'll probably be using this late at night

---

## Is this production-ready optical design software?

No. It's a starting point generator. The extracted prescription is a reasonable first approximation — it gets you into the ballpark but is not a substitute for careful measurement or a validated design database.

Think of it as the digital version of taking a photo of that napkin sketch before the meeting ends.

---

## Getting started

**Requirements:**
- Python 3.9+
- Flask
- OpenCV (`opencv-python`)

**Install:**

```bash
git clone https://github.com/yourusername/napkin-lens.git
cd napkin-lens
pip install -r requirements.txt
python app.py
```

Then open `http://localhost:5001` in your browser.

> **macOS note:** Port 5000 is claimed by AirPlay Receiver by default. Napkin Lens runs on 5001 to avoid the conflict.

---

## Project structure

```
napkin-lens/
├── app.py                  # Flask routes, export endpoints
├── core/
│   └── detect.py           # OpenCV detection pipeline
├── static/
│   ├── js/app.js           # Canvas tools, table rendering, export logic
│   └── css/style.css       # UI styles, light/dark theme
└── templates/
    └── index.html          # Single-page app layout
```

---

## What's coming

- Optiland Python script export
- ZMX / OpticStudio export

---

## Feedback

If you're an optical engineer and this is useful, useless, or almost-useful-but-not-quite — I'd genuinely like to know. Open an issue or reach out directly: efcarbajal1@gmail.com. 

---

## License

MIT
