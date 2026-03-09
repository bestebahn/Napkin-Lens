/**
 * Napkin Lens — app.js
 * ====================
 * Handles all frontend interactivity for Steps 1 and 2.
 *
 * State is kept in a single `state` object so it's easy to pass
 * data between steps (e.g. the filename from Step 1 is needed
 * when we run detection in Step 3).
 */

// ── App state ──────────────────────────────────────────────────────────────
const state = {
  // Step 1
  filename:      null,
  imageUrl:      null,
  origW:         null,
  origH:         null,
  displayW:      null,
  displayH:      null,
  displayScale:  null,   // orig_pixels = display_pixels / displayScale

  // Step 2
  points:        [],     // [{x, y}, {x, y}] in display (canvas) coords
  pxDist:        null,
  pxPerMm:       null,
  mmPerPx:       null,
  knownMm:       null,

  // Step 3+ (populated in future sessions)
  elements:      [],
};

// ── Wizard navigation ─────────────────────────────────────────────────────
const NUM_STEPS = 5;

function goTo(n) {
  // Clear all error messages when navigating
  document.querySelectorAll(".error-msg").forEach(el => el.textContent = "");

  for (let i = 1; i <= NUM_STEPS; i++) {
    const pane = document.getElementById(`pane-${i}`);
    const step = document.getElementById(`s${i}`);
    const num  = step.querySelector(".step-num");

    pane.classList.remove("active");
    step.classList.remove("active", "done");

    if (i < n) {
      step.classList.add("done");
      num.textContent = "✓";
    } else if (i === n) {
      step.classList.add("active");
      num.textContent = i;
    } else {
      num.textContent = i;
    }
  }

  document.getElementById(`pane-${n}`).classList.add("active");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ── Step 1: Upload ────────────────────────────────────────────────────────

const uploadZone  = document.getElementById("upload-zone");
const fileInput   = document.getElementById("file-input");
const btnToScale  = document.getElementById("btn-to-scale");
const uploadError = document.getElementById("upload-error");

// Open file picker when zone is clicked (excluding the hidden input itself)
uploadZone.addEventListener("click", (e) => {
  if (e.target !== fileInput) fileInput.click();
});

// Drag and drop support
uploadZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  uploadZone.classList.add("drag-over");
});
uploadZone.addEventListener("dragleave", () => uploadZone.classList.remove("drag-over"));
uploadZone.addEventListener("drop", (e) => {
  e.preventDefault();
  uploadZone.classList.remove("drag-over");
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});

fileInput.addEventListener("change", () => {
  if (fileInput.files[0]) handleFile(fileInput.files[0]);
});

async function handleFile(file) {
  uploadError.textContent = "";
  uploadZone.classList.remove("has-file");
  btnToScale.disabled = true;

  // Client-side validation before hitting the server
  const allowed = ["image/png","image/jpeg","image/bmp","image/tiff","image/webp"];
  if (!allowed.includes(file.type)) {
    uploadError.textContent = `Unsupported file type: ${file.type}`;
    return;
  }
  if (file.size > 32 * 1024 * 1024) {
    uploadError.textContent = "File too large — maximum 32 MB";
    return;
  }

  // Show uploading state
  uploadZone.querySelector(".upload-title").textContent = "Uploading…";

  const formData = new FormData();
  formData.append("image", file);

  try {
    const res  = await fetch("/upload", { method: "POST", body: formData });
    const data = await res.json();

    if (!res.ok || data.error) {
      uploadError.textContent = data.error || "Upload failed";
      uploadZone.querySelector(".upload-title").textContent = "Drop image here or click to browse";
      return;
    }

    // Save to state
    state.filename     = data.filename;
    state.imageUrl     = data.image_url;
    state.origW        = data.orig_w;
    state.origH        = data.orig_h;
    state.displayW     = data.display_w;
    state.displayH     = data.display_h;
    state.displayScale = data.display_scale;

    // Update UI
    uploadZone.classList.add("has-file");
    uploadZone.querySelector(".upload-title").textContent = `✓ ${file.name}`;
    uploadZone.querySelector(".upload-sub").textContent =
      `${data.orig_w} × ${data.orig_h} px`;
    btnToScale.disabled = false;

  } catch (err) {
    uploadError.textContent = "Network error — is the server running?";
    uploadZone.querySelector(".upload-title").textContent = "Drop image here or click to browse";
  }
}

btnToScale.addEventListener("click", () => {
  loadImageOnCanvas();
  goTo(2);
});

// ── Step 2: Scale calibration ─────────────────────────────────────────────

const canvas       = document.getElementById("scale-canvas");
const ctx          = canvas.getContext("2d");
const canvasHint   = document.getElementById("canvas-hint");
const pointsCount  = document.getElementById("points-count");
const pxDistance   = document.getElementById("px-distance");
const knownMmInput = document.getElementById("known-mm");
const scaleResult  = document.getElementById("scale-result");
const scaleResultBox = document.getElementById("scale-result-box");
const scalePill    = document.getElementById("scale-status-pill");
const scaleError   = document.getElementById("scale-error");
const btnToDetect  = document.getElementById("btn-to-detect");
const btnReset     = document.getElementById("btn-reset-points");
const btnBack      = document.getElementById("btn-back-to-upload");

