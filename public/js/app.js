/*
 * app.js — load a snapshot and render the overview and rotating commit graph.
 */
'use strict';

const PAPERS = [
  { slug: 'attention', seed: 'W2626778328', label: 'Attention Is All You Need' },
  { slug: 'watson-crick', seed: 'W2126466006', label: 'Watson–Crick 1953' },
  { slug: 'alphafold', seed: 'W3177828909', label: 'AlphaFold 2021' },
  { slug: 'crispr', seed: 'W2045435533', label: 'CRISPR 2012' },
  { slug: 'hallmarks', seed: 'W2117692326', label: 'Hallmarks of Cancer 2011' },
  { slug: 'graphene', seed: 'W2058122340', label: 'Graphene 2004' },
  { slug: 'ligo', seed: 'W2252795400', label: 'Gravitational Waves 2016' },
  { slug: 'black-scholes', seed: 'W2077791698', label: 'Black–Scholes 1973' },
  { slug: 'weak-ties', seed: 'W2109469951', label: 'The Strength of Weak Ties' },
  { slug: 'greenberg', seed: 'W2023155726', label: 'Citation Distortions 2009' },
];
const $ = (id) => document.getElementById(id);

const MIN_WINDOW = 6;
const MAX_WINDOW = 24;
const GRAPH_SHARE = 0.36; // of the table's width
const SPIN_FRICTION = 0.94;
const SPIN_STOP = 0.002; // lanes per ms
const SPIN_HOP_MS = 700;
const SLIDE_MS = 320;
const SLIDE_REACH = 1.5; // viewports: further than this a row fades in instead
const FLY_MS = 520;
const FLY_BEND = -60; // px the dot's path bows towards the graph
const TABLE_MS = 150; // how often a spinning cone refreshes the table

