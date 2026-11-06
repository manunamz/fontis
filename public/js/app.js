/*
 * app.js — load a snapshot and render the overview and rotating commit graph.
 */
'use strict';

const PAPERS = [
  { slug: 'attention', label: 'Attention Is All You Need' },
  { slug: 'watson-crick', label: 'Watson–Crick 1953' },
];
const $ = (id) => document.getElementById(id);

const MIN_WINDOW = 6;
const MAX_WINDOW = 24;
const GRAPH_SHARE = 0.36; // of the table's width
const SPIN_FRICTION = 0.94;
const SPIN_STOP = 0.002; // lanes per ms

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
let offset = 0;
let paintQueued = false;
let paintedLayout = null;
let closeGaps = true;
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

function renderSwitcher(current) {
  const nav = $('papers');
  for (const paper of PAPERS) {
    const a = el('a', null, paper.label);
    a.href = `?paper=${paper.slug}`;
    if (paper === current) a.setAttribute('aria-current', 'page');
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
  const toggle = () => select(selected === row.id ? null : row.id);
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
  frame = Lineage.windowView(layout, { offset: Math.round(offset), width: windowWidth(), keep });
  offset = frame.rotates ? ((offset % frame.sideLanes) + frame.sideLanes) % frame.sideLanes : 0;
  renderRotator();
  const moved = paintedLayout !== layout || previous.offset !== frame.offset || previous.lanes !== frame.lanes;
  if (isConeView() && !moved) {
    drawCone(layout, view.nodes, frame, offset, rowsInSight());
    return;
  }
  paintedLayout = layout;
  // A window fills few rows of a wide graph, so by default the gaps close up.
  table = closeGaps ? Lineage.compactRows(frame) : frame;
  document.documentElement.style.setProperty('--graph-w', `${graphWidth(frame.drawnLanes)}px`);
  const body = $('log-body');
  body.style.height = `${table.totalRows * ROW_H}px`;
  body.replaceChildren(drawGraph(table, view.nodes, snapshot.seed, frontier), ...table.rows.map(renderRow));
  applySelection();
  renderMore();
  if (isConeView()) drawCone(layout, view.nodes, frame, offset, rowsInSight());
}

function setConeView(on) {
  withFull(() => {
    if (on) setShowAll(true);
    document.body.classList.toggle('cone-view', on);
    $('cone').hidden = !on;
    offset = 0;
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

// The line of descent at the middle of the window.
function frontSector() {
  const middle = (frame.offset + Math.floor((frame.lanes - 1) / 2)) % frame.sideLanes + 1;
  return layout.sectors.find((s) => s.first != null && s.first <= middle && middle <= s.last);
}

function renderRotator() {
  const { rotates, sideLanes } = frame;
  $('rotator').hidden = !rotates && !isConeView();
  $('rotator').classList.toggle('still', !rotates);
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

function applySelection() {
  const body = $('log-body');
  const trail = selected ? Lineage.lineage(selected, layout.edges) : null;
  body.classList.toggle('tracing', !!trail);
  for (const row of body.querySelectorAll('.log-row')) {
    row.classList.toggle('on-trail', !!trail && trail.has(row.dataset.id));
    row.classList.toggle('is-selected', row.dataset.id === selected);
  }
  for (const path of body.querySelectorAll('.edge')) {
    path.classList.toggle('on-trail', !!trail && trail.has(path.dataset.child) && trail.has(path.dataset.parent));
  }
  for (const mark of body.querySelectorAll('[data-id]:not(.log-row)')) {
    mark.classList.toggle('on-trail', !!trail && trail.has(mark.dataset.id));
  }
  renderDetail();
}

const rowTop = (id) => document.querySelector(`.log-row[data-id="${id}"]`)?.getBoundingClientRect().top;

// Selecting a paper brings its connections into the table, which moves rows
// around, so the paper clicked stays where it is on screen. One on a lane out
// of view turns the graph to it.
function select(id) {
  const anchor = id || selected;
  const before = anchor && rowTop(anchor);
  selected = id;
  const row = id && layout.rows.find((r) => r.id === id);
  if (row && !frame.rows.some((r) => r.id === id)) {
    offset = Lineage.offsetFor(row.lane, { width: frame.lanes - 1, sideLanes: frame.sideLanes });
  }
  paintedLayout = null;
  paint();
  if (before === undefined || before === null) {
    if (id) document.querySelector(`.log-row[data-id="${id}"]`)?.scrollIntoView({ block: 'center' });
    return;
  }
  const after = rowTop(anchor);
  if (after === undefined) return;
  if (isConeView()) $('log-scroll').scrollTop += after - before;
  else window.scrollBy(0, after - before);
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
    btn.addEventListener('click', () => select(p.id));
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

function renderDetail() {
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
  try { saved = localStorage.getItem('pprhub-theme'); } catch { /* storage blocked */ }
  const prefersLight = matchMedia('(prefers-color-scheme: light)').matches;
  document.documentElement.dataset.theme = saved || (prefersLight ? 'light' : 'dark');
  $('theme-toggle').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('pprhub-theme', next); } catch { /* storage blocked */ }
    drawOverview();
    if (layout) paint();
  });
}

// Drag or swipe across `target` to turn the graph; let go mid-swipe and it keeps
// spinning for a moment. `lanesPerPx` and `inReach` are asked at each gesture.
function addSpin(target, lanesPerPx, inReach, stopSpin, setSpinning) {
  let drag = null;

  target.addEventListener('pointerdown', (e) => {
    if (!frame.rotates || !inReach(e)) return;
    stopSpin();
    drag = { x: e.clientX, start: offset, moved: false, lastX: e.clientX, lastT: e.timeStamp, speed: 0, rate: lanesPerPx() };
  });
  target.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    if (!drag.moved && Math.abs(dx) < 4) return;
    if (!drag.moved) { drag.moved = true; target.setPointerCapture(e.pointerId); }
    drag.speed = (drag.lastX - e.clientX) * drag.rate / Math.max(1, e.timeStamp - drag.lastT);
    drag.lastX = e.clientX;
    drag.lastT = e.timeStamp;
    turnTo(drag.start - dx * drag.rate);
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
    let position = offset;
    let last = performance.now();
    const coast = (now) => {
      position += velocity * (now - last);
      last = now;
      velocity *= SPIN_FRICTION;
      turnTo(position);
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
    if (steps) turnTo(offset + steps);
  }, { passive: false });
}

function initRotation() {
  let spinning = null;
  const stopSpin = () => { if (spinning) cancelAnimationFrame(spinning); spinning = null; };
  const setSpinning = (id) => { spinning = id; };

  const body = $('log-body');
  body.addEventListener('click', (e) => { if (e.target.dataset.to) select(e.target.dataset.to); });
  addSpin(body, () => 1 / LANE_W, (e) => e.clientX - body.getBoundingClientRect().left <= graphWidth(frame.drawnLanes), stopSpin, setSpinning);
  addSpin($('cone-canvas'), () => coneLanesPerPx(frame), () => true, stopSpin, setSpinning);

  initConeZoom(queuePaint);
  $('log-scroll').addEventListener('scroll', () => { if (isConeView()) queuePaint(); });
  $('spin').addEventListener('input', (e) => { stopSpin(); turnTo(Number(e.target.value)); });
  $('spin-left').addEventListener('click', () => { stopSpin(); turnTo(offset - (frame.lanes - 1)); });
  $('spin-right').addEventListener('click', () => { stopSpin(); turnTo(offset + (frame.lanes - 1)); });
  window.addEventListener('resize', () => { if (layout) queuePaint(); });
}

async function loadOverview() {
  try {
    const res = await fetch(`snapshots/${paper.slug}.tree.json`);
    if (res.ok) initOverview(await res.json(), reveal);
  } catch { /* the graph works without it */ }
}

async function start() {
  initTheme();
  initRotation();
  $('info-btn').addEventListener('click', () => $('info').showModal());
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

  const requested = new URLSearchParams(location.search).get('paper');
  paper = PAPERS.find((p) => p.slug === requested) || PAPERS[0];
  renderSwitcher(paper);

  try {
    const res = await fetch(`snapshots/${paper.slug}.json`);
    if (!res.ok) throw new Error(res.status);
    snapshot = await res.json();
  } catch {
    $('paper-head').replaceChildren(el('h1', null, 'Could not load the snapshot'));
    return;
  }
  document.title = `${snapshot.nodes[snapshot.seed].title} · pprhub`;
  fillDepthOptions();
  renderHead();
  render();
  loadOverview();
}

start();