let canvasImage = null;  // HTMLImageElement drawn on canvas

function loadImageOnCanvas() {
  // Reset step 2 state whenever we (re)enter this step
  state.points  = [];
  state.pxDist  = null;
  state.pxPerMm = null;
  state.mmPerPx = null;

  canvasImage = new Image();
  canvasImage.onload = () => {
    // Size the canvas to the display dimensions from the server
    canvas.width  = state.displayW;
    canvas.height = state.displayH;
    redrawCanvas();
    updateScaleUI();
  };
  canvasImage.src = state.imageUrl;
}

function redrawCanvas() {
  if (!canvasImage) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(canvasImage, 0, 0, canvas.width, canvas.height);

  // Draw connecting line between points
  if (state.points.length === 2) {
    const [p1, p2] = state.points;
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.strokeStyle = "rgba(255,255,255,0.5)";
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Draw point markers
  const colours = ["#4a9eff", "#f59e0b"];
  state.points.forEach((p, i) => {
    // Outer ring
    ctx.beginPath();
    ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
    ctx.fillStyle = colours[i];
    ctx.fill();
    // White border
    ctx.beginPath();
    ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
    ctx.strokeStyle = "white";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // Number label
    ctx.fillStyle = "white";
    ctx.font = "bold 10px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(i + 1, p.x, p.y);
  });
}

// Get accurate canvas click position accounting for CSS scaling
function getCanvasPos(e) {
  const rect   = canvas.getBoundingClientRect();
  const scaleX = canvas.width  / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: (e.clientX - rect.left) * scaleX,
    y: (e.clientY - rect.top)  * scaleY,
  };
}

canvas.addEventListener("click", (e) => {
  if (state.points.length >= 2) return;  // already have both points

  const pos = getCanvasPos(e);
  state.points.push(pos);
  redrawCanvas();
  updateScaleUI();

  // If we now have 2 points, try to compute scale immediately
  // (in case the user already filled in the distance field)
  if (state.points.length === 2) {
    updatePixelDistance();
    tryCalibrate();
  }
});

knownMmInput.addEventListener("input", () => {
  // Clear error while typing — but don't calibrate yet
  scaleError.textContent = "";
  knownMmInput.classList.remove("invalid");
});

knownMmInput.addEventListener("change", () => {
  // Calibrate only when user commits the value (tab, enter, or click away)
  if (state.points.length === 2) tryCalibrate();
});

btnReset.addEventListener("click", () => {
  state.points  = [];
  state.pxDist  = null;
  state.pxPerMm = null;
  state.mmPerPx = null;
  redrawCanvas();
  updateScaleUI();
});

btnBack.addEventListener("click", () => goTo(1));

function updatePixelDistance() {
  if (state.points.length < 2) return;
  const [p1, p2] = state.points;
  // Distance in display pixels — server converts to original px
  const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  // Show approximate display-pixel distance; server gives us the accurate original value
  pxDistance.textContent = `${dist.toFixed(1)} px (display)`;
}

function updateScaleUI() {
  const n = state.points.length;
  pointsCount.textContent = `${n} / 2`;
  btnReset.style.display  = n > 0 ? "inline-flex" : "none";

  if (n === 0) {
    canvasHint.textContent = "Click Point 1";
    canvasHint.classList.remove("hidden");
  } else if (n === 1) {
    canvasHint.textContent = "Click Point 2";
  } else {
    canvasHint.classList.add("hidden");
  }

  if (n < 2) {
    scalePill.className  = "pill pill-pending";
    scalePill.textContent = "Waiting for points";
    btnToDetect.disabled  = true;
    scaleResultBox.style.display = "none";
  }
}

async function tryCalibrate() {
  const mm = parseFloat(knownMmInput.value);
  if (!mm || mm <= 0 || state.points.length < 2) return;

  scaleError.textContent = "";
  scalePill.className    = "pill pill-pending";
  scalePill.textContent  = "Calculating…";

  const [p1, p2] = state.points;
  const payload = {
    x1: p1.x, y1: p1.y,
    x2: p2.x, y2: p2.y,
    known_mm:      mm,
    display_scale: state.displayScale,
  };

  try {
    const res  = await fetch("/calibrate", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(payload),
    });
    const data = await res.json();

    if (!res.ok || data.error) {
      scaleError.textContent = data.error || "Calibration failed";
      scalePill.className    = "pill pill-warn";
      scalePill.textContent  = "Error";
      btnToDetect.disabled   = true;
      return;
    }

    // Save to state
    state.pxDist  = data.px_dist;
    state.pxPerMm = data.px_per_mm;
    state.mmPerPx = data.mm_per_px;
    state.knownMm = data.known_mm;

    // Update UI
    pxDistance.textContent       = `${data.px_dist} px (original)`;
    scaleResult.textContent      = `${data.px_per_mm} px / mm`;
    scaleResultBox.style.display = "block";

    scalePill.className   = "pill pill-success";
    scalePill.textContent = "Scale calibrated";
    btnToDetect.disabled  = false;

    // Pass scale summary to step 3 placeholder
    document.getElementById("s3-scale-summary").textContent =
      `${data.px_per_mm} px/mm · ${data.known_mm} mm reference`;

  } catch (err) {
    // Only show this for genuine network failures, not server-side errors
    if (err instanceof TypeError) {
      scaleError.textContent = "Network error — is the server running?";
    }
  }
}