let paper = null;
let snapshot = null;
let view = null;
let layout = null;
let frame = null; // the rotated window onto `layout`
let table = null; // `frame` as the table draws it
let frontier = new Set();
let childCount = new Map();
let suspectsOf = new Map();
let hiddenRefs = new Map();
let selected = null;
let cameFrom = []; // papers hopped from, most recent last
let offset = 0;
let paintQueued = false;
let paintedLayout = null;
let holdTable = false; // a spin to a paper leaves the table alone until it stops
let selectRun = 0; // a newer selection abandons an older one's animation
let closeGaps = true;
let settle = null; // the full draw waiting for the cone to stop
let tablePainted = 0;
let tableBehind = false;
let pinned = false; // the table stays put while the cone turns on its own
let coneTurn = 0; // where the cone faces while pinned, in lanes like `offset`
const expanded = new Set();

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function formatCount(n) {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

function byline(node) {
  if (!node.authors || !node.authors.length) return 'unknown authors';
  const extra = node.authorCount - node.authors.length;
  return node.authors.join(', ') + (extra > 0 ? ` +${extra} more` : '');
}

function badge(text, kind) {
  return el('span', `badge badge-${kind}`, text);
}

function link(href, text) {
  const a = el('a', null, text);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener';
  return a;
}

function renderHead() {
  const seed = snapshot.nodes[snapshot.seed];
  const dead = seed.dead.length;
  const head = $('paper-head');
  head.replaceChildren(
    el('h1', null, seed.title),
    el('p', 'byline', `${byline(seed)} · ${seed.year}`),
  );
  const stats = el('p', 'stats');
  stats.append(
    el('span', null, `${seed.refCount} references`),
    el('span', null, `${seed.resolvedCount} resolve`),
    el('span', dead ? 'stat-dead' : null, `${dead} dead`),
    el('span', null, `${formatCount(seed.cited)} citations`),
  );
  head.append(stats);
}

function renderPills(nav) {
  for (const paper of PAPERS) {
    const a = el('a', null, paper.label);
    a.href = `?paper=${paper.slug}`;
    nav.append(a);
  }
}

// A snapshot decides how deep the view can go, and opens at its deepest.
function fillDepthOptions() {
  const select = $('depth');
  for (const { depth } of snapshot.levels.filter((l) => l.depth <= snapshot.detail)) {
    const option = el('option', null, String(depth));
    option.value = depth;
    select.append(option);
  }
  select.value = snapshot.detail;
}

function currentOptions() {
  return {
    depth: Number($('depth').value),
    parents: Number($('parents').value),
    showDead: $('dead').checked,
    expanded,
  };
}

function deadLabel(node) {
  const n = node.deadIds.length;
  return n === 1 ? '1 reference not found' : `${n} references not found`;
}

function suspectChildren(id) {
  return (suspectsOf.get(id) || []).map((child) => view.nodes[child]);
}

function rowBadges(node, children) {
  const out = [];
  if (node.missing) out.push(badge('404 in OpenAlex', 'dead'));
  if (node.retracted) out.push(badge('retracted', 'dead'));
  if (!node.missing && node.refCount === 0) out.push(badge('no recorded refs', 'root'));
  if (suspectChildren(node.id).length) out.push(badge('dated after citer', 'suspect'));
  if (children > 1) out.push(badge(`shared ×${children}`, 'shared'));
  return out;
}

// The first load only has each paper's top references; the rest arrive on demand.
async function ensureFull() {
  if (!snapshot.partial) return;
  if (paper.full) { snapshot = paper.full; return; }
  $('log-more').hidden = false;
  $('log-more').textContent = 'Loading every paper…';
  const res = await fetch(`snapshots/${paper.slug}.full.json`);
  if (!res.ok) throw new Error(res.status);
  snapshot = await res.json();
}

async function withFull(action) {
  try {
    await ensureFull();
  } catch {
    $('log-more').textContent = 'Could not load the full data.';
    return;
  }
  action();
}

function toggleExpanded(id) {
  withFull(() => {
    if (!expanded.delete(id)) expanded.add(id);
    selected = id;
    render();
  });
}

function setShowAll(on) {
  expanded.clear();
  if (on) {
    for (const node of Object.values(snapshot.nodes)) if (node.parents.length) expanded.add(node.id);
  }
  $('show-all').dataset.on = on ? 'yes' : 'no';
  $('show-all').textContent = on ? 'collapse all' : 'show all';
}

function toggleShowAll() {
  const on = $('show-all').dataset.on !== 'yes';
  withFull(() => {
    setShowAll(on);
    render();
  });
}

// Open a paper from the overview: expand the shortest line down to it.
function reveal(id) {
  withFull(() => {
    const from = new Map([[snapshot.seed, null]]);
    const queue = [snapshot.seed];
    for (let i = 0; i < queue.length && !from.has(id); i++) {
      for (const parent of snapshot.nodes[queue[i]].parents) {
        if (!from.has(parent) && snapshot.nodes[parent]) { from.set(parent, queue[i]); queue.push(parent); }
      }
    }
    for (let at = from.get(id); at; at = from.get(at)) expanded.add(at);
    render();
    select(id);
    document.querySelector(`.log-row[data-id="${id}"]`)?.scrollIntoView({ block: 'center' });
  });
}

function expandButton(id, hidden) {
  const open = expanded.has(id);
  if (!open && hidden <= 0) return null;
  const btn = el('button', 'expand', open ? '−' : `+${hidden}`);
  btn.type = 'button';
  btn.title = open ? 'show only the top references' : 'show all of its resolved references';
  btn.addEventListener('click', (e) => { e.stopPropagation(); toggleExpanded(id); });
  return btn;
}

function renderRow(row) {
  const node = view.nodes[row.id];
  const children = childCount.get(row.id) || 0;
  const item = el('div', 'log-row');
  item.tabIndex = 0;
  item.setAttribute('role', 'button');
  item.dataset.id = row.id;
  item.style.top = `${row.row * ROW_H}px`;
  item.title = node.missing ? deadLabel(node) : `${node.title} (${node.year || 'n.d.'})`;
  if (row.id === snapshot.seed) item.classList.add('is-seed');
  if (node.missing) item.classList.add('is-dead');

  const msg = el('span', 'c-msg');
  msg.append(el('span', 'title', node.missing ? deadLabel(node) : node.title), ...rowBadges(node, children));
  const expand = expandButton(row.id, hiddenRefs.get(row.id));
  if (expand) msg.append(expand);
  item.append(
    el('span', 'c-graph'),
    msg,
    el('span', 'c-field', node.field || ''),
    el('span', 'c-num', node.missing ? '' : String(node.refCount)),
    el('span', 'c-num', node.missing ? '' : formatCount(node.cited)),
    el('span', 'c-year', node.year || ''),
  );
  const toggle = () => {
    cameFrom = [];
    select(selected === row.id ? null : row.id);
  };
  item.addEventListener('click', toggle);
  item.addEventListener('keydown', (e) => {
    if (e.target === item && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggle(); }
  });
  return item;
}

function indexLayout() {
  frontier = new Set(Lineage.frontier(layout, view.nodes).map((r) => r.id));
  hiddenRefs = Lineage.hiddenParents(view);
  childCount = new Map();
  suspectsOf = new Map();
  for (const e of layout.edges) {
    childCount.set(e.parent, (childCount.get(e.parent) || 0) + 1);
    if (!e.suspect) continue;
    if (!suspectsOf.has(e.parent)) suspectsOf.set(e.parent, []);
    suspectsOf.get(e.parent).push(e.child);
  }
}

function render() {
  view = Lineage.select(snapshot, currentOptions());
  layout = Lineage.layout(view.ids, view.edges, view.nodes, { grouped: isConeView() });
  if (selected && !view.ids.includes(selected)) selected = null;
  cameFrom = cameFrom.filter((id) => view.ids.includes(id));
  indexLayout();
  paint();
  renderSource();
}

const isConeView = () => document.body.classList.contains('cone-view');

function windowWidth() {
  const room = $('log').clientWidth * GRAPH_SHARE - GRAPH_PAD * 2;
  return Math.min(MAX_WINDOW, Math.max(MIN_WINDOW, Math.floor(room / LANE_W)));
}

// The stretch of the cone's height scrolled into view in the table.
function rowsInSight() {
  const scroller = $('log-scroll');
  const end = Math.max(layout.rows.length - 1, 1);
  const last = table.rows.length - 1;
  const at = (px) => {
    const row = Math.floor(px / ROW_H);
    return (closeGaps ? table.rows[Math.max(0, Math.min(last, row))].from : Math.min(row, end)) / end;
  };
  return { from: at(scroller.scrollTop), to: at(scroller.scrollTop + scroller.clientHeight) };
}

// Redraw the window. Cheap compared with `render`, so turning the graph is live.
// `offset` can sit between lanes; the cone shows that, and the table rounds it.
function paint() {
  const previous = frame;
  const keep = selected ? Lineage.connections(selected, layout.edges) : new Set();
  if (previousPaper()) keep.add(previousPaper());
  frame = Lineage.windowView(layout, { offset: Math.round(offset), width: windowWidth(), keep });
  offset = frame.rotates ? ((offset % frame.sideLanes) + frame.sideLanes) % frame.sideLanes : 0;
  renderRotator();
  const moved = previous?.offset !== frame.offset || previous?.lanes !== frame.lanes;
  // Rebuilding the table is the slow part of a turn, so a spin only catches it up now and then.
  const early = paintedLayout === layout && performance.now() - tablePainted < TABLE_MS;
  if (moved) tableBehind = true;
  if (isConeView() && paintedLayout === layout && (!moved || early || holdTable)) {
    paintCone();
    return;
  }
  paintTable();
  if (isConeView()) paintCone();
}

function paintTable() {
  paintedLayout = layout;
  tablePainted = performance.now();
  tableBehind = false;
  // A window fills few rows of a wide graph, so by default the gaps close up.
  table = closeGaps ? Lineage.compactRows(frame) : frame;
  document.documentElement.style.setProperty('--graph-w', `${graphWidth(frame.drawnLanes)}px`);
  const body = $('log-body');
  body.style.height = `${table.totalRows * ROW_H}px`;
  body.replaceChildren(drawGraph(table, view.nodes, snapshot.seed, frontier), ...table.rows.map(renderRow));
  applySelection();
  renderMore();
}

// Draws quickly while the cone is moving, then in full once it stops.
function paintCone() {
  const draw = (moving) => {
    const ring = (id, strong) => {
      const row = Lineage.findRow(layout, id);
      return row ? [{ row: row.row, strong }] : [];
    };
    const rings = [...ring(previousPaper(), false), ...ring(selected, true)];
    drawCone(layout, view.nodes, frame, pinned ? coneTurn : offset, rowsInSight(), rings, selectedTrail(), moving);
  };
  draw(true);
  clearTimeout(settle);
  settle = setTimeout(() => {
    if (!isConeView()) return;
    if (tableBehind && !holdTable) paintTable();
    draw(false);
  }, SETTLE_MS);
}

function setConeView(on) {
  withFull(() => {
    if (on) setShowAll(true);
    document.body.classList.toggle('cone-view', on);
    $('cone').hidden = !on;
    offset = 0;
    coneTurn = 0;
    window.scrollTo(0, 0);
    render();
  });
}

function toggleGaps() {
  closeGaps = !closeGaps;
  $('cone-gaps').textContent = closeGaps ? 'fixed rows' : 'close gaps';
  paintedLayout = null;
  paint();
}

function queuePaint() {
  if (paintQueued) return;
  paintQueued = true;
  requestAnimationFrame(() => { paintQueued = false; paint(); });
}

function turnTo(next) {
  offset = next;
  queuePaint();
}

// Turn only the cone. The table's strip moves round it, still marking what the table shows.
function turnCone(next) {
  coneTurn = frame.rotates ? ((next % frame.sideLanes) + frame.sideLanes) % frame.sideLanes : 0;
  if (paintQueued) return;
  paintQueued = true;
  requestAnimationFrame(() => { paintQueued = false; paintCone(); });
}

// Unpinning brings the table round to where the cone was left facing.
function setPinned(on) {
  pinned = on;
  $('cone-pin').setAttribute('aria-pressed', on);
  if (on) coneTurn = offset;
  else turnTo(coneTurn);
}

// The line of descent at the middle of the window.
function frontSector() {
  const middle = (frame.offset + Math.floor((frame.lanes - 1) / 2)) % frame.sideLanes + 1;
  return layout.sectors.find((s) => s.first != null && s.first <= middle && middle <= s.last);
}

function renderRotator() {
  const { rotates, sideLanes } = frame;
  $('rotator').classList.toggle('still', !rotates);
  $('cone-pin').hidden = !rotates;
  $('log-body').classList.toggle('rotates', rotates);
  if (!rotates) {
    $('spin-label').textContent = `all ${sideLanes + 1} lanes · ${layout.rows.length.toLocaleString()} rows`;
    return;
  }
  const spin = $('spin');
  spin.max = sideLanes - 1;
  spin.value = frame.offset;
  const front = frontSector();
  const name = front ? `${view.nodes[front.id].title} · ${front.papers.toLocaleString()} papers · ` : '';
  $('spin-label').textContent = `${name}${frame.rows.length.toLocaleString()} of ${layout.rows.length.toLocaleString()} rows filled`;
  $('spin-label').title = name;
}

function renderMore() {
  const { depth } = currentOptions();
  const hidden = Lineage.hiddenCount(view, snapshot, depth);
  const more = $('log-more');
  more.hidden = hidden === 0;
  more.textContent = `+${hidden.toLocaleString()} earlier ${hidden === 1 ? 'paper' : 'papers'} to depth ${depth} not drawn`;
}

function renderSource() {
  const cycles = layout.cut.length;
  const suspects = layout.edges.filter((e) => e.suspect).length;
  const cycleNote = cycles ? ` ${cycles} citation ${cycles === 1 ? 'cycle' : 'cycles'} can't be drawn in a commit graph and ${cycles === 1 ? 'is' : 'are'} left out.` : '';
  const suspectNote = suspects ? ` ${suspects} ${suspects === 1 ? 'link points' : 'links point'} to a paper dated well after the one citing it.` : '';
  $('source').textContent = `Measured from ${snapshot.source} on ${snapshot.fetched}. Counts change as the database does.${cycleNote}${suspectNote}`;
}

const previousPaper = () => (selected ? cameFrom[cameFrom.length - 1] : undefined);

// The selected paper's whole line, kept while the selection and layout stay put,
// since a big tree's cone asks for it on every frame.
let traced = { id: null, layout: null, trail: null };
function selectedTrail() {
  if (!selected) return null;
  if (traced.id !== selected || traced.layout !== layout) {
    traced = { id: selected, layout, trail: Lineage.lineage(selected, layout.edges) };
  }
  return traced.trail;
}

function applySelection() {
  const body = $('log-body');
  const trail = selectedTrail();
  body.classList.toggle('tracing', !!trail);
  for (const row of body.querySelectorAll('.log-row')) {
    row.classList.toggle('on-trail', !!trail && trail.has(row.dataset.id));
    row.classList.toggle('is-selected', row.dataset.id === selected);
    const from = row.dataset.id === previousPaper();
    row.classList.toggle('came-from', from);
    row.querySelector('.badge-from')?.remove();
    if (from) row.querySelector('.c-msg').prepend(badge('came from here', 'from'));
  }
  for (const path of body.querySelectorAll('.edge')) {
    path.classList.toggle('on-trail', !!trail && trail.has(path.dataset.child) && trail.has(path.dataset.parent));
  }
  for (const mark of body.querySelectorAll('[data-id]:not(.log-row)')) {
    mark.classList.toggle('on-trail', !!trail && trail.has(mark.dataset.id));
    mark.classList.toggle('is-selected', mark.dataset.id === selected);
  }
  renderDetail();
}

const rowOf = (id) => document.querySelector(`.log-row[data-id="${id}"]`);
const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function rowTops() {
  const tops = new Map();
  for (const row of $('log-body').querySelectorAll('.log-row')) tops.set(row.dataset.id, row.getBoundingClientRect().top);
  return tops;
}

function ease(t) {
  return t < 0.5 ? 2 * t * t : 1 - (2 - 2 * t) ** 2 / 2;
}

// Turn the cone the short way round to `target`, leaving the table alone until it stops.
function spinTo(target, run, done) {
  const side = frame.sideLanes;
  const start = offset;
  const distance = ((target - start + side * 1.5) % side) - side / 2;
  const began = performance.now();
  holdTable = true;
  const step = (now) => {
    if (run !== selectRun) return;
    const t = Math.min(1, (now - began) / SPIN_HOP_MS);
    offset = start + distance * ease(t);
    paint();
    if (t < 1) requestAnimationFrame(step);
    else done();
  };
  requestAnimationFrame(step);
}

// Rows that survive a repaint slide from where they were, and new ones fade in.
function slideRows(before) {
  const reach = window.innerHeight * SLIDE_REACH;
  for (const row of $('log-body').querySelectorAll('.log-row')) {
    const top = row.getBoundingClientRect().top;
    if (top < -ROW_H || top > window.innerHeight) continue;
    const from = before.get(row.dataset.id);
    if (from !== undefined && Math.abs(from - top) < reach && from !== top) {
      row.animate([{ transform: `translateY(${from - top}px)` }, { transform: 'none' }], { duration: SLIDE_MS, easing: 'ease-in-out' });
    } else if (from === undefined || Math.abs(from - top) >= reach) {
      row.animate([{ opacity: 0 }, { opacity: 1 }], { duration: SLIDE_MS });
    }
  }
}

function crossfadeGraph(old) {
  const body = $('log-body');
  body.querySelector('.graph:not(.leaving)')?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: SLIDE_MS });
  if (!old) return;
  old.classList.add('leaving');
  body.append(old);
  old.animate([{ opacity: 1 }, { opacity: 0 }], { duration: SLIDE_MS }).onfinish = () => old.remove();
}

