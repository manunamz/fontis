/*
 * cone.js — the entire graph as a cone spinning on the spine. The seed is the
 * tip, the rows run down it, and each lane is a position around it, so the
 * table is the strip of the cone that's facing you, rolled flat.
 */
'use strict';

const CONE_PAD = 26;
const BACK_ALPHA = 0.1;
const FRONT_ALPHA = 0.3;
const TREAD_STEPS = 8; // line segments per sector of the rim
const RING = 7; // px around a selected paper
const SELECTED_DOT = 3.5; // px
const SELECTED_GLOW = 8; // px
const SIGHT_REACH = 7; // px the marker for the rows in view overhangs the strip
const TAU = Math.PI * 2;
const MAX_ZOOM = 16;
const ZOOM_STEP = 1.5; // per button press
const WHEEL_ZOOM = 0.002; // per pixel scrolled
const PINCH_ZOOM = 0.01; // per pixel pinched, which reports far smaller deltas
const DOTS_FROM_ZOOM = 2; // from here on, the front's papers are drawn too
const MAX_CLARITY = 2; // how far zooming in can brighten the lines
const SETTLE_MS = 140; // after this long still, the sharp view is drawn
const STILL_LINKS = 40000; // links in the sharp view: past this the cone is a blur anyway
const BATCH_LINKS = 5000; // sharp links drawn per frame, so input never waits long
const QUICK_TREE = 12000; // links few enough to draw sharp in one go
const TRACE_DIM = 0.3; // the rest of the cone, while a paper's line is traced
const TRACE_ALPHA = [0.35, 0.9]; // a traced line on the back, then the front
const TRACE_LINKS = 12000; // traced links drawn when still
const TRACE_MOVING = 3000; // and while moving

const { CONE_TILT, MAX_LINKS, conePoint, project, adjustDetail, linksInView } = Projection;

let cone = null;
let spinLinks = MAX_LINKS; // links drawn per frame while moving, tuned to the machine
let lastMove = 0;
let sharpRun = 0; // a newer draw abandons a sharp view still being built
const sharp = document.createElement('canvas'); // where it's built, out of sight
const lens = { zoom: 1, x: 0, y: 0 };

const sectorStyle = (sector) => `--lane-${1 + sector % SIDE_COLORS}`;

function edgeStyle(e, rows, nodes) {
  if (nodes[e.parent].missing) return '--red';
  if (e.suspect) return '--yellow';
  if (e.fromLane === 0 && e.toLane === 0) return '--lane-0';
  const [child, parent] = [rows[e.from], rows[e.to]];
  return child.sector === parent.sector || child.lane === 0 ? sectorStyle(parent.sector) : '--edge-quiet';
}

// Links grouped by style, each with room for the ones in view.
function linkGroups(edges, rows, nodes) {
  const lists = new Map();
  for (const e of edges) {
    const style = edgeStyle(e, rows, nodes);
    if (!lists.has(style)) lists.set(style, []);
    lists.get(style).push(e.from, e.to);
  }
  return [...lists].map(([style, pairs]) => {
    const all = Int32Array.from(pairs);
    return { style, all, seen: new Int32Array(all.length), length: 0 };
  });
}

function buildCone(layout, nodes) {
  const count = layout.rows.length;
  const side = layout.lanes - 1;
  const angle = new Float32Array(count);
  const drop = new Float32Array(count);
  const lane = new Int32Array(count);
  for (const row of layout.rows) {
    angle[row.row] = (row.lane - 1) / side * TAU;
    drop[row.row] = row.row / Math.max(count - 1, 1);
    lane[row.row] = row.lane;
  }
  const groups = linkGroups(layout.edges, layout.rows, nodes);
  const spine = Int32Array.from(layout.rows.filter((row) => row.lane === 0), (row) => row.row);
  const buffers = { xs: new Float32Array(count), ys: new Float32Array(count), nears: new Float32Array(count) };
  return { layout, angle, drop, groups, spine, side, ...buffers, lit: new Uint8Array(count), trail: null, traced: [] };
}

function coneShape(width, height) {
  const tall = height - CONE_PAD * 2;
  const radius = Math.min(width / 2 - CONE_PAD, tall * 0.55);
  const length = tall - radius * Math.sin(CONE_TILT) * 2;
  return { radius, length, cx: width / 2, top: CONE_PAD };
}

// Keep the canvas covered, so the cone can't be dragged off it.
function clampLens(width, height) {
  lens.x = Math.min(0, Math.max(width * (1 - lens.zoom), lens.x));
  lens.y = Math.min(0, Math.max(height * (1 - lens.zoom), lens.y));
}