btnToDetect.addEventListener("click", () => goTo(3));

// ── Step 3: Detection ─────────────────────────────────────────────────────

const detectCanvas   = document.getElementById("detect-canvas");
const detectCtx      = detectCanvas.getContext("2d");
const threshImg      = document.getElementById("thresh-img");
const detectResults  = document.getElementById("detect-results");
const detectRunning  = document.getElementById("detect-running");
const detectError    = document.getElementById("detect-error");
const detectCountNum = document.getElementById("detect-count-num");
const elementChips   = document.getElementById("element-chips");
const styleLabel     = document.getElementById("style-label");
const overrideInput  = document.getElementById("override-count");
const overrideBtn    = document.getElementById("btn-apply-override");
const overrideError  = document.getElementById("override-error");
const detectPill     = document.getElementById("detect-pill");
const btnToMeasure   = document.getElementById("btn-to-measure");

let detectData       = null;   // full response from /detect
let confirmedElements = [];    // elements after any override applied
let detectionImage   = null;   // HTMLImageElement for canvas drawing

// Single goTo hook — handles all step transitions
const _baseGoTo = window.goTo;
window.goTo = function(n) {
  _baseGoTo(n);
  if (n === 3 && state.filename && !detectData) runDetection();
  if (n === 4) { renderMeasureTable(); drawMeasureCanvas(); }
};

async function runDetection() {
  detectError.textContent  = "";
  detectResults.style.display = "none";
  detectRunning.style.display = "block";
  btnToMeasure.disabled = true;

  try {
    const res  = await fetch("/detect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: state.filename }),
    });
    const data = await res.json();
    detectRunning.style.display = "none";

    if (!res.ok || data.error) {
      detectError.textContent = data.error || "Detection failed";
      return;
    }

    detectData = data;
    confirmedElements = [...data.elements];
    renderDetectionResults();

  } catch (err) {
    detectRunning.style.display = "none";
    detectError.textContent = "Network error — is the server running?";
  }
}

function renderDetectionResults() {
  const elements = confirmedElements;
  detectResults.style.display = "grid";

  detectCountNum.textContent = elements.length;

  // Build chips with a split button on each element
  elementChips.innerHTML = elements.map(el =>
    `<div class="element-chip" id="chip-${el.id}">
       <div class="chip-dot" style="background:${el.color}"></div>
       <span class="chip-label">Element ${el.id}</span>
       <div class="chip-split" id="split-${el.id}">
         <input  class="split-input" id="split-input-${el.id}"
                 type="number" min="2" max="6" placeholder="2"
                 title="Split into N elements">
         <button class="split-btn" onclick="splitElement(${el.id})"
                 title="Split this element">⌥ split</button>
       </div>
     </div>`
  ).join("");

  styleLabel.textContent = detectData.style.style_label;
  overrideBtn.style.display = "inline-flex";
  threshImg.src = detectData.thresh_b64;

  detectionImage = new Image();
  detectionImage.onload = () => {
    detectCanvas.width  = detectionImage.width;
    detectCanvas.height = detectionImage.height;
    drawDetectionOverlay();
  };
  detectionImage.src = state.imageUrl;

  detectPill.style.display = "inline-flex";
  btnToMeasure.disabled = false;

  // Reset zoom whenever detection results are (re)rendered
  resetZoom();
}

// ── Element split ─────────────────────────────────────────────────────────────

const COLOURS = [
  "#ff3232","#32c832","#3264ff","#ffc800",
  "#ff00c8","#00c8c8","#ff8c00","#b400ff",
  "#00ff80","#ff6464","#64b4ff","#ffb432",
];