// A dot flies from the click to the paper, so the eye has something to follow.
function flyDot(from, id, done) {
  const mark = $('log-body').querySelector(`.graph:not(.leaving) [data-id="${id}"]`);
  if (!from || !mark) { done(); return; }
  const box = mark.getBoundingClientRect();
  const to = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  const dot = el('div', 'flyer');
  document.body.append(dot);
  const at = ({ x, y }) => `translate(${x}px, ${y}px)`;
  const bend = { x: (from.x + to.x) / 2 + FLY_BEND, y: (from.y + to.y) / 2 };
  dot.animate([{ transform: at(from) }, { transform: at(bend) }, { transform: at(to) }], { duration: FLY_MS, easing: 'ease-in-out' }).onfinish = () => {
    dot.remove();
    done();
  };
}

// Selecting a paper brings its connections into the table, so everything moves
// from where it was: the cone spins to the paper if it's out of view, rows
// slide, and a hop's dot flies to where it landed. `point` is where the hop began.
function select(id, point = null) {
  if (!id) cameFrom = [];
  const run = ++selectRun;
  const anchor = id || selected;
  const before = rowTops();
  const oldGraph = $('log-body').querySelector('.graph:not(.leaving)');
  selected = id;
  applySelection();

  const row = id && Lineage.findRow(layout, id);
  const needsTurn = row && !frame.rows.some((r) => r.id === id);
  const target = needsTurn ? Lineage.offsetFor(row.lane, { width: frame.lanes - 1, sideLanes: frame.sideLanes }) : offset;

  const settle = () => {
    if (run !== selectRun) return;
    holdTable = false;
    offset = target;
    paintedLayout = null;
    paint();
    const landed = id && rowOf(id);
    const held = before.get(anchor);
    const scroller = isConeView() ? $('log-scroll') : null;
    if (held !== undefined && rowOf(anchor)) {
      const shift = rowOf(anchor).getBoundingClientRect().top - held;
      if (scroller) scroller.scrollTop += shift;
      else window.scrollBy(0, shift);
    }
    const top = landed?.getBoundingClientRect().top;
    if (landed && (top < 0 || top > window.innerHeight - ROW_H)) landed.scrollIntoView({ block: 'center' });
    const pulse = () => { if (run === selectRun) rowOf(id)?.classList.add('just-selected'); };
    if (calm()) { pulse(); return; }
    slideRows(before);
    crossfadeGraph(oldGraph);
    flyDot(point, id, pulse);
  };

  if (needsTurn && isConeView() && !calm()) spinTo(target, run, settle);
  else settle();
}