// Zoom keeping the point under (x, y) where it is.
function zoomAt(zoom, x, y) {
  const box = $('cone-canvas').parentElement;
  const next = Math.min(MAX_ZOOM, Math.max(1, zoom));
  lens.x = x - (x - lens.x) * next / lens.zoom;
  lens.y = y - (y - lens.y) * next / lens.zoom;
  lens.zoom = next;
  clampLens(box.clientWidth, box.clientHeight);
  $('cone-zoom-reset').textContent = `${Math.round(next * 100)}%`;
}

// Every `step`th of a group's links on one side of the cone, `front` or the back.
function strokeLayer(ctx, group, front, step, from = 0, to = group.length / 2) {
  const { xs, ys, nears } = cone;
  const pairs = group.seen;
  ctx.beginPath();
  for (let k = from; k < to; k += step) {
    const i = Math.floor(k) * 2;
    const [a, b] = [pairs[i], pairs[i + 1]];
    if (nears[a] + nears[b] >= 0 !== front) continue;
    ctx.moveTo(xs[a], ys[a]);
    ctx.lineTo(xs[b], ys[b]);
  }
  ctx.stroke();
}

// The links in the table's strip, drawn bright over the rest.
function strokeStrip(ctx, frame, nodes) {
  const { xs, ys } = cone;
  const byStyle = new Map();
  for (const e of frame.edges) {
    const style = edgeStyle(e, cone.layout.rows, nodes);
    if (!byStyle.has(style)) byStyle.set(style, []);
    byStyle.get(style).push(e);
  }
  for (const [style, edges] of byStyle) {
    ctx.strokeStyle = cssVar(style);
    ctx.beginPath();
    for (const { from, to } of edges) {
      ctx.moveTo(xs[from], ys[from]);
      ctx.lineTo(xs[to], ys[to]);
    }
    ctx.stroke();
  }
}

function drawTread(ctx, shape, layout, spin) {
  ctx.lineWidth = 3 / lens.zoom;
  for (const { sector, first, last } of layout.sectors) {
    if (first == null) continue;
    ctx.strokeStyle = cssVar(sectorStyle(sector));
    const [from, to] = [(first - 1) / cone.side * TAU, last / cone.side * TAU];
    let previous = null;
    for (let i = 0; i <= TREAD_STEPS; i++) {
      const point = conePoint(shape, from + (to - from) * i / TREAD_STEPS - spin, 1);
      if (previous) {
        ctx.globalAlpha = point.near < 0 ? 0.25 : 0.9;
        ctx.beginPath();
        ctx.moveTo(previous.x, previous.y);
        ctx.lineTo(point.x, point.y);
        ctx.stroke();
      }
      previous = point;
    }
  }
  ctx.globalAlpha = 1;
}

// The strip the table shows, tip to rim, and the stretch of it scrolled into view.
function drawStrip(ctx, shape, frame, spin, seen) {
  const width = frame.lanes - 1;
  const left = frame.offset / cone.side * TAU - spin;
  const right = (frame.offset + width) / cone.side * TAU - spin;
  const a = conePoint(shape, left, 1);
  const b = conePoint(shape, right, 1);
  ctx.strokeStyle = cssVar('--accent');
  ctx.lineWidth = 1 / lens.zoom;
  ctx.beginPath();
  ctx.moveTo(shape.cx, shape.top);
  ctx.lineTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.closePath();
  ctx.stroke();

  const top = conePoint(shape, left, seen.from);
  const bottom = conePoint(shape, right, seen.to);
  const reach = SIGHT_REACH / lens.zoom;
  ctx.strokeRect(Math.min(top.x, bottom.x) - reach, top.y, Math.abs(bottom.x - top.x) + reach * 2, Math.max(bottom.y - top.y, 2 / lens.zoom));
}

// Rings around the selected paper and the one it was reached from.
function drawRings(ctx, xs, ys, rings) {
  ctx.strokeStyle = cssVar('--accent');
  for (const { row, strong } of rings) {
    ctx.lineWidth = (strong ? 2 : 1) / lens.zoom;
    ctx.beginPath();
    ctx.arc(xs[row], ys[row], (strong ? RING : RING * 0.7) / lens.zoom, 0, TAU);
    ctx.stroke();
    if (!strong) continue;
    ctx.save();
    ctx.fillStyle = ctx.shadowColor = cssVar('--accent');
    ctx.shadowBlur = SELECTED_GLOW;
    ctx.beginPath();
    ctx.arc(xs[row], ys[row], SELECTED_DOT / lens.zoom, 0, TAU);
    ctx.fill();
    ctx.restore();
  }
}