function splitElement(elId) {
  const input = document.getElementById(`split-input-${elId}`);
  const n = parseInt(input.value);

  if (!n || n < 2 || n > 6) {
    input.classList.add("invalid");
    setTimeout(() => input.classList.remove("invalid"), 1200);
    return;
  }

  // Find the element to split
  const idx = confirmedElements.findIndex(e => e.id === elId);
  if (idx === -1) return;
  const el = confirmedElements[idx];

  const { x, y, w, h } = el.bbox;
  const sliceW = Math.floor(w / n);

  // Create N new sub-elements by dividing bbox evenly left-to-right.
  // For each slice, filter the original contour points to that x range so
  // circle fitting still works on the real curved edges.
  const origPoints = el.points;  // full contour from detection
  const newEls = [];

  for (let i = 0; i < n; i++) {
    const sx = x + i * sliceW;
    const sw = (i === n - 1) ? w - i * sliceW : sliceW;
    const scx = sx + Math.floor(sw / 2);
    const scy = y + Math.floor(h / 2);

    // Keep original contour points that fall within this slice's x range.
    // Add a small overlap (2px) so edge points aren't lost at slice boundaries.
    const overlap = 2;
    const slicePoints = origPoints.filter(p =>
      p[0] >= (sx - overlap) && p[0] <= (sx + sw + overlap)
    );

    // Fall back to rectangle corners only if no original points fall in range
    const drawPoints = slicePoints.length >= 8 ? slicePoints : [
      [sx,      y    ],
      [sx + sw, y    ],
      [sx + sw, y + h],
      [sx,      y + h],
    ];

    newEls.push({
      id:          0,           // renumbered below
      color:       COLOURS[(idx + i) % COLOURS.length],
      bbox:        { x: sx, y, w: sw, h },
      points:      drawPoints,  // real curved points for geometry extraction
      cx:          scx,
      cy:          scy,
      _split:      true,
      _rectFallback: slicePoints.length < 8,  // flag if we had to use rectangle
    });
  }

  // Replace the original element with the N new ones and renumber all
  confirmedElements.splice(idx, 1, ...newEls);
  confirmedElements.forEach((e, i) => { e.id = i + 1; });

  renderDetectionResults();
}

function drawDetectionOverlay() {
  if (!detectionImage) return;
  detectCtx.clearRect(0, 0, detectCanvas.width, detectCanvas.height);
  detectCtx.drawImage(detectionImage, 0, 0);

  confirmedElements.forEach(el => {
    const pts = el.points;
    if (!pts || pts.length < 2) return;

    // Split elements get a dashed border to distinguish them from auto-detected
    detectCtx.setLineDash(el._split ? [6, 3] : []);
    detectCtx.beginPath();
    detectCtx.moveTo(pts[0][0], pts[0][1]);
    pts.forEach(p => detectCtx.lineTo(p[0], p[1]));
    detectCtx.closePath();
    detectCtx.strokeStyle = el.color;
    detectCtx.lineWidth   = 2;
    detectCtx.stroke();
    detectCtx.setLineDash([]);

    // Numbered circle at element centre
    const { cx, cy } = el;
    detectCtx.beginPath();
    detectCtx.arc(cx, cy, 13, 0, Math.PI * 2);
    detectCtx.fillStyle = el.color;
    detectCtx.fill();
    detectCtx.strokeStyle = "white";
    detectCtx.lineWidth   = 1.5;
    detectCtx.stroke();

    detectCtx.fillStyle    = "white";
    detectCtx.font         = "bold 11px monospace";
    detectCtx.textAlign    = "center";
    detectCtx.textBaseline = "middle";
    detectCtx.fillText(el.id, cx, cy);
  });
}

// Toggle between overlay and threshold views
function showView(mode) {
  const overlayBtn = document.getElementById("btn-view-overlay");
  const threshBtn  = document.getElementById("btn-view-thresh");

  if (mode === "overlay") {
    detectCanvas.style.display = "block";
    threshImg.style.display    = "none";
    overlayBtn.classList.add("active");
    threshBtn.classList.remove("active");
  } else {
    detectCanvas.style.display = "none";
    threshImg.style.display    = "block";
    overlayBtn.classList.remove("active");
    threshBtn.classList.add("active");
  }
}

// Override element count — take the N largest by bounding box area
overrideInput.addEventListener("input", () => {
  overrideError.textContent = "";
  overrideBtn.style.display = overrideInput.value ? "inline-flex" : "none";
});

overrideBtn.addEventListener("click", () => {
  const n = parseInt(overrideInput.value);
  if (!n || n < 1 || n > 50) {
    overrideError.textContent = "Enter a number between 1 and 50";
    return;
  }
  if (!detectData || !detectData.elements.length) {
    overrideError.textContent = "No elements to filter";
    return;
  }

  // Sort by bounding box area descending, take top N, re-sort left to right
  const sorted = [...detectData.elements].sort(
    (a, b) => (b.bbox.w * b.bbox.h) - (a.bbox.w * a.bbox.h)
  );
  confirmedElements = sorted.slice(0, n)
    .sort((a, b) => a.bbox.x - b.bbox.x)
    .map((el, i) => ({ ...el, id: i + 1 }));

  overrideInput.value = "";
  overrideBtn.style.display = "none";
  renderDetectionResults();
});

// Extract measurements when moving to step 4
btnToMeasure.addEventListener("click", async () => {
  if (!confirmedElements.length || !state.mmPerPx) return;
  await runMeasure();
  goTo(4);
});

async function runMeasure() {
  try {
    const res  = await fetch("/measure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        elements:  confirmedElements,
        mm_per_px: state.mmPerPx,
      }),
    });
    const data = await res.json();
    if (data.measurements) {
      state.measurements = data.measurements;
    }
  } catch (err) {
    console.error("Measure error:", err);
  }
}