// Follow a link to another paper, remembering the way back.
function hopTo(id, from, point) {
  if (from && from !== id) cameFrom.push(from);
  select(id, point);
}

function hopBack(e) {
  select(cameFrom.pop(), { x: e.clientX, y: e.clientY });
}

function fact(label, value) {
  const row = el('div', 'fact');
  row.append(el('dt', null, label), el('dd', null, value));
  return row;
}

function paperList(papers) {
  const list = el('ul', 'parents');
  for (const p of papers) {
    const li = el('li');
    const btn = el('button', 'linklike', p.missing ? deadLabel(p) : p.title);
    btn.type = 'button';
    btn.addEventListener('click', (e) => hopTo(p.id, selected, { x: e.clientX, y: e.clientY }));
    li.append(btn);
    list.append(li);
  }
  return list;
}

// Direct links only where the snapshot holds the id. Semantic Scholar and Google
// Scholar search by title, so they work for any paper.
function paperLinks(node) {
  const query = encodeURIComponent(node.title);
  const out = [[`https://openalex.org/${node.id}`, 'OpenAlex']];
  if (node.doi) out.push([`https://doi.org/${node.doi}`, 'DOI']);
  if (node.arxiv) out.push([`https://arxiv.org/abs/${node.arxiv}`, 'arXiv']);
  if (node.pmid) out.push([`https://pubmed.ncbi.nlm.nih.gov/${node.pmid}/`, 'PubMed']);
  if (node.pmcid) out.push([`https://pmc.ncbi.nlm.nih.gov/articles/PMC${node.pmcid}/`, 'PMC']);
  out.push([`https://www.semanticscholar.org/search?q=${query}`, 'Semantic Scholar']);
  out.push([`https://scholar.google.com/scholar?q=${query}`, 'Google Scholar']);
  return out;
}