// Point a canvas's drawing at the page, zoomed and panned.
function aimContext(ctx, scale) {
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.translate(lens.x, lens.y);
  ctx.scale(lens.zoom, lens.zoom);
}

function fitCanvas(canvas, width, height, scale) {
  if (canvas.width === Math.round(width * scale) && canvas.height === Math.round(height * scale)) {
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  } else {
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
  }
}

// Lines stay thin as they spread apart, so they can afford to brighten.
const lineLayers = () => {
  const clarity = Math.min(MAX_CLARITY, Math.sqrt(lens.zoom));
  const dim = cone.trail ? TRACE_DIM : 1;
  return [[BACK_ALPHA * dim, false], [FRONT_ALPHA * clarity * dim, true]];
};

// The links of the traced line, as the 2D graph lights them: both ends on it.
function traceLinks(trail, nodes) {
  if (cone.trail === trail) return;
  cone.trail = trail;
  if (!trail) { cone.traced = []; return; }
  const { rows, edges } = cone.layout;
  cone.traced = linkGroups(edges.filter((e) => trail.has(e.child) && trail.has(e.parent)), rows, nodes);
}

// The traced line over the dimmed cone, a spread of it if it's big.
function strokeTrace(ctx, moving) {
  const links = cone.traced.reduce((sum, group) => sum + group.length / 2, 0);
  const step = Math.max(1, links / (moving ? TRACE_MOVING : TRACE_LINKS));
  ctx.lineWidth = 1 / lens.zoom;
  TRACE_ALPHA.forEach((alpha, side) => {
    ctx.globalAlpha = Math.min(1, alpha * Math.sqrt(step));
    for (const group of cone.traced) {
      ctx.strokeStyle = cssVar(group.style);
      strokeLayer(ctx, group, side === 1, step);
    }
  });
  ctx.globalAlpha = 1;
}

// Everything drawn over the links.
function drawOverlay(ctx, shape, frame, spin, seen, rings, nodes, moving) {
  const { xs, ys, nears, lit } = cone;
  strokeTrace(ctx, moving);
  ctx.globalAlpha = 1;
  drawTread(ctx, shape, cone.layout, spin);
  ctx.lineWidth = 1.2 / lens.zoom;
  strokeStrip(ctx, frame, nodes);
  ctx.fillStyle = cssVar('--fg');
  const dot = 2.5 / lens.zoom;
  if (lens.zoom >= DOTS_FROM_ZOOM) {
    for (let i = 0; i < lit.length; i++) {
      if (!lit[i] && nears[i] >= 0) ctx.fillRect(xs[i] - dot / 4, ys[i] - dot / 4, dot / 2, dot / 2);
    }
  }
  for (const { row } of frame.rows) ctx.fillRect(xs[row] - dot / 2, ys[row] - dot / 2, dot, dot);
  if (frame.rotates) drawStrip(ctx, shape, frame, spin, seen);
  drawRings(ctx, xs, ys, rings);
}

// Build the sharp view a batch per frame, then show it. Most of a line's cost
// comes when the browser paints it, so one big draw would hold up all input.
function buildSharp(ctx, canvas, scale, width, height, step, finish) {
  const run = ++sharpRun;
  fitCanvas(sharp, width, height, scale);
  const back = sharp.getContext('2d');
  aimContext(back, scale);
  back.lineWidth = 0.6 / lens.zoom;
  const batches = [];
  for (const [alpha, front] of lineLayers()) {
    for (const group of cone.groups) {
      const links = group.length / 2;
      for (let from = 0; from < links; from += BATCH_LINKS * step) {
        batches.push({ alpha, front, group, from, to: Math.min(links, from + BATCH_LINKS * step) });
      }
    }
  }
  const next = () => {
    if (run !== sharpRun) return;
    const batch = batches.shift();
    if (!batch) {
      fitCanvas(canvas, width, height, scale);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(sharp, 0, 0);
      aimContext(ctx, scale);
      finish();
      return;
    }
    back.globalAlpha = batch.alpha;
    back.strokeStyle = cssVar(batch.group.style);
    strokeLayer(back, batch.group, batch.front, step, batch.from, batch.to);
    requestAnimationFrame(next);
  };
  requestAnimationFrame(next);
}

