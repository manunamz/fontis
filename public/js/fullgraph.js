/*
 * fullgraph.js — the entire commit graph fitted to one screen, with a band
 * marking the window of lanes the table is showing.
 */
'use strict';

const FULL_PAD = 10;
const DIM_ALPHA = 0.3;
const EDGE_ALPHA = 0.8;

let fullBase = null; // the drawn graph, reused while only the band moves
let fullBaseFor = null;

function fullScale(layout, width, height) {
  const lanes = Math.max(layout.lanes - 1, 1);
  const rows = Math.max(layout.rows.length - 1, 1);
  return {
    x: (lane) => FULL_PAD + lane * (width - FULL_PAD * 2) / lanes,
    y: (row) => FULL_PAD + row * (height - FULL_PAD * 2) / rows,
  };
}

function traceEdge(ctx, e, { x, y }) {
  ctx.moveTo(x(e.fromLane), y(e.from));
  if (e.to === e.from + 1) { ctx.lineTo(x(e.toLane), y(e.to)); return; }
  ctx.lineTo(x(e.via), y(e.from + 1));
  ctx.lineTo(x(e.via), y(e.to - 1));
  ctx.lineTo(x(e.toLane), y(e.to));
}

function edgeStyle(e, nodes) {
  if (nodes[e.parent].missing) return '--red';
  if (e.suspect) return '--yellow';
  if (e.join) return '--edge-quiet';
  return `--lane-${colorIndex(e.color)}`;
}

function drawFullBase(layout, nodes, width, height, scale) {
  const base = document.createElement('canvas');
  base.width = width * scale;
  base.height = height * scale;
  const ctx = base.getContext('2d');
  ctx.scale(scale, scale);
  ctx.lineWidth = 0.7;
  const at = fullScale(layout, width, height);

  const groups = new Map();
  for (const e of layout.edges) {
    const style = edgeStyle(e, nodes);
    if (!groups.has(style)) groups.set(style, []);
    groups.get(style).push(e);
  }
  ctx.globalAlpha = EDGE_ALPHA;
  for (const [style, edges] of groups) {
    ctx.strokeStyle = cssVar(style);
    ctx.beginPath();
    for (const e of edges) traceEdge(ctx, e, at);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = cssVar('--fg');
  for (const row of layout.rows) ctx.fillRect(at.x(row.lane) - 0.5, at.y(row.row) - 0.5, 1, 1);
  return base;
}

// Each stretch of the window as [firstLane, lastLane]; it wraps past the far edge.
function windowSpans({ offset, lanes, sideLanes }) {
  const width = lanes - 1;
  const last = offset + width;
  return last <= sideLanes ? [[offset + 1, last]] : [[offset + 1, sideLanes], [1, last - sideLanes]];
}

function drawFullGraph(layout, nodes, frame) {
  const canvas = $('full-canvas');
  const box = canvas.parentElement;
  const width = box.clientWidth;
  const height = box.clientHeight;
  const scale = window.devicePixelRatio || 1;
  const key = `${width}x${height}x${document.documentElement.dataset.theme}`;
  if (fullBaseFor?.layout !== layout || fullBaseFor?.key !== key) {
    fullBase = drawFullBase(layout, nodes, width, height, scale);
    fullBaseFor = { layout, key };
  }
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.drawImage(fullBase, 0, 0, width, height);
  if (!frame.rotates) return;

  const at = fullScale(layout, width, height);
  const half = (at.x(1) - at.x(0)) / 2;
  const spans = windowSpans(frame).map(([a, b]) => [at.x(a) - half, at.x(b) + half]);
  const lit = [[0, at.x(0) + half], ...spans].sort((a, b) => a[0] - b[0]);

  ctx.fillStyle = cssVar('--bg');
  ctx.globalAlpha = DIM_ALPHA;
  let edge = 0;
  for (const [from, to] of lit) {
    if (from > edge) ctx.fillRect(edge, 0, from - edge, height);
    edge = Math.max(edge, to);
  }
  if (edge < width) ctx.fillRect(edge, 0, width - edge, height);
  ctx.globalAlpha = 1;

  ctx.strokeStyle = cssVar('--accent');
  ctx.lineWidth = 1.5;
  for (const [from, to] of spans) ctx.strokeRect(from, 0.75, to - from, height - 1.5);
}

// The rotation that puts the band's middle under a point on the canvas.
function offsetAtPoint(x, width, frame) {
  const fraction = (x - FULL_PAD) / (width - FULL_PAD * 2);
  const lane = Math.round(fraction * frame.sideLanes);
  return lane - Math.floor((frame.lanes - 1) / 2);
}