function backLink() {
  const node = view.nodes[previousPaper()];
  const btn = el('button', 'linklike back-link', `← back to ${node.missing ? deadLabel(node) : node.title}`);
  btn.type = 'button';
  btn.addEventListener('click', hopBack);
  return btn;
}

function renderDetail() {
  fillDetail();
  if (previousPaper()) $('detail').prepend(backLink());
}

function fillDetail() {
  const pane = $('detail');
  if (!selected) {
    pane.replaceChildren(
      el('h2', null, 'Trace a line'),
      el('p', 'muted', 'Select a paper to light up everything it descends from and everything that leads back to the seed.'),
    );
    return;
  }
  const node = view.nodes[selected];
  if (node.missing) {
    const citedBy = layout.edges.find((e) => e.parent === selected).child;
    const ids = el('ul', 'dead-ids');
    for (const id of node.deadIds) ids.append(el('li', null, id));
    pane.replaceChildren(
      el('h2', null, deadLabel(node)),
      el('p', 'muted', `OpenAlex lists these as references of “${view.nodes[citedBy].title}”, but their records return 404. The works may well exist elsewhere. These links don't lead anywhere.`),
      ids,
    );
    return;
  }

  const facts = el('dl', 'facts');
  facts.append(
    fact('references', String(node.refCount)),
    fact('resolve', String(node.resolvedCount)),
    fact('dead', String(node.dead.length)),
    fact('citations', node.cited.toLocaleString()),
    fact('type', node.type || 'unknown'),
    fact('id', node.id),
  );
  const links = el('p', 'links');
  for (const [href, label] of paperLinks(node)) links.append(link(href, label));

  pane.replaceChildren(el('h2', null, node.title), el('p', 'byline', `${byline(node)} · ${node.year || 'n.d.'}`), facts, links);
  const early = suspectChildren(selected);
  if (early.length) {
    const earliest = Math.min(...early.map((c) => c.year));
    pane.append(el('p', 'note-suspect', `Dated ${node.year}, but cited by a paper from ${earliest}. This is likely a bad match or a wrong date in OpenAlex, so the link may not be real.`));
  }
  if (node.refCount === 0) {
    pane.append(el('p', 'muted', 'The trail stops here: OpenAlex has no references recorded for this paper. That says nothing about whether the paper cited anything.'));
  } else if (layout.edges.some((e) => e.child === selected)) {
    pane.append(el('h3', null, 'Parents shown'), paperList(layout.edges.filter((e) => e.child === selected).map((e) => view.nodes[e.parent])));
  } else {
    pane.append(el('p', 'muted', 'Its references are past what this view draws.'));
  }
  const citers = layout.edges.filter((e) => e.parent === selected).map((e) => view.nodes[e.child]);
  if (citers.length) pane.append(el('h3', null, 'Cited by'), paperList(citers));
}