// `moving` trades detail for speed: a big tree draws a spread of its links,
// brightened to keep its weight, on a canvas with a quarter of the pixels.
function drawCone(layout, nodes, frame, turn, seen, rings, trail, moving = false) {
  if (cone?.layout !== layout) cone = buildCone(layout, nodes);
  traceLinks(trail, nodes);
  const canvas = $('cone-canvas');
  const box = canvas.parentElement;
  const width = box.clientWidth;
  const height = box.clientHeight;
  const big = layout.edges.length > QUICK_TREE;
  const pixels = window.devicePixelRatio || 1;
  const scale = moving && big ? 1 : pixels;
  const ctx = canvas.getContext('2d');
  sharpRun++;
  clampLens(width, height);

  const shape = coneShape(width, height);
  const spin = (turn + (frame.lanes - 1) / 2) / cone.side * TAU;
  const { xs, ys, nears, lit } = cone;
  project(cone.angle, cone.drop, shape, spin, cone);
  for (const row of cone.spine) {
    xs[row] = shape.cx;
    nears[row] = 0;
  }
  lit.fill(0);
  for (const { row } of frame.rows) lit[row] = 1;

  const view = { left: -lens.x / lens.zoom, top: -lens.y / lens.zoom, right: (width - lens.x) / lens.zoom, bottom: (height - lens.y) / lens.zoom };
  let links = 0;
  for (const group of cone.groups) {
    group.length = linksInView(group.all, xs, ys, view, group.seen);
    links += group.length / 2;
  }
  for (const group of cone.traced) group.length = linksInView(group.all, xs, ys, view, group.seen);

  if (big && !moving) {
    const step = Math.max(1, links / STILL_LINKS);
    buildSharp(ctx, canvas, scale, width, height, step, () => drawOverlay(ctx, shape, frame, spin, seen, rings, nodes, false));
    return;
  }

  const now = performance.now();
  if (moving && big) spinLinks = adjustDetail(spinLinks, now - lastMove);
  lastMove = now;
  const step = moving ? Math.max(1, links / spinLinks) : 1;
  const weight = Math.sqrt(step);
  fitCanvas(canvas, width, height, scale);
  aimContext(ctx, scale);
  ctx.lineWidth = 0.6 / lens.zoom;
  for (const [alpha, front] of lineLayers()) {
    ctx.globalAlpha = Math.min(1, alpha * weight);
    for (const group of cone.groups) {
      ctx.strokeStyle = cssVar(group.style);
      strokeLayer(ctx, group, front, step);
    }
  }
  drawOverlay(ctx, shape, frame, spin, seen, rings, nodes, moving);
}

// Lanes to turn per pixel dragged, so the front of the cone follows the pointer.
function coneLanesPerPx(frame) {
  const box = $('cone-canvas').parentElement;
  return frame.sideLanes / (TAU * coneShape(box.clientWidth, box.clientHeight).radius * lens.zoom);
}

// Scroll or pinch to zoom at the pointer, and drag up or down to pan. Dragging
// sideways is left to the spin.
function initConeZoom(redraw) {
  const canvas = $('cone-canvas');
  const local = (e) => {
    const box = canvas.getBoundingClientRect();
    return [e.clientX - box.left, e.clientY - box.top];
  };
  const middle = () => [canvas.clientWidth / 2, canvas.clientHeight / 2];
  const zoomBy = (factor, x, y) => { zoomAt(lens.zoom * factor, x, y); redraw(); };

  canvas.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) < Math.abs(e.deltaX)) return;
    e.preventDefault();
    zoomBy(Math.exp(-e.deltaY * (e.ctrlKey ? PINCH_ZOOM : WHEEL_ZOOM)), ...local(e));
  }, { passive: false });

  let lastY = null;
  canvas.addEventListener('pointerdown', (e) => { lastY = e.clientY; });
  canvas.addEventListener('pointermove', (e) => {
    if (lastY === null || lens.zoom === 1) return;
    lens.y += e.clientY - lastY;
    lastY = e.clientY;
    redraw();
  });
  for (const end of ['pointerup', 'pointercancel']) canvas.addEventListener(end, () => { lastY = null; });

  const reset = () => zoomBy(1 / lens.zoom, 0, 0);
  canvas.addEventListener('dblclick', reset);
  $('cone-zoom-reset').addEventListener('click', reset);
  $('cone-zoom-in').addEventListener('click', () => zoomBy(ZOOM_STEP, ...middle()));
  $('cone-zoom-out').addEventListener('click', () => zoomBy(1 / ZOOM_STEP, ...middle()));
}
