/* global html2canvas */

const DEFAULT_COLOR = "#000000";

const TOOL = Object.freeze({
  PENCIL: "pencil",
  BRUSH: "brush",
  MARKER: "marker",
  SPRAY: "spray",
  ERASER: "eraser",
});

function getToolConfig(tool) {
  switch (tool) {
    case TOOL.ERASER:
      return {
        tool,
        width: 18,
        alpha: 1,
        composite: "destination-out",
      };
    case TOOL.SPRAY:
      return {
        tool,
        width: 18,
        alpha: 0.9,
        composite: "source-over",
      };
    case TOOL.MARKER:
      return {
        tool,
        width: 11,
        alpha: 0.35,
        composite: "source-over",
      };
    case TOOL.BRUSH:
      return {
        tool,
        width: 9,
        alpha: 0.85,
        composite: "source-over",
      };
    case TOOL.PENCIL:
    default:
      return {
        tool: TOOL.PENCIL,
        width: 3.25,
        alpha: 1,
        composite: "source-over",
      };
  }
}

function dist(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function parseGarmentRect(str) {
  // "x,y,w,h" in [0..1]
  const parts = String(str || "")
    .split(",")
    .map((s) => Number.parseFloat(s.trim()));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return null;
  const [x, y, w, h] = parts;
  return {
    x: clamp(x, 0, 1),
    y: clamp(y, 0, 1),
    w: clamp(w, 0, 1),
    h: clamp(h, 0, 1),
  };
}

function parseGarmentRectList(raw) {
  if (!raw) return [];
  const chunks = String(raw)
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  const rects = chunks
    .map((c) => parseGarmentRect(c))
    .filter((r) => r !== null);
  return rects;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function getTimestampName() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `rezultat-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(
    d.getDate(),
  )}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.png`;
}

function canvasPointFromEvent(canvas, evt) {
  const rect = canvas.getBoundingClientRect();
  const clientX = "touches" in evt ? evt.touches[0]?.clientX : evt.clientX;
  const clientY = "touches" in evt ? evt.touches[0]?.clientY : evt.clientY;
  if (typeof clientX !== "number" || typeof clientY !== "number") return null;
  const x = (clientX - rect.left) * (canvas.width / rect.width);
  const y = (clientY - rect.top) * (canvas.height / rect.height);
  return { x, y };
}

class DrawingSurface {
  constructor(rootEl, opts = {}) {
    this.rootEl = rootEl;
    this.canvas = rootEl.querySelector("canvas.draw");
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: false });
    this.onStrokeCommitted =
      typeof opts.onStrokeCommitted === "function"
        ? opts.onStrokeCommitted
        : null;
    this.garmentRectsNorm =
      parseGarmentRectList(rootEl.dataset.garments) ||
      (rootEl.dataset.garment
        ? [parseGarmentRect(rootEl.dataset.garment)]
        : []);
    this.garmentRectsNorm = this.garmentRectsNorm.filter(Boolean);
    this.outlineEls = [];

    this.activeColor = DEFAULT_COLOR;
    this.activeTool = TOOL.PENCIL;
    this.isDrawing = false;
    this.currentStroke = null;
    this.strokes = [];
    this.undoneStrokes = [];

    this.lineCap = "round";
    this.lineJoin = "round";

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.rootEl);

    this.ensureOutlineEls();
    this.bindEvents();
    this.resize();
  }

  setColor(color) {
    this.activeColor = color;
  }

  setTool(tool) {
    this.activeTool =
      tool === TOOL.ERASER ||
      tool === TOOL.MARKER ||
      tool === TOOL.BRUSH ||
      tool === TOOL.SPRAY ||
      tool === TOOL.PENCIL
        ? tool
        : TOOL.PENCIL;
  }

  resize() {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const rect = this.rootEl.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));

    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.redraw();
    }

    this.updateOutlines();
  }

  ensureOutlineEls() {
    const existing = Array.from(
      this.rootEl.querySelectorAll(".garment-outline"),
    );
    while (existing.length < this.garmentRectsNorm.length) {
      const div = document.createElement("div");
      div.className = "garment-outline";
      this.rootEl.appendChild(div);
      existing.push(div);
    }
    this.outlineEls = existing.slice(0, this.garmentRectsNorm.length);
  }

  updateOutlines() {
    const rectsPx = this.getGarmentRectsPx();
    if (!rectsPx.length) return;
    this.ensureOutlineEls();
    rectsPx.forEach((r, idx) => {
      const el = this.outlineEls[idx];
      if (!el || !r) return;
      el.style.left = `${r.x}px`;
      el.style.top = `${r.y}px`;
      el.style.width = `${r.w}px`;
      el.style.height = `${r.h}px`;
    });
  }

  getGarmentRectsPx() {
    if (!this.garmentRectsNorm.length) return [];
    const rect = this.rootEl.getBoundingClientRect();
    const scaleX = this.canvas.width / rect.width;
    const scaleY = this.canvas.height / rect.height;
    return this.garmentRectsNorm.map((g) => ({
      x: g.x * rect.width * scaleX,
      y: g.y * rect.height * scaleY,
      w: g.w * rect.width * scaleX,
      h: g.h * rect.height * scaleY,
    }));
  }

  isInsideGarment(pt) {
    const rects = this.getGarmentRectsPx();
    if (!rects.length) return true;
    return rects.some(
      (r) =>
        pt.x >= r.x && pt.x <= r.x + r.w && pt.y >= r.y && pt.y <= r.y + r.h,
    );
  }

  bindEvents() {
    const onDown = (evt) => {
      evt.preventDefault();
      const pt = canvasPointFromEvent(this.canvas, evt);
      if (!pt) return;
      if (!this.isInsideGarment(pt)) return;

      const cfg = getToolConfig(this.activeTool);
      this.isDrawing = true;
      this.currentStroke = {
        tool: cfg.tool,
        color: this.activeColor,
        width: cfg.width,
        points: [pt],
      };

      if (cfg.tool === TOOL.SPRAY) {
        this.currentStroke.dots = [];
        this.currentStroke.drawnDots = 0;
        this.addSprayDots(pt, pt);
        this.drawNewSprayDots(this.currentStroke);
      }
    };

    const onMove = (evt) => {
      if (!this.isDrawing || !this.currentStroke) return;
      evt.preventDefault();

      const pt = canvasPointFromEvent(this.canvas, evt);
      if (!pt) return;
      if (!this.isInsideGarment(pt)) return;

      const pts = this.currentStroke.points;
      pts.push(pt);
      if (this.currentStroke.tool === TOOL.SPRAY) {
        this.addSprayDots(pts[pts.length - 2], pt);
        this.drawNewSprayDots(this.currentStroke);
      } else {
        this.drawStrokeSegment(this.currentStroke, Math.max(0, pts.length - 2));
      }
    };

    const onUp = (evt) => {
      if (!this.isDrawing || !this.currentStroke) return;
      evt.preventDefault();

      let committed = null;
      if (this.currentStroke.tool === TOOL.SPRAY) {
        committed = this.currentStroke;
      } else if (this.currentStroke.points.length >= 2) {
        committed = this.currentStroke;
      } else if (this.currentStroke.points.length === 1) {
        // dot
        const dotStroke = this.currentStroke;
        dotStroke.points.push(dotStroke.points[0]);
        committed = dotStroke;
      }

      if (committed) {
        this.strokes.push(committed);
        if (this.onStrokeCommitted) this.onStrokeCommitted(committed);
      }

      this.isDrawing = false;
      this.currentStroke = null;
      this.undoneStrokes = [];
      this.redraw();
    };

    this.canvas.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp, { passive: false });
    window.addEventListener("pointercancel", onUp, { passive: false });

    // touch fallback (older WebViews)
    this.canvas.addEventListener("touchstart", onDown, { passive: false });
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onUp, { passive: false });
    window.addEventListener("touchcancel", onUp, { passive: false });
  }

  clear() {
    this.strokes = [];
    this.undoneStrokes = [];
    this.currentStroke = null;
    this.isDrawing = false;
    this.redraw();
  }

  undo() {
    if (this.strokes.length === 0) return false;
    const stroke = this.strokes.pop();
    this.undoneStrokes.push(stroke);
    this.redraw();
    return true;
  }

  redo() {
    if (this.undoneStrokes.length === 0) return false;
    const stroke = this.undoneStrokes.pop();
    this.strokes.push(stroke);
    this.redraw();
    return true;
  }

  redraw() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    for (const s of this.strokes) {
      this.drawFullStroke(s);
    }
  }

  drawFullStroke(stroke) {
    if (stroke.tool === TOOL.SPRAY) {
      this.drawAllSprayDots(stroke);
      return;
    }
    for (let i = 0; i < stroke.points.length - 1; i += 1) {
      this.drawStrokeSegment(stroke, i);
    }
  }

  addSprayDots(a, b) {
    if (!this.currentStroke || this.currentStroke.tool !== TOOL.SPRAY) return;
    const cfg = getToolConfig(TOOL.SPRAY);
    const d = dist(a, b);
    const steps = Math.max(1, Math.ceil(d / 6));
    const radius = Math.max(2, (cfg.width || 18) * 0.55);
    const dotsPerStep = 8;

    for (let i = 0; i <= steps; i += 1) {
      const t = steps === 0 ? 0 : i / steps;
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      for (let j = 0; j < dotsPerStep; j += 1) {
        const ang = Math.random() * Math.PI * 2;
        const r = Math.random() * radius;
        this.currentStroke.dots.push({
          x: x + Math.cos(ang) * r,
          y: y + Math.sin(ang) * r,
          r: 0.8 + Math.random() * 1.6,
          a: 0.35 + Math.random() * 0.55,
        });
      }
    }
  }

  drawNewSprayDots(stroke) {
    const start = stroke.drawnDots || 0;
    const dots = stroke.dots || [];
    if (start >= dots.length) return;
    this.drawSprayDotsRange(stroke, start, dots.length);
    stroke.drawnDots = dots.length;
  }

  drawAllSprayDots(stroke) {
    const dots = stroke.dots || [];
    this.drawSprayDotsRange(stroke, 0, dots.length);
  }

  drawSprayDotsRange(stroke, from, to) {
    const ctx = this.ctx;
    const cfg = getToolConfig(TOOL.SPRAY);
    ctx.save();
    ctx.globalCompositeOperation = cfg.composite;
    ctx.fillStyle = stroke.color || DEFAULT_COLOR;
    for (let i = from; i < to; i += 1) {
      const d = stroke.dots[i];
      if (!d) continue;
      ctx.globalAlpha = (cfg.alpha || 1) * (d.a || 1);
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  drawStrokeSegment(stroke, idx) {
    const ctx = this.ctx;
    const a = stroke.points[idx];
    const b = stroke.points[idx + 1];
    if (!a || !b) return;

    const cfg = getToolConfig(stroke.tool);
    ctx.save();
    ctx.globalCompositeOperation = cfg.composite;
    ctx.lineCap = this.lineCap;
    ctx.lineJoin = this.lineJoin;

    if (stroke.tool === TOOL.BRUSH) {
      const baseColor = stroke.color;
      const w = stroke.width;
      const total = Math.max(1, (stroke.points.length || 0) - 1);
      const t = clamp(idx / total, 0, 1);
      const thickness = w * (0.7 + 1.1 * t); // starts thinner, ends thicker

      // Core stroke
      ctx.strokeStyle = baseColor;
      ctx.globalAlpha = cfg.alpha;
      ctx.lineWidth = thickness;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();

      // Softer edges: a couple of translucent, slightly offset passes
      ctx.globalAlpha = cfg.alpha * 0.35;
      ctx.lineWidth = thickness * 1.35;
      ctx.beginPath();
      ctx.moveTo(a.x + 0.6, a.y + 0.4);
      ctx.lineTo(b.x + 0.6, b.y + 0.4);
      ctx.stroke();

      ctx.globalAlpha = cfg.alpha * 0.25;
      ctx.lineWidth = thickness * 1.55;
      ctx.beginPath();
      ctx.moveTo(a.x - 0.5, a.y - 0.3);
      ctx.lineTo(b.x - 0.5, b.y - 0.3);
      ctx.stroke();
    } else {
      ctx.globalAlpha = cfg.alpha;
      ctx.strokeStyle =
        cfg.tool === TOOL.ERASER
          ? "rgba(0,0,0,1)"
          : stroke.color || this.activeColor || DEFAULT_COLOR;
      ctx.lineWidth = stroke.width;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    ctx.restore();
  }
}

function main() {
  const history = [];
  const redoStack = [];
  const pushAction = (action) => {
    history.push(action);
    redoStack.length = 0;
  };

  const modelEls = Array.from(document.querySelectorAll(".model"));
  const surfaces = modelEls.map(
    (el, surfaceIndex) =>
      new DrawingSurface(el, {
        onStrokeCommitted: (stroke) => {
          pushAction({ type: "stroke", surfaceIndex, stroke });
        },
      }),
  );

  let activeColor = DEFAULT_COLOR;
  let activeTool = TOOL.PENCIL;

  const swatches = Array.from(document.querySelectorAll(".swatch"));
  const setSelectedSwatch = (btn) => {
    for (const b of swatches) b.classList.toggle("is-selected", b === btn);
  };

  for (const btn of swatches) {
    btn.addEventListener("click", () => {
      const c = btn.dataset.color || DEFAULT_COLOR;
      activeColor = c;
      setSelectedSwatch(btn);
      for (const s of surfaces) s.setColor(activeColor);
    });
  }

  // Ensure all surfaces start with default
  for (const s of surfaces) s.setColor(activeColor);

  const toolButtons = Array.from(document.querySelectorAll(".tool-btn"));
  const setSelectedToolBtn = (btn) => {
    for (const b of toolButtons) b.classList.toggle("is-selected", b === btn);
  };

  for (const btn of toolButtons) {
    btn.addEventListener("click", () => {
      const t = btn.dataset.tool || TOOL.PENCIL;
      activeTool =
        t === TOOL.ERASER ||
        t === TOOL.MARKER ||
        t === TOOL.BRUSH ||
        t === TOOL.SPRAY ||
        t === TOOL.PENCIL
          ? t
          : TOOL.PENCIL;
      setSelectedToolBtn(btn);
      for (const s of surfaces) s.setTool(activeTool);
    });
  }

  // Ensure all surfaces start with default tool
  for (const s of surfaces) s.setTool(activeTool);

  // Active model selection (target for uploads)
  let activeModelEl = modelEls.find((m) => m.classList.contains("is-center")) || modelEls[0] || null;
  const setActiveModel = (el) => {
    if (!el) return;
    activeModelEl = el;
    for (const m of modelEls) m.classList.toggle("is-active-target", m === el);
  };
  setActiveModel(activeModelEl);

  for (const m of modelEls) {
    m.addEventListener("click", (evt) => {
      const inControls = evt.target?.closest?.(".img-controls");
      if (inControls) return;
      setActiveModel(m);
    });
  }

  const uploadBtn = document.getElementById("upload-btn");
  const uploadInput = document.getElementById("upload-input");

  uploadBtn?.addEventListener("click", () => {
    if (!uploadInput) return;
    uploadInput.value = "";
    uploadInput.click();
  });

  function clampScale(s) {
    return clamp(s, 0.2, 6);
  }

  function applyPlacedTransform(el) {
    el.style.transform = "translate(-50%, -50%)";
  }

  function clampSizePx(px) {
    return clamp(px, 30, 1600);
  }

  function makePlacedImage(src) {
    const wrap = document.createElement("div");
    wrap.className = "placed-image";
    wrap.dataset.scale = "1";

    const controls = document.createElement("div");
    controls.className = "img-controls";

    const del = document.createElement("button");
    del.type = "button";
    del.setAttribute("aria-label", "Удалить изображение");
    del.title = "Удалить";
    del.textContent = "✕";

    const pin = document.createElement("button");
    pin.type = "button";
    pin.setAttribute("aria-label", "Закрепить изображение");
    pin.title = "Закрепить";
    pin.textContent = "✓";

    controls.appendChild(del);
    controls.appendChild(pin);

    const img = document.createElement("img");
    img.alt = "Загруженное изображение";
    img.draggable = false;
    img.src = src;

    wrap.appendChild(controls);
    wrap.appendChild(img);
    const handleDirs = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];
    for (const dir of handleDirs) {
      const h = document.createElement("div");
      h.className = "resize-handle";
      h.dataset.dir = dir;
      wrap.appendChild(h);
    }
    applyPlacedTransform(wrap);

    const getState = () => ({
      left: wrap.style.left || "",
      top: wrap.style.top || "",
      w: img.style.width || "",
      h: img.style.height || "",
    });

    const applyState = (st) => {
      if (!st) return;
      if (typeof st.left === "string") wrap.style.left = st.left;
      if (typeof st.top === "string") wrap.style.top = st.top;
      if (typeof st.w === "string") img.style.width = st.w;
      if (typeof st.h === "string") img.style.height = st.h;
      wrap.dataset.w = String(Number.parseFloat(img.style.width || "0") || "");
      wrap.dataset.h = String(Number.parseFloat(img.style.height || "0") || "");
    };

    const statesEqual = (a, b) =>
      a &&
      b &&
      a.left === b.left &&
      a.top === b.top &&
      a.w === b.w &&
      a.h === b.h;

    del.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      pushAction({ type: "image-remove", parent: wrap.parentElement, el: wrap });
      wrap.remove();
    });

    pin.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      wrap.classList.add("is-pinned");
      wrap.dataset.pinned = "1";
    });

    const ensureInitialSize = () => {
      // Only set once
      if (wrap.dataset.w && wrap.dataset.h) return;
      const nw = img.naturalWidth || 220;
      const nh = img.naturalHeight || 220;
      const maxW = 260;
      const scale = Math.min(1, maxW / Math.max(1, nw));
      const w = Math.max(60, Math.round(nw * scale));
      const h = Math.max(60, Math.round(nh * scale));
      wrap.dataset.w = String(w);
      wrap.dataset.h = String(h);
      img.style.width = `${w}px`;
      img.style.height = `${h}px`;
    };

    img.addEventListener("load", () => {
      ensureInitialSize();
    });
    ensureInitialSize();

    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;
    let dragFromState = null;

    const onPointerDown = (e) => {
      if (wrap.classList.contains("is-pinned")) return;
      const isHandle = e.target?.closest?.(".resize-handle");
      if (isHandle) return;
      dragging = true;
      dragFromState = getState();
      wrap.setPointerCapture?.(e.pointerId);
      const parent = wrap.parentElement;
      const rect = parent?.getBoundingClientRect();
      if (!rect) return;
      startX = e.clientX;
      startY = e.clientY;
      startLeft = Number.parseFloat(wrap.style.left || "0") || rect.width / 2;
      startTop = Number.parseFloat(wrap.style.top || "0") || rect.height / 2;
      e.preventDefault();
      e.stopPropagation();
    };

    const onPointerMove = (e) => {
      if (!dragging) return;
      const parent = wrap.parentElement;
      const rect = parent?.getBoundingClientRect();
      if (!rect) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      wrap.style.left = `${startLeft + dx}px`;
      wrap.style.top = `${startTop + dy}px`;
      e.preventDefault();
    };

    const onPointerUp = () => {
      if (dragging && dragFromState) {
        const to = getState();
        if (!statesEqual(dragFromState, to)) {
          pushAction({ type: "image-transform", el: wrap, from: dragFromState, to });
        }
      }
      dragging = false;
      dragFromState = null;
    };

    wrap.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove, { passive: false });
    window.addEventListener("pointerup", onPointerUp, { passive: true });

    let resizing = false;
    let resizeDir = "";
    let startW = 0;
    let startH = 0;
    let startL = 0;
    let startT = 0;
    let resizeFromState = null;

    const onResizeDown = (e) => {
      if (wrap.classList.contains("is-pinned")) return;
      const dir = e.target?.dataset?.dir;
      if (!dir) return;
      resizing = true;
      resizeDir = dir;
      resizeFromState = getState();
      wrap.setPointerCapture?.(e.pointerId);
      startX = e.clientX;
      startY = e.clientY;
      startW = Number.parseFloat(img.style.width || wrap.dataset.w || "220") || 220;
      startH = Number.parseFloat(img.style.height || wrap.dataset.h || "220") || 220;
      startL = Number.parseFloat(wrap.style.left || "0") || 0;
      startT = Number.parseFloat(wrap.style.top || "0") || 0;
      e.preventDefault();
      e.stopPropagation();
    };

    const onResizeMove = (e) => {
      if (!resizing) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      let w = startW;
      let h = startH;
      let l = startL;
      let t = startT;

      const hasE = resizeDir.includes("e");
      const hasW = resizeDir.includes("w");
      const hasN = resizeDir.includes("n");
      const hasS = resizeDir.includes("s");

      if (hasE) w = startW + dx;
      if (hasW) w = startW - dx;
      if (hasS) h = startH + dy;
      if (hasN) h = startH - dy;

      w = clampSizePx(w);
      h = clampSizePx(h);

      // Adjust position so the opposite side stays anchored
      if (hasW) l = startL + dx;
      if (hasN) t = startT + dy;

      wrap.dataset.w = String(w);
      wrap.dataset.h = String(h);
      img.style.width = `${w}px`;
      img.style.height = `${h}px`;
      wrap.style.left = `${l}px`;
      wrap.style.top = `${t}px`;
      e.preventDefault();
    };

    const onResizeUp = () => {
      if (resizing && resizeFromState) {
        const to = getState();
        if (!statesEqual(resizeFromState, to)) {
          pushAction({ type: "image-transform", el: wrap, from: resizeFromState, to });
        }
      }
      resizing = false;
      resizeDir = "";
      resizeFromState = null;
    };

    for (const h of wrap.querySelectorAll(".resize-handle")) {
      h.addEventListener("pointerdown", onResizeDown);
    }
    window.addEventListener("pointermove", onResizeMove, { passive: false });
    window.addEventListener("pointerup", onResizeUp, { passive: true });

    let wheelCommitTimer = null;
    let wheelFromState = null;
    wrap.addEventListener(
      "wheel",
      (e) => {
        if (wrap.classList.contains("is-pinned")) return;
        e.preventDefault();
        if (!wheelFromState) wheelFromState = getState();
        const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
        const curW = Number.parseFloat(img.style.width || wrap.dataset.w || "220") || 220;
        const curH = Number.parseFloat(img.style.height || wrap.dataset.h || "220") || 220;
        const w = clampSizePx(curW * factor);
        const h = clampSizePx(curH * factor);
        wrap.dataset.w = String(w);
        wrap.dataset.h = String(h);
        img.style.width = `${w}px`;
        img.style.height = `${h}px`;

        if (wheelCommitTimer) window.clearTimeout(wheelCommitTimer);
        wheelCommitTimer = window.setTimeout(() => {
          const to = getState();
          if (wheelFromState && !statesEqual(wheelFromState, to)) {
            pushAction({ type: "image-transform", el: wrap, from: wheelFromState, to });
          }
          wheelFromState = null;
          wheelCommitTimer = null;
        }, 200);
      },
      { passive: false },
    );

    return wrap;
  }

  uploadInput?.addEventListener("change", () => {
    const file = uploadInput.files?.[0];
    if (!file || !activeModelEl) return;
    const reader = new FileReader();
    reader.onload = () => {
      const src = String(reader.result || "");
      if (!src) return;
      const placed = makePlacedImage(src);
      // center by default, but use explicit px so dragging math is consistent
      const rect = activeModelEl.getBoundingClientRect();
      placed.style.left = `${rect.width / 2}px`;
      placed.style.top = `${rect.height / 2}px`;
      activeModelEl.appendChild(placed);
      pushAction({ type: "image-add", parent: activeModelEl, el: placed });
    };
    reader.readAsDataURL(file);
  });

  const applyStateToPlaced = (wrap, st) => {
    const img = wrap?.querySelector?.("img");
    if (!wrap || !img || !st) return;
    if (typeof st.left === "string") wrap.style.left = st.left;
    if (typeof st.top === "string") wrap.style.top = st.top;
    if (typeof st.w === "string") img.style.width = st.w;
    if (typeof st.h === "string") img.style.height = st.h;
    wrap.dataset.w = String(Number.parseFloat(img.style.width || "0") || "");
    wrap.dataset.h = String(Number.parseFloat(img.style.height || "0") || "");
  };

  const applyUndo = () => {
    const action = history.pop();
    if (!action) return;
    redoStack.push(action);
    if (action.type === "stroke") {
      const surf = surfaces[action.surfaceIndex];
      if (!surf) return;
      const idx = surf.strokes.lastIndexOf(action.stroke);
      if (idx !== -1) {
        surf.strokes.splice(idx, 1);
        surf.redraw();
      }
    } else if (action.type === "image-add") {
      action.el?.remove();
    } else if (action.type === "image-remove") {
      if (action.parent && action.el) action.parent.appendChild(action.el);
    } else if (action.type === "image-transform") {
      action.el && action.from && applyStateToPlaced(action.el, action.from);
    }
  };

  const applyRedo = () => {
    const action = redoStack.pop();
    if (!action) return;
    history.push(action);
    if (action.type === "stroke") {
      const surf = surfaces[action.surfaceIndex];
      if (!surf) return;
      surf.strokes.push(action.stroke);
      surf.redraw();
    } else if (action.type === "image-add") {
      if (action.parent && action.el) action.parent.appendChild(action.el);
    } else if (action.type === "image-remove") {
      action.el?.remove();
    } else if (action.type === "image-transform") {
      action.el && action.to && applyStateToPlaced(action.el, action.to);
    }
  };

  const undoBtn = document.getElementById("undo-btn");
  undoBtn?.addEventListener("click", () => {
    applyUndo();
  });

  // Double-click undo to clear everything quickly
  undoBtn?.addEventListener("dblclick", () => {
    for (const s of surfaces) s.clear();
    history.length = 0;
    redoStack.length = 0;
  });

  const redoBtn = document.getElementById("redo-btn");
  redoBtn?.addEventListener("click", () => {
    applyRedo();
  });

  const saveBtn = document.getElementById("save-btn");
  saveBtn?.addEventListener("click", async () => {
    const appRoot = document.getElementById("capture-root");
    const modelsRoot = document.querySelector(".models");
    const root = modelsRoot || appRoot;
    if (!root || typeof html2canvas !== "function") return;

    const prevText = saveBtn.textContent;
    saveBtn.textContent = "сохранение…";
    saveBtn.disabled = true;
    appRoot?.classList.add("is-saving");

    try {
      const canvas = await html2canvas(root, {
        backgroundColor: "#ffffff",
        scale: Math.max(1, window.devicePixelRatio || 1),
        useCORS: true,
      });

      const blob = await new Promise((resolve) =>
        canvas.toBlob(resolve, "image/png", 1),
      );

      if (blob) downloadBlob(blob, getTimestampName());
    } finally {
      appRoot?.classList.remove("is-saving");
      saveBtn.textContent = prevText || "сохранить результат";
      saveBtn.disabled = false;
    }
  });

  // Keep garment outlines in sync on load / orientation change
  window.addEventListener("resize", () => {
    for (const s of surfaces) s.resize();
  });
}

main();

