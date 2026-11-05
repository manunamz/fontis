/*
 * app.js — load a snapshot and render the Log view around the commit graph.
 */
'use strict';

const PAPERS = [
  { slug: 'attention', label: 'Attention Is All You Need' },
  { slug: 'watson-crick', label: 'Watson–Crick 1953' },
];
const $ = (id) => document.getElementById(id);

let snapshot = null;
let view = null;
let layout = null;
let selected = null;

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
  for (const { depth } of snapshot.levels) {
    const option = el('option', null, String(depth));
    option.value = depth;
    select.append(option);
  }
  select.value = snapshot.levels.length;
}

function currentOptions() {
  return {
    depth: Number($('depth').value),
    parents: Number($('parents').value),
    showDead: $('dead').checked,
  };
}

function deadLabel(node) {
  const n = node.deadIds.length;
  return n === 1 ? '1 reference not found' : `${n} references not found`;
}

function rowBadges(node, children) {
  const out = [];
  if (node.missing) out.push(badge('404 in OpenAlex', 'dead'));
  if (node.retracted) out.push(badge('retracted', 'dead'));
  if (!node.missing && node.refCount === 0) out.push(badge('no recorded refs', 'root'));
  if (children > 1) out.push(badge(`shared ×${children}`, 'shared'));
  return out;
}

function renderRow(row) {
  const node = view.nodes[row.id];
  const children = layout.edges.filter((e) => e.parent === row.id).length;
  const item = el('button', 'log-row');
  item.type = 'button';
  item.dataset.id = row.id;
  if (row.id === snapshot.seed) item.classList.add('is-seed');
  if (node.missing) item.classList.add('is-dead');

  const msg = el('span', 'c-msg');
  msg.append(el('span', 'title', node.missing ? deadLabel(node) : node.title), ...rowBadges(node, children));
  item.append(
    el('span', 'c-graph'),
    msg,
    el('span', 'c-field', node.field || ''),
    el('span', 'c-num', node.missing ? '' : String(node.refCount)),
    el('span', 'c-num', node.missing ? '' : formatCount(node.cited)),
    el('span', 'c-year', node.year || ''),
  );
  item.addEventListener('click', () => select(selected === row.id ? null : row.id));
  return item;
}

function render() {
  view = Lineage.select(snapshot, currentOptions());
  layout = Lineage.layout(view.ids, view.edges, view.nodes);
  if (selected && !view.ids.includes(selected)) selected = null;

  const body = $('log-body');
  const width = graphWidth(layout.lanes);
  document.documentElement.style.setProperty('--graph-w', `${width}px`);
  body.replaceChildren(drawGraph(layout, view.nodes, snapshot.seed), ...layout.rows.map(renderRow));
  applySelection();
  renderMore();
  renderSource();
}

function renderMore() {
  const { depth } = currentOptions();
  const hidden = Lineage.hiddenCount(view, snapshot, depth);
  const more = $('log-more');
  more.hidden = hidden === 0;
  more.textContent = `+${hidden.toLocaleString()} earlier ${hidden === 1 ? 'paper' : 'papers'} to depth ${depth} not shown`;
}

function renderSource() {
  const cycles = layout.cut.length;
  const note = cycles ? ` ${cycles} citation ${cycles === 1 ? 'cycle' : 'cycles'} can't be drawn in a commit graph and ${cycles === 1 ? 'is' : 'are'} left out.` : '';
  $('source').textContent = `Measured from ${snapshot.source} on ${snapshot.fetched}. Counts change as the database does.${note}`;
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

function select(id) {
  selected = id;
  applySelection();
}

function fact(label, value) {
  const row = el('div', 'fact');
  row.append(el('dt', null, label), el('dd', null, value));
  return row;
}

function parentList(id) {
  const list = el('ul', 'parents');
  const parents = layout.edges.filter((e) => e.child === id).map((e) => view.nodes[e.parent]);
  for (const p of parents) {
    const li = el('li');
    const btn = el('button', 'linklike', p.missing ? deadLabel(p) : p.title);
    btn.type = 'button';
    btn.addEventListener('click', () => select(p.id));
    li.append(btn);
    list.append(li);
  }
  return list;
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
  links.append(link(`https://openalex.org/${node.id}`, 'OpenAlex'));
  if (node.doi) links.append(link(`https://doi.org/${node.doi}`, 'DOI'));

  pane.replaceChildren(el('h2', null, node.title), el('p', 'byline', `${byline(node)} · ${node.year || 'n.d.'}`), facts, links);
  if (node.refCount === 0) {
    pane.append(el('p', 'muted', 'The trail stops here: OpenAlex has no references recorded for this paper. That says nothing about whether the paper cited anything.'));
  } else if (layout.edges.some((e) => e.child === selected)) {
    pane.append(el('h3', null, 'Parents shown'), parentList(selected));
  } else {
    pane.append(el('p', 'muted', 'Its references are beyond the depth shown here.'));
  }
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
  });
}

async function start() {
  initTheme();
  $('info-btn').addEventListener('click', () => $('info').showModal());
  for (const id of ['depth', 'parents', 'dead']) $(id).addEventListener('change', render);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('info').open) select(null); });

  const requested = new URLSearchParams(location.search).get('paper');
  const paper = PAPERS.find((p) => p.slug === requested) || PAPERS[0];
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
}

start();