// ── Detection canvas zoom & pan ───────────────────────────────────────────────

const zoomState = {
  scale:   1.0,
  offsetX: 0,
  offsetY: 0,
  minScale: 0.25,
  maxScale: 8.0,
  dragging: false,
  lastX:    0,
  lastY:    0,
};

const btnZoomIn    = document.getElementById("btn-zoom-in");
const btnZoomOut   = document.getElementById("btn-zoom-out");
const btnZoomReset = document.getElementById("btn-zoom-reset");
const zoomLevel    = document.getElementById("zoom-level");

function updateZoomLabel() {
  zoomLevel.textContent = `${Math.round(zoomState.scale * 100)}%`;
}

function clampOffset() {
  // Prevent panning so far the image disappears off-screen
  if (!detectionImage) return;
  const cw = detectCanvas.width;
  const ch = detectCanvas.height;
  const scaledW = cw * zoomState.scale;
  const scaledH = ch * zoomState.scale;
  // Allow up to 80% of the image to go offscreen in any direction
  const marginX = scaledW * 0.8;
  const marginY = scaledH * 0.8;
  zoomState.offsetX = Math.max(-marginX, Math.min(marginX, zoomState.offsetX));
  zoomState.offsetY = Math.max(-marginY, Math.min(marginY, zoomState.offsetY));
}

function applyZoomTransform() {
  clampOffset();
  const s = zoomState.scale;
  const x = zoomState.offsetX;
  const y = zoomState.offsetY;
  detectCanvas.style.transform       = `translate(${x}px, ${y}px) scale(${s})`;
  detectCanvas.style.transformOrigin = "top left";
  updateZoomLabel();
}

function zoomBy(factor, cx, cy) {
  const prevScale = zoomState.scale;
  const newScale  = Math.max(zoomState.minScale,
                    Math.min(zoomState.maxScale, prevScale * factor));
  if (newScale === prevScale) return;

  // Zoom toward the cursor position (cx, cy) in canvas-wrap coordinates
  const scaleDelta = newScale - prevScale;
  zoomState.offsetX -= cx * scaleDelta;
  zoomState.offsetY -= cy * scaleDelta;
  zoomState.scale    = newScale;
  applyZoomTransform();
}

function resetZoom() {
  zoomState.scale   = 1.0;
  zoomState.offsetX = 0;
  zoomState.offsetY = 0;
  applyZoomTransform();
}

// Buttons
btnZoomIn.addEventListener("click",    () => zoomBy(1.4, detectCanvas.width / 2, detectCanvas.height / 2));
btnZoomOut.addEventListener("click",   () => zoomBy(1 / 1.4, detectCanvas.width / 2, detectCanvas.height / 2));
btnZoomReset.addEventListener("click", () => resetZoom());

// ── Unified mouse handler for canvas wrap (pan + ROI) ───────────────────────
// A single mousedown listener checks the current mode and routes accordingly.
// This avoids the add/remove listener race that caused both to fire at once.

const detectCanvasWrap = document.getElementById("detect-canvas-wrap");

// ROI state — declared here so pan handler can check it
const roiMode = { active: false };

detectCanvasWrap.addEventListener("wheel", (e) => {
  e.preventDefault();
  const rect   = detectCanvasWrap.getBoundingClientRect();
  const cx     = e.clientX - rect.left - zoomState.offsetX;
  const cy     = e.clientY - rect.top  - zoomState.offsetY;
  const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
  zoomBy(factor, cx, cy);
}, { passive: false });

// Single mousedown — routes to ROI draw or pan depending on mode
detectCanvasWrap.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  if (roiMode.active) {
    // ROI draw mode
    const pos = getCanvasCoords(e);
    roiState.drawing = true;
    roiState.startX  = pos.x;
    roiState.startY  = pos.y;
  } else {
    // Pan mode
    zoomState.dragging = true;
    zoomState.lastX    = e.clientX;
    zoomState.lastY    = e.clientY;
    detectCanvasWrap.style.cursor = "grabbing";
  }
});

window.addEventListener("mousemove", (e) => {
  if (roiState.drawing) {
    const pos = getCanvasCoords(e);
    drawDetectionOverlay();
    drawRoiRect(roiState.startX, roiState.startY, pos.x, pos.y);
  } else if (zoomState.dragging) {
    zoomState.offsetX += e.clientX - zoomState.lastX;
    zoomState.offsetY += e.clientY - zoomState.lastY;
    zoomState.lastX    = e.clientX;
    zoomState.lastY    = e.clientY;
    applyZoomTransform();
  }
});

