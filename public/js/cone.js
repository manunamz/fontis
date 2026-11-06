/*
 * cone.js — the entire graph as a cone spinning on the spine. The seed is the
 * tip, the rows run down it, and each lane is a position around it, so the
 * table is the strip of the cone that's facing you, rolled flat.
 */
'use strict';

const CONE_TILT = 0.3;
const CONE_DEPTH = 0.3; // how much nearer the front is drawn than the back
const CONE_PAD = 26;
const BACK_ALPHA = 0.1;
const FRONT_ALPHA = 0.3;
const TREAD_STEPS = 8; // line segments per sector of the rim
const SIGHT_REACH = 7; // px the marker for the rows in view overhangs the strip
const TAU = Math.PI * 2;
const MAX_ZOOM = 16;
const ZOOM_STEP = 1.5; // per button press
const WHEEL_ZOOM = 0.002; // per pixel scrolled
const PINCH_ZOOM = 0.01; // per pixel pinched, which reports far smaller deltas
const DOTS_FROM_ZOOM = 2; // from here on, the front's papers are drawn too
const MAX_CLARITY = 2; // how far zooming in can brighten the lines

let cone = null;
const lens = { zoom: 1, x: 0, y: 0 };

const sectorStyle = (sector) => `--lane-${1 + sector % SIDE_COLORS}`;

function edgeStyle(e, rows, nodes) {
  if (nodes[e.parent].missing) return '--red';
  if (e.suspect) return '--yellow';
  if (e.fromLane === 0 && e.toLane === 0) return '--lane-0';
  const [child, parent] = [rows[e.from], rows[e.to]];
  return child.sector === parent.sector || child.lane === 0 ? sectorStyle(parent.sector) : '--edge-quiet';
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
  const groups = new Map();
  for (const e of layout.edges) {
    const style = edgeStyle(e, layout.rows, nodes);
    if (!groups.has(style)) groups.set(style, []);
    groups.get(style).push(e.from, e.to);
  }
  return { layout, angle, drop, lane, groups, side };
}

function coneShape(width, height) {
  const tall = height - CONE_PAD * 2;
  const radius = Math.min(width / 2 - CONE_PAD, tall * 0.55);
  const length = tall - radius * Math.sin(CONE_TILT) * 2;
  return { radius, length, cx: width / 2, top: CONE_PAD };
}

// Screen position of a point on the cone, plus how far towards you it is (-1 to 1).
function conePoint(shape, theta, drop) {
  const { radius, length, cx, top } = shape;
  const x = Math.sin(theta) * drop;
  const near = Math.cos(theta) * drop;
  const scale = 1 + near * CONE_DEPTH;
  return {
    x: cx + x * radius * scale,
    y: top + drop * length * Math.cos(CONE_TILT) + near * radius * Math.sin(CONE_TILT),
    near,
  };
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

function strokeEdges(ctx, pairs, xs, ys, keep) {
  ctx.beginPath();
  for (let i = 0; i < pairs.length; i += 2) {
    const [a, b] = [pairs[i], pairs[i + 1]];
    if (!keep(a, b)) continue;
    ctx.moveTo(xs[a], ys[a]);
    ctx.lineTo(xs[b], ys[b]);
  }
  ctx.stroke();
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

function drawCone(layout, nodes, frame, turn, seen) {
  if (cone?.layout !== layout) cone = buildCone(layout, nodes);
  const canvas = $('cone-canvas');
  const box = canvas.parentElement;
  const width = box.clientWidth;
  const height = box.clientHeight;
  const scale = window.devicePixelRatio || 1;
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  clampLens(width, height);
  ctx.translate(lens.x, lens.y);
  ctx.scale(lens.zoom, lens.zoom);

  const shape = coneShape(width, height);
  const count = layout.rows.length;
  const spin = (turn + (frame.lanes - 1) / 2) / cone.side * TAU;
  const xs = new Float32Array(count);
  const ys = new Float32Array(count);
  const nears = new Float32Array(count);
  const lit = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const point = conePoint(shape, cone.angle[i] - spin, cone.drop[i]);
    xs[i] = cone.lane[i] === 0 ? shape.cx : point.x;
    ys[i] = point.y;
    nears[i] = cone.lane[i] === 0 ? 0 : point.near;
    lit[i] = cone.lane[i] === 0 || frame.kept.has(i) || (cone.lane[i] - 1 - frame.offset + cone.side) % cone.side < frame.lanes - 1 ? 1 : 0;
  }

  // Lines stay thin as they spread apart, so they can afford to brighten.
  const clarity = Math.min(MAX_CLARITY, Math.sqrt(lens.zoom));
  ctx.lineWidth = 0.6 / lens.zoom;
  const layers = [
    [BACK_ALPHA, (a, b) => nears[a] + nears[b] < 0],
    [FRONT_ALPHA * clarity, (a, b) => nears[a] + nears[b] >= 0],
  ];
  for (const [alpha, keep] of layers) {
    ctx.globalAlpha = alpha;
    for (const [style, pairs] of cone.groups) {
      ctx.strokeStyle = cssVar(style);
      strokeEdges(ctx, pairs, xs, ys, keep);
    }
  }
  drawTread(ctx, shape, layout, spin);

  ctx.lineWidth = 1.2 / lens.zoom;
  for (const [style, pairs] of cone.groups) {
    ctx.strokeStyle = cssVar(style);
    strokeEdges(ctx, pairs, xs, ys, (a, b) => lit[a] && lit[b]);
  }
  ctx.fillStyle = cssVar('--fg');
  const dot = 2.5 / lens.zoom;
  for (let i = 0; i < count; i++) {
    if (lit[i]) continue;
    if (lens.zoom >= DOTS_FROM_ZOOM && nears[i] >= 0) ctx.fillRect(xs[i] - dot / 4, ys[i] - dot / 4, dot / 2, dot / 2);
  }
  for (let i = 0; i < count; i++) {
    if (lit[i]) ctx.fillRect(xs[i] - dot / 2, ys[i] - dot / 2, dot, dot);
  }
  if (frame.rotates) drawStrip(ctx, shape, frame, spin, seen);
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
