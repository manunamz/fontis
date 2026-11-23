'use strict';
/*
 * Budgets for a tree the size of the biggest snapshots. Timings depend on the
 * machine, so these run apart from the unit tests: `npm run test:perf`.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { select, layout, windowView, connections } = require('../../public/lib/lineage');
const { project, linksInView } = require('../../public/lib/projection');

const BUDGET_MS = { layout: 450, firstWindow: 60, window: 2, connections: 1, project: 4, cull: 3 };
const REPEATS = 30;

// About 110,000 papers and 210,000 links, shaped like a depth 3 crawl.
function bigSnapshot() {
  let state = 7;
  const random = (n) => { // mulberry32, so every run gets the same tree
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) % n;
  };
  const tiers = [1, 60, 3600, 150000];
  const nodes = {};
  const names = tiers.map((size, t) => Array.from({ length: size }, (_, i) => `W${t}x${i}`));
  names.forEach((tier, t) => {
    const below = names[t + 1];
    const refs = [60, 120, 56][t] ?? 0;
    for (const id of tier) {
      const parents = below ? [...new Set(Array.from({ length: refs }, () => below[random(below.length)]))] : [];
      nodes[id] = { id, title: id, year: 2020 - t * 10 - random(9), cited: random(5000), parents, dead: [], refCount: parents.length, resolvedCount: parents.length };
    }
  });
  return { seed: 'W0x0', nodes, levels: [] };
}

const snapshot = bigSnapshot();
const expanded = new Set(Object.values(snapshot.nodes).filter((n) => n.parents.length).map((n) => n.id));
const view = select(snapshot, { depth: 3, parents: 5, showDead: true, expanded });
const fastest = (run) => {
  let best = Infinity;
  for (let i = 0; i < REPEATS; i++) {
    const start = performance.now();
    run(i);
    best = Math.min(best, performance.now() - start);
  }
  return best;
};
const once = (run) => {
  const start = performance.now();
  run();
  return performance.now() - start;
};
const within = (name, ms) => assert.ok(ms <= BUDGET_MS[name], `${name} took ${ms.toFixed(1)}ms, budget ${BUDGET_MS[name]}ms`);

let graph;
test('a big tree lays out in time', () => {
  within('layout', once(() => { graph = layout(view.ids, view.edges, view.nodes, { grouped: true }); }));
  assert.ok(graph.rows.length > 90000);
  assert.ok(graph.edges.length > 140000);
});

test('turning the window costs what the window holds, not the whole tree', () => {
  within('firstWindow', once(() => windowView(graph, { offset: 5, width: 20 })));
  within('window', fastest((i) => windowView(graph, { offset: i * 7, width: 20 })));
});

test('a selected paper can stay in view without rescanning every link', () => {
  const id = graph.rows[Math.floor(graph.rows.length / 2)].id;
  connections(id, graph.edges);
  within('connections', fastest(() => connections(id, graph.edges)));
  const keep = connections(id, graph.edges);
  within('window', fastest((i) => windowView(graph, { offset: i * 7, width: 20, keep })));
});

test('placing every paper on the cone fits in a frame', () => {
  const count = graph.rows.length;
  const angle = new Float32Array(count).map((_, i) => i * 0.1);
  const drop = new Float32Array(count).map((_, i) => i / count);
  const shape = { radius: 200, length: 700, cx: 240, top: 26 };
  const buffers = { xs: new Float32Array(count), ys: new Float32Array(count), nears: new Float32Array(count) };
  within('project', fastest((i) => project(angle, drop, shape, i * 0.01, buffers)));
});

test('finding the links in view fits in a frame', () => {
  const count = graph.rows.length;
  const xs = new Float32Array(count).map((_, i) => (i * 37) % 900);
  const ys = new Float32Array(count).map((_, i) => (i * 53) % 900);
  const pairs = new Int32Array(graph.edges.length * 2);
  graph.edges.forEach((e, i) => { pairs[i * 2] = e.from; pairs[i * 2 + 1] = e.to; });
  const out = new Int32Array(pairs.length);
  within('cull', fastest(() => linksInView(pairs, xs, ys, { left: 100, right: 400, top: 100, bottom: 400 }, out)));
});