window.addEventListener("mouseup", (e) => {
  if (roiState.drawing) {
    roiState.drawing = false;
    const pos = getCanvasCoords(e);
    const x   = Math.min(roiState.startX, pos.x);
    const y   = Math.min(roiState.startY, pos.y);
    const w   = Math.abs(pos.x - roiState.startX);
    const h   = Math.abs(pos.y - roiState.startY);

    if (w < 20 || h < 20) {
      drawDetectionOverlay();
      return;
    }

    // Convert display canvas pixels → original image pixels
    const s = state.displayScale;
    roiState.roi = {
      x: Math.round(x / s),
      y: Math.round(y / s),
      w: Math.round(w / s),
      h: Math.round(h / s),
    };

    // Exit ROI mode
    roiMode.active = false;
    btnRoiToggle.classList.remove("active");
    btnRoiToggle.style.display = "none";
    btnRoiClear.style.display  = "inline-flex";
    detectCanvasWrap.style.cursor = "grab";

    // Re-run detection on cropped region
    detectData = null;
    runDetectionWithRoi(roiState.roi);

  } else if (zoomState.dragging) {
    zoomState.dragging = false;
    detectCanvasWrap.style.cursor = "grab";
  }
});

// Touch pinch-zoom
let lastTouchDist = null;
detectCanvasWrap.addEventListener("touchstart", (e) => {
  if (e.touches.length === 2) {
    lastTouchDist = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
  }
}, { passive: true });

detectCanvasWrap.addEventListener("touchmove", (e) => {
  if (e.touches.length === 2 && lastTouchDist) {
    e.preventDefault();
    const dist   = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
    const factor = dist / lastTouchDist;
    const midX   = (e.touches[0].clientX + e.touches[1].clientX) / 2;
    const midY   = (e.touches[0].clientY + e.touches[1].clientY) / 2;
    const rect   = detectCanvasWrap.getBoundingClientRect();
    zoomBy(factor, midX - rect.left, midY - rect.top);
    lastTouchDist = dist;
  }
}, { passive: false });

detectCanvasWrap.addEventListener("touchend", () => { lastTouchDist = null; });


// ── ROI selection ────────────────────────────────────────────────────────────

const btnRoiToggle = document.getElementById("btn-roi-toggle");
const btnRoiClear  = document.getElementById("btn-roi-clear");

const roiState = {
  roi:     null,   // saved {x, y, w, h} in original image pixels
  drawing: false,
  startX:  0,
  startY:  0,
};

btnRoiToggle.addEventListener("click", () => {
  roiMode.active = !roiMode.active;
  btnRoiToggle.classList.toggle("active", roiMode.active);
  detectCanvasWrap.style.cursor = roiMode.active ? "crosshair" : "grab";
});

btnRoiClear.addEventListener("click", () => {
  roiState.roi = null;
  btnRoiClear.style.display  = "none";
  btnRoiToggle.style.display = "inline-flex";
  drawDetectionOverlay();
  detectData = null;
  runDetection();
});

// Convert screen coords to canvas image coords (accounts for zoom/pan)
function getCanvasCoords(e) {
  const rect = detectCanvasWrap.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left - zoomState.offsetX) / zoomState.scale,
    y: (e.clientY - rect.top  - zoomState.offsetY) / zoomState.scale,
  };
}

function drawRoiRect(x1, y1, x2, y2) {
  const x = Math.min(x1, x2);
  const y = Math.min(y1, y2);
  const w = Math.abs(x2 - x1);
  const h = Math.abs(y2 - y1);

  detectCtx.save();
  // Dim outside ROI
  detectCtx.fillStyle = "rgba(0,0,0,0.45)";
  detectCtx.fillRect(0, 0, detectCanvas.width, detectCanvas.height);
  // Show image inside ROI
  detectCtx.clearRect(x, y, w, h);
  detectCtx.drawImage(detectionImage, x, y, w, h, x, y, w, h);
  // Dashed blue border
  detectCtx.strokeStyle = "#4a9eff";
  detectCtx.lineWidth   = 2;
  detectCtx.setLineDash([6, 3]);
  detectCtx.strokeRect(x + 1, y + 1, w - 2, h - 2);
  detectCtx.setLineDash([]);
  // Corner handles
  const hs = 7;
  [[x,y],[x+w,y],[x,y+h],[x+w,y+h]].forEach(([hx,hy]) => {
    detectCtx.fillStyle = "#4a9eff";
    detectCtx.fillRect(hx - hs/2, hy - hs/2, hs, hs);
  });
  detectCtx.restore();
}

async function runDetectionWithRoi(roi) {
  detectError.textContent     = "";
  detectResults.style.display = "none";
  detectRunning.style.display = "block";
  btnToMeasure.disabled       = true;

  try {
    const res  = await fetch("/detect", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ filename: state.filename, roi }),
    });
    const data = await res.json();
    detectRunning.style.display = "none";

    if (!res.ok || data.error) {
      detectError.textContent = data.error || "Detection failed";
      return;
    }

    detectData        = data;
    confirmedElements = [...data.elements];
    renderDetectionResults();

  } catch (err) {
    detectRunning.style.display = "none";
    detectError.textContent = "Network error — is the server running?";
  }
}

// ── Step 4: Review & edit measurements ───────────────────────────────────────