function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem('fontis-theme'); } catch { /* storage blocked */ }
  const prefersLight = matchMedia('(prefers-color-scheme: light)').matches;
  document.documentElement.dataset.theme = saved || (prefersLight ? 'light' : 'dark');
  $('theme-toggle').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('fontis-theme', next); } catch { /* storage blocked */ }
    drawOverview();
    if (layout) paint();
  });
}

// Drag or swipe across `target` to turn the graph; let go mid-swipe and it keeps
// spinning for a moment. `lanesPerPx` and `inReach` are asked at each gesture.
function addSpin(target, lanesPerPx, inReach, stopSpin, setSpinning, at = () => offset, turn = turnTo) {
  let drag = null;

  target.addEventListener('pointerdown', (e) => {
    if (!frame.rotates || !inReach(e)) return;
    stopSpin();
    drag = { x: e.clientX, start: at(), moved: false, lastX: e.clientX, lastT: e.timeStamp, speed: 0, rate: lanesPerPx() };
  });
  target.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    if (!drag.moved && Math.abs(dx) < 4) return;
    if (!drag.moved) { drag.moved = true; target.setPointerCapture(e.pointerId); }
    drag.speed = (drag.lastX - e.clientX) * drag.rate / Math.max(1, e.timeStamp - drag.lastT);
    drag.lastX = e.clientX;
    drag.lastT = e.timeStamp;
    turn(drag.start - dx * drag.rate);
  });
  const release = (e) => {
    if (!drag) return;
    const { moved, speed } = drag;
    const stale = e.timeStamp - drag.lastT > 80;
    drag = null;
    if (!moved) return;
    target.classList.add('just-dragged');
    setTimeout(() => target.classList.remove('just-dragged'));
    if (stale || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let velocity = speed;
    let position = at();
    let last = performance.now();
    const coast = (now) => {
      position += velocity * (now - last);
      last = now;
      velocity *= SPIN_FRICTION;
      turn(position);
      setSpinning(Math.abs(velocity) > SPIN_STOP ? requestAnimationFrame(coast) : null);
    };
    setSpinning(requestAnimationFrame(coast));
  };
  target.addEventListener('pointerup', release);
  target.addEventListener('pointercancel', release);
  target.addEventListener('click', (e) => {
    if (target.classList.contains('just-dragged')) e.stopPropagation();
  }, true);

  let wheelRest = 0;
  target.addEventListener('wheel', (e) => {
    if (!frame.rotates || Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    e.preventDefault();
    stopSpin();
    wheelRest += e.deltaX * lanesPerPx();
    const steps = Math.trunc(wheelRest);
    wheelRest -= steps;
    if (steps) turn(at() + steps);
  }, { passive: false });
}

function initRotation() {
  let spinning = null;
  const stopSpin = () => { if (spinning) cancelAnimationFrame(spinning); spinning = null; };
  const setSpinning = (id) => { spinning = id; };

  const body = $('log-body');
  body.addEventListener('click', (e) => {
    if (e.target.dataset.to) hopTo(e.target.dataset.to, e.target.dataset.from, { x: e.clientX, y: e.clientY });
  });
  addSpin(body, () => 1 / LANE_W, (e) => e.clientX - body.getBoundingClientRect().left <= graphWidth(frame.drawnLanes), stopSpin, setSpinning);
  addSpin($('cone-canvas'), () => coneLanesPerPx(frame), () => true, stopSpin, setSpinning,
    () => (pinned ? coneTurn : offset), (next) => (pinned ? turnCone(next) : turnTo(next)));
  $('cone-pin').addEventListener('click', () => { stopSpin(); setPinned(!pinned); });

  initConeZoom(queuePaint);
  $('log-scroll').addEventListener('scroll', () => { if (isConeView()) queuePaint(); });
  $('spin').addEventListener('input', (e) => { stopSpin(); turnTo(Number(e.target.value)); });
  $('spin-left').addEventListener('click', () => { stopSpin(); turnTo(offset - (frame.lanes - 1)); });
  $('spin-right').addEventListener('click', () => { stopSpin(); turnTo(offset + (frame.lanes - 1)); });
  window.addEventListener('resize', () => { if (layout) queuePaint(); });
}

async function loadOverview() {
  if (paper.tree) { initOverview(paper.tree, reveal); return; }
  try {
    const res = await fetch(`snapshots/${paper.slug}.tree.json`);
    if (res.ok) initOverview(await res.json(), reveal);
  } catch { /* the graph works without it */ }
}

function initInfoTabs(box) {
  const tabs = [...box.querySelectorAll('.info-tabs button')];
  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      for (const other of tabs) {
        other.setAttribute('aria-pressed', String(other === tab));
        box.querySelector(`[data-panel="${other.dataset.tab}"]`).hidden = other !== tab;
      }
      box.scrollTop = 0;
    });
  }
}

