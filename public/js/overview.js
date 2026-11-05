/*
 * overview.js — the whole tree at once: one dot per paper, by depth and year.
 */
'use strict';

const BAND_H = 30;
const LABEL_W = 86;
const NO_DATE_W = 48;
const OLDEST_YEAR = 1900;
const DOT = 2;
const HIT_RADIUS = 7;
const STATUS_LABELS = ['has references', 'no recorded refs', 'dead ID', 'retracted'];

let tree = null;
let onPick = null;
let dots = [];
let grid = new Map();

// Stable jitter, so a dot sits in the same place on every redraw.
const jitter = (i) => ((i * 2654435761) >>> 0) / 4294967296;
const jitterX = (i) => ((i * 1597334677) >>> 0) / 4294967296;

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function yearToX(year, width, seedYear) {
  const plot = width - LABEL_W - NO_DATE_W;
  const clamped = Math.min(Math.max(year, OLDEST_YEAR), seedYear);
  return LABEL_W + plot * (clamped - OLDEST_YEAR) / (seedYear - OLDEST_YEAR);
}

function placeDots(width, seedYear) {
  dots = [];
  grid = new Map();
  for (let i = 0; i < tree.years.length; i++) {
    const year = tree.years[i];
    // Papers only have a year, so spread each year's dots across its width.
    const x = year
      ? yearToX(year + jitterX(i) - 0.5, width, seedYear)
      : width - NO_DATE_W / 2 + (jitterX(i) - 0.5) * NO_DATE_W * 0.7;
    const y = tree.depths[i] * BAND_H + 4 + jitter(i) * (BAND_H - 8);
    dots.push({ x, y, i });
    const key = `${Math.floor(x / HIT_RADIUS)},${Math.floor(y / HIT_RADIUS)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(i);
  }
}

function drawAxes(ctx, width, height, seedYear, levels) {
  ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.fillStyle = cssVar('--fg-dim');
  ctx.strokeStyle = cssVar('--border');
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText('seed', 0, BAND_H / 2);
  for (const { depth, papers } of levels) {
    ctx.fillText(`depth ${depth}: ${papers.toLocaleString()}`, 0, depth * BAND_H + BAND_H / 2);
    ctx.beginPath();
    ctx.moveTo(LABEL_W, depth * BAND_H + 0.5);
    ctx.lineTo(width, depth * BAND_H + 0.5);
    ctx.stroke();
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  for (let year = OLDEST_YEAR; year <= seedYear; year += 20) {
    ctx.fillText(year === OLDEST_YEAR ? '≤1900' : String(year), yearToX(year, width, seedYear), height - 3);
  }
  ctx.fillText('no date', width - NO_DATE_W / 2, height - 3);
}

function drawOverview() {
  if (!tree) return;
  const canvas = $('tree-canvas');
  const width = canvas.parentElement.clientWidth;
  const bands = tree.levels.length + 1;
  const height = bands * BAND_H + 16;
  const scale = window.devicePixelRatio || 1;
  canvas.width = width * scale;
  canvas.height = height * scale;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);

  const seedYear = tree.years[0];
  placeDots(width, seedYear);
  drawAxes(ctx, width, height, seedYear, tree.levels);

  const colors = [cssVar('--lane-1'), cssVar('--yellow'), cssVar('--red'), cssVar('--red')];
  ctx.globalAlpha = dots.length > 20000 ? 0.4 : 0.65;
  for (const status of [0, 1, 2, 3]) { // the trail's ends draw last, on top
    ctx.fillStyle = colors[status];
    for (const { x, y, i } of dots) {
      if (tree.statuses[i] === status) ctx.fillRect(x - DOT / 2, y - DOT / 2, DOT, DOT);
    }
  }
  ctx.globalAlpha = 1;
}

function dotAt(x, y) {
  const cx = Math.floor(x / HIT_RADIUS);
  const cy = Math.floor(y / HIT_RADIUS);
  let best = null;
  let bestDist = HIT_RADIUS * HIT_RADIUS;
  for (let i = cx - 1; i <= cx + 1; i++) {
    for (let j = cy - 1; j <= cy + 1; j++) {
      for (const index of grid.get(`${i},${j}`) || []) {
        const dot = dots[index];
        const dist = (dot.x - x) ** 2 + (dot.y - y) ** 2;
        if (dist < bestDist) { bestDist = dist; best = index; }
      }
    }
  }
  return best;
}

function describeDot(i) {
  const year = tree.years[i] || 'no date';
  const opens = i < tree.ids.length && tree.statuses[i] !== 2 ? ' · click to open it in the graph' : '';
  return `${year} · depth ${tree.depths[i]} · ${STATUS_LABELS[tree.statuses[i]]}${opens}`;
}

function renderOverviewStats() {
  const total = tree.levels.reduce((sum, l) => sum + l.papers, 0);
  const dead = tree.levels.reduce((sum, l) => sum + l.dead, 0);
  const zero = tree.levels.reduce((sum, l) => sum + l.zeroRefs, 0);
  const stats = $('overview-stats');
  stats.replaceChildren(
    el('strong', null, `${total.toLocaleString()} papers measured to depth ${tree.levels.length}`),
    el('span', 'stat-dead', `${dead.toLocaleString()} dead IDs`),
    el('span', 'stat-root', `${zero.toLocaleString()} with no recorded refs`),
  );
}

function initOverview(data, pick) {
  tree = data;
  onPick = pick;
  $('overview').hidden = false;
  renderOverviewStats();
  drawOverview();

  const canvas = $('tree-canvas');
  const hint = $('overview-hint');
  const resting = hint.textContent;
  const at = (e) => {
    const box = canvas.getBoundingClientRect();
    return dotAt(e.clientX - box.left, e.clientY - box.top);
  };
  canvas.addEventListener('mousemove', (e) => {
    const i = at(e);
    hint.textContent = i == null ? resting : describeDot(i);
  });
  canvas.addEventListener('mouseleave', () => { hint.textContent = resting; });
  canvas.addEventListener('click', (e) => {
    const i = at(e);
    if (i != null && i < tree.ids.length && tree.statuses[i] !== 2) onPick(tree.ids[i]);
  });
  new ResizeObserver(drawOverview).observe(canvas.parentElement);
}