const measureError   = document.getElementById("measure-error");
const measureTbody   = document.getElementById("measure-tbody");
const measureScaleNote = document.getElementById("measure-scale-note");
const btnToExport    = document.getElementById("btn-to-export");

// Common glass materials for the dropdown
const MATERIALS = [
  "N-BK7","N-F2","N-SF11","N-SF5","N-SF10","N-BAF10",
  "N-LAK22","N-SSK5","N-BAK1","N-K5","N-PK52A","N-FK5",
  "N-LASF9","N-LAF2","SCHOTT N-BK7","Fused Silica","CaF2","Custom",
];

function renderMeasureTable() {
  const meas = state.measurements;
  if (!meas || !meas.length) {
    measureError.textContent = "No measurements available — go back and re-run detection.";
    return;
  }

  measureError.textContent = "";
  measureScaleNote.textContent =
    `Scale: ${state.pxPerMm} px/mm · reference ${state.knownMm} mm`;

  // Build per-surface rows. Group surfaces by element_id for visual grouping.
  const GLASS_OPTIONS = [...MATERIALS, "AIR"];

  measureTbody.innerHTML = meas.map((s, i) => {
    const isAir    = s.glass === "AIR";
    const isLast   = s._is_last_surface;
    const errNote  = s.error
      ? `<span class="table-err" title="${s.error}">⚠</span>` : "";

    const dot = `<span class="table-dot" style="background:${s.element_color}"></span>`;

    const roleLabel = s.surface_role === "R1"
      ? `<span class="surf-role surf-r1">R1</span>`
      : `<span class="surf-role surf-r2">R2</span>`;

    const elLabel = s.surface_role === "R1"
      ? `${s._split ? '<span class="split-badge">⌥</span>' : ""}El ${s.element_id}${errNote}`
      : "";

    const numInput = (field, val, dimmed) => {
      const display = val !== null && val !== undefined ? val : "";
      return `<input class="table-input" type="number" step="0.001"
                data-surf="${s.surface}" data-field="${field}"
                value="${display}"
                style="${dimmed ? "opacity:0.4" : ""}"
                ${s.error ? "disabled" : ""}>`;
    };

    const glassOptions = GLASS_OPTIONS.map(g =>
      `<option value="${g}" ${g === (s.glass || "AIR") ? "selected" : ""}>${g}</option>`
    ).join("");

    // Dim the last R2 row thickness — it's image space, value is 0 but rarely meaningful
    const dimThickness = isLast && isAir;

    return `<tr id="srow-${s.surface}" class="surf-row ${isAir ? "surf-air" : "surf-glass"}">
      <td>${dot}</td>
      <td class="surf-num">${s.surface}</td>
      <td class="el-label">${elLabel}</td>
      <td>${roleLabel}</td>
      <td><input class="table-input" type="number" step="0.001"
            data-surf="${s.surface}" data-field="R_mm"
            value="${s.R_mm !== null && s.R_mm !== undefined ? s.R_mm : ""}"
            placeholder="∞" ${s.error ? "disabled" : ""}></td>
      <td>${numInput("thickness_mm", s.thickness_mm, dimThickness)}</td>
      <td>${numInput("diameter_mm",  s.diameter_mm,  false)}</td>
      <td>
        <select class="table-select" data-surf="${s.surface}" data-field="glass">
          ${glassOptions}
        </select>
      </td>
    </tr>`;
  }).join("");

  // Live-update state.measurements when cells are edited
  measureTbody.querySelectorAll(".table-input").forEach(input => {
    input.addEventListener("change", () => {
      const surf  = parseInt(input.dataset.surf);
      const field = input.dataset.field;
      const val   = input.value === "" ? null : parseFloat(input.value);
      const row   = state.measurements.find(s => s.surface === surf);
      if (row) { row[field] = val; drawMeasureCanvas(); }
    });
  });

  measureTbody.querySelectorAll(".table-select").forEach(sel => {
    sel.addEventListener("change", () => {
      const surf = parseInt(sel.dataset.surf);
      const row  = state.measurements.find(s => s.surface === surf);
      if (row) row.glass = sel.value;
    });
  });
}



btnToExport.addEventListener("click", () => goTo(5));

// ── Step 5: Export ────────────────────────────────────────────────────────────

const btnExportCsv  = document.getElementById("btn-export-csv");
const exportError   = document.getElementById("export-error");
const csvSurfCount  = document.getElementById("csv-surface-count");

// Update surface count label when entering Step 5
const _goToWithExport = window.goTo;
window.goTo = function(n) {
  _goToWithExport(n);
  if (n === 5 && state.measurements) {
    const count = state.measurements.length;
    csvSurfCount.textContent =
      `${count} surface${count !== 1 ? "s" : ""} · ${count / 2 | 0} element${(count / 2 | 0) !== 1 ? "s" : ""}`;
  }
};