async function start() {
  initTheme();
  initRotation();
  $('info-btn').addEventListener('click', () => {
    $('info').showModal();
    $('info').scrollTop = 0; // its close button takes focus, at the bottom
  });
  initInfoTabs($('info'));
  $('info').addEventListener('click', (e) => {
    const box = $('info').getBoundingClientRect(); // the backdrop's clicks land on the dialog too
    const inside = e.clientX >= box.left && e.clientX <= box.right && e.clientY >= box.top && e.clientY <= box.bottom;
    if (!inside) $('info').close();
  });
  for (const id of ['depth', 'parents', 'dead']) $(id).addEventListener('change', render);
  $('show-all').addEventListener('click', toggleShowAll);
  $('cone-open').addEventListener('click', () => setConeView(true));
  $('cone-exit').addEventListener('click', () => setConeView(false));
  $('cone-gaps').addEventListener('click', toggleGaps);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || $('info').open) return;
    if (isConeView()) setConeView(false);
    else select(null);
  });

  const params = new URLSearchParams(location.search);
  const work = Crawl.parseRef(params.get('work') || '');
  paper = PAPERS.find((p) => p.slug === params.get('paper'));
  if (!paper && !work) { showHome(); return; }

  if (paper) {
    try {
      const res = await fetch(`snapshots/${paper.slug}.json`);
      if (!res.ok) throw new Error(res.status);
      snapshot = await res.json();
    } catch {
      $('paper-head').replaceChildren(el('h1', null, 'Could not load the snapshot'));
      return;
    }
  } else {
    paper = await crawlPaper(work);
    if (!paper) return;
    snapshot = paper.first;
  }
  document.title = `${snapshot.nodes[snapshot.seed].title} · Fontis`;
  fillDepthOptions();
  renderHead();
  render();
  loadOverview();
}

start();