btnExportCsv.addEventListener("click", async () => {
  if (!state.measurements || !state.measurements.length) {
    exportError.textContent = "No prescription data — go back and run detection first.";
    return;
  }

  exportError.textContent = "";
  btnExportCsv.textContent = "Downloading…";
  btnExportCsv.disabled = true;

  try {
    const res = await fetch("/export/csv", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        surfaces: state.measurements,
        filename: state.filename || "prescription",
      }),
    });

    if (!res.ok) {
      const data = await res.json();
      exportError.textContent = data.error || "Export failed";
      return;
    }

    // Trigger browser download from the response blob
    const blob     = await res.blob();
    const url      = URL.createObjectURL(blob);
    const a        = document.createElement("a");
    // Get filename from Content-Disposition header if available
    const disp     = res.headers.get("Content-Disposition") || "";
    const match    = disp.match(/filename=([^;]+)/);
    a.download     = match ? match[1] : "prescription.csv";
    a.href         = url;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

  } catch (err) {
    exportError.textContent = "Network error — is the server running?";
  } finally {
    btnExportCsv.textContent = "Download CSV";
    btnExportCsv.disabled = false;
  }
});

// ── Step 4 reference image ────────────────────────────────────────────────────

const measureCanvas = document.getElementById("measure-canvas");
const measureCtx    = measureCanvas.getContext("2d");

function drawMeasureCanvas() {
  if (!detectionImage || !confirmedElements.length) return;

  // Match canvas to image size
  measureCanvas.width  = detectionImage.width;
  measureCanvas.height = detectionImage.height;

  measureCtx.clearRect(0, 0, measureCanvas.width, measureCanvas.height);
  measureCtx.drawImage(detectionImage, 0, 0);

  confirmedElements.forEach(el => {
    const pts = el.points;
    if (!pts || pts.length < 2) return;

    // Outline
    measureCtx.setLineDash(el._split ? [6, 3] : []);
    measureCtx.beginPath();
    measureCtx.moveTo(pts[0][0], pts[0][1]);
    pts.forEach(p => measureCtx.lineTo(p[0], p[1]));
    measureCtx.closePath();
    measureCtx.strokeStyle = el.color;
    measureCtx.lineWidth   = 2;
    measureCtx.stroke();
    measureCtx.setLineDash([]);

    // Numbered circle
    const { cx, cy } = el;
    measureCtx.beginPath();
    measureCtx.arc(cx, cy, 13, 0, Math.PI * 2);
    measureCtx.fillStyle = el.color;
    measureCtx.fill();
    measureCtx.strokeStyle = "white";
    measureCtx.lineWidth   = 1.5;
    measureCtx.stroke();

    measureCtx.fillStyle    = "white";
    measureCtx.font         = "bold 11px monospace";
    measureCtx.textAlign    = "center";
    measureCtx.textBaseline = "middle";
    measureCtx.fillText(el.id, cx, cy);

    // Dimension labels — pull R1/R2/T from per-surface measurements
    if (state.measurements) {
      // Find the two surfaces belonging to this element
      const surfs = state.measurements.filter(s => s.element_id === el.id);
      const s1    = surfs.find(s => s.surface_role === "R1");
      const s2    = surfs.find(s => s.surface_role === "R2");
      if (s1 || s2) {
        const { x, y, w, h } = el.bbox;
        const labelX = cx;
        const labelY = y - 18;

        measureCtx.font      = "10px monospace";
        measureCtx.fillStyle = el.color;
        measureCtx.textAlign = "center";

        const r1 = s1 && s1.R_mm !== null ? `R1=${s1.R_mm}` : "";
        const r2 = s2 && s2.R_mm !== null ? `R2=${s2.R_mm}` : "";
        const t  = s1 && s1.thickness_mm !== null ? `T=${s1.thickness_mm}` : "";
        const line = [r1, r2, t].filter(Boolean).join("  ");

        // Background pill for readability
        const padding = 4;
        const tw = measureCtx.measureText(line).width;
        measureCtx.fillStyle = "rgba(10,12,16,0.75)";
        measureCtx.fillRect(labelX - tw/2 - padding, labelY - 12,
                            tw + padding*2, 16);
        measureCtx.fillStyle = el.color;
        measureCtx.fillText(line, labelX, labelY - 4);
      }
    }
  });
}



// ── Light / dark mode toggle ──────────────────────────────────────────────────

const btnThemeToggle  = document.getElementById("btn-theme-toggle");
const themeIconDark   = btnThemeToggle.querySelector(".theme-icon-dark");
const themeIconLight  = btnThemeToggle.querySelector(".theme-icon-light");

// Restore saved preference on load
if (localStorage.getItem("theme") === "light") {
  document.documentElement.classList.add("light");
  themeIconDark.style.display  = "none";
  themeIconLight.style.display = "inline";
}

btnThemeToggle.addEventListener("click", () => {
  const isLight = document.documentElement.classList.toggle("light");
  themeIconDark.style.display  = isLight ? "none"   : "inline";
  themeIconLight.style.display = isLight ? "inline" : "none";
  localStorage.setItem("theme", isLight ? "light" : "dark");
});