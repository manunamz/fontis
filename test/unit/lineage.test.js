'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { select, order, layout, lineage, connections, frontier, hiddenCount, hiddenParents, windowView, compactRows, offsetFor } = require('../../public/lib/lineage');
const { project, adjustDetail, linksInView } = require('../../public/lib/projection');

const paper = (id, year, cited, parents = [], dead = []) => ({ id, title: id, year, cited, parents, dead });

function snapshot(...nodes) {
  return { seed: nodes[0].id, nodes: Object.fromEntries(nodes.map((n) => [n.id, n])) };
}

// seed cites a and b; both cite the shared ancestor c.
const diamond = () => snapshot(
  paper('seed', 2017, 100, ['a', 'b']),
  paper('a', 2015, 50, ['c']),
  paper('b', 2014, 40, ['c']),
  paper('c', 2010, 90),
);

test('select follows only the top parents, ranked by citations', () => {
  const snap = snapshot(
    paper('seed', 2017, 100, ['low', 'high']),
    paper('low', 2015, 1),
    paper('high', 2015, 50),
  );
  assert.deepEqual(select(snap, { parents: 1 }).ids.sort(), ['high', 'seed']);
});

test('select stops at the requested depth', () => {
  assert.deepEqual(select(diamond(), { depth: 1 }).ids.sort(), ['a', 'b', 'seed']);
});

test('a paper\'s dead references share one stub', () => {
  const snap = snapshot(paper('seed', 2017, 100, [], ['x', 'y']));
  const view = select(snap);
  assert.deepEqual(view.ids.sort(), ['dead:seed', 'seed']);
  assert.deepEqual(view.nodes['dead:seed'].deadIds, ['x', 'y']);
  assert.equal(snap.nodes['dead:seed'], undefined);
});

test('select can hide dead references', () => {
  const snap = snapshot(paper('seed', 2017, 100, [], ['x']));
  assert.deepEqual(select(snap, { showDead: false }).ids, ['seed']);
});

test('order puts children above parents even when a citation points forward in time', () => {
  const snap = snapshot(paper('seed', 2017, 100, ['late']), paper('late', 2019, 5));
  const { ids, edges } = select(snap);
  assert.deepEqual(order(ids, edges, snap.nodes).rows, ['seed', 'late']);
});

test('order sorts newest first where the graph leaves it free', () => {
  const snap = diamond();
  const { ids, edges } = select(snap);
  assert.deepEqual(order(ids, edges, snap.nodes).rows, ['seed', 'a', 'b', 'c']);
});

test('order cuts the edge that closes a citation cycle and reports it', () => {
  const snap = snapshot(paper('seed', 2017, 100, ['a']), paper('a', 2016, 5, ['b']), paper('b', 2016, 5, ['a']));
  const { ids, edges } = select(snap);
  const out = order(ids, edges, snap.nodes);
  assert.equal(out.rows.length, 3);
  assert.deepEqual(out.cut, [['b', 'a']]);
});

test('a dead reference sits directly under the paper citing it', () => {
  const snap = snapshot(
    paper('seed', 2017, 100, ['a'], ['x']),
    paper('a', 2015, 50),
  );
  const { ids, edges, nodes } = select(snap);
  assert.deepEqual(order(ids, edges, nodes).rows, ['seed', 'dead:seed', 'a']);
});

test('layout keeps the first parent on the child lane', () => {
  const snap = snapshot(paper('seed', 2017, 100, ['a']), paper('a', 2015, 50));
  const { ids, edges } = select(snap);
  const out = layout(ids, edges, snap.nodes);
  assert.equal(out.rows[0].lane, out.rows[1].lane);
  assert.equal(out.lanes, 1);
});

test('a shared ancestor is one row reached by two paths (a merge)', () => {
  const snap = diamond();
  const { ids, edges } = select(snap);
  const out = layout(ids, edges, snap.nodes);
  assert.equal(out.rows.filter((r) => r.id === 'c').length, 1);
  const into = out.edges.filter((e) => e.parent === 'c');
  assert.equal(into.length, 2);
  const lane = out.rows.find((r) => r.id === 'c').lane;
  for (const e of into) assert.equal(e.toLane, lane);
});

test('no paper sits on a lane another edge is still running through', () => {
  const nodes = [paper('seed', 2017, 100, ['a', 'b', 'c', 'd'], ['x', 'y'])];
  nodes.push(paper('a', 2016, 90, ['c', 'e']), paper('b', 2015, 80, ['e', 'f']));
  nodes.push(paper('c', 2014, 70, ['f']), paper('d', 2013, 60, ['f', 'g']));
  nodes.push(paper('e', 2012, 50), paper('f', 2011, 40, ['g']), paper('g', 2010, 30));
  const snap = snapshot(...nodes);
  const view = select(snap, { parents: 5, depth: 4 });
  const { ids, edges } = view;
  const out = layout(ids, edges, view.nodes);
  assert.equal(out.rows.length, ids.length);
  for (const row of out.rows) {
    for (const e of out.edges) {
      const passes = e.from < row.row && row.row < e.to && e.via === row.lane;
      assert.ok(!passes, `${e.child}->${e.parent} runs through ${row.id}`);
    }
  }
});

test('every edge starts at its child and ends on its parent', () => {
  const snap = diamond();
  const { ids, edges } = select(snap);
  const out = layout(ids, edges, snap.nodes);
  const at = new Map(out.rows.map((r) => [r.id, r]));
  for (const e of out.edges) {
    assert.equal(e.fromLane, at.get(e.child).lane);
    assert.equal(e.from, at.get(e.child).row);
    assert.equal(e.toLane, at.get(e.parent).lane);
    assert.equal(e.to, at.get(e.parent).row);
  }
});

test('lineage returns ancestors and descendants but not siblings', () => {
  const snap = diamond();
  const { ids, edges } = select(snap);
  const out = layout(ids, edges, snap.nodes);
  assert.deepEqual([...lineage('a', out.edges)].sort(), ['a', 'c', 'seed']);
});

test('the spine stays on lane 0 even when another paper reached it first', () => {
  const snap = snapshot(
    paper('seed', 2017, 100, ['big', 'side']),
    paper('side', 2016, 10, ['big']),
    paper('big', 2015, 90),
  );
  const view = select(snap);
  const out = layout(view.ids, view.edges, view.nodes);
  assert.equal(out.rows.find((r) => r.id === 'big').lane, 0);
  for (const e of out.edges.filter((x) => x.parent === 'big')) assert.equal(e.toLane, 0);
});

test('only the spine ever uses lane 0', () => {
  const snap = snapshot(
    paper('seed', 2017, 100, ['a', 'b'], ['x']),
    paper('a', 2016, 90),
    paper('b', 2010, 80, ['c'], ['y']),
    paper('c', 2005, 70),
  );
  const view = select(snap, { depth: 3 });
  const out = layout(view.ids, view.edges, view.nodes);
  assert.deepEqual(out.rows.filter((r) => r.lane === 0).map((r) => r.id), ['seed', 'a']);
  assert.ok(out.edges.filter((e) => e.via === 0).every((e) => e.child === 'seed' && e.parent === 'a'));
});

test('an edge into a lane that is already open is marked as a join', () => {
  const snap = diamond();
  const view = select(snap);
  const out = layout(view.ids, view.edges, view.nodes);
  assert.deepEqual(out.edges.filter((e) => e.join).map((e) => [e.child, e.parent]), [['b', 'c']]);
});

test('frontier holds papers with undrawn references, not papers with none', () => {
  const snap = snapshot(
    { ...paper('seed', 2017, 100, ['more', 'none', 'deadonly'], []), resolvedCount: 3 },
    { ...paper('more', 2016, 90), resolvedCount: 4 },
    { ...paper('none', 2015, 80), resolvedCount: 0 },
    { ...paper('deadonly', 2014, 70, [], ['x']), resolvedCount: 0 },
  );
  const view = select(snap);
  const out = layout(view.ids, view.edges, view.nodes);
  assert.deepEqual(frontier(out, view.nodes).map((r) => r.id), ['more']);
});

test('hiddenCount subtracts shown papers and each dead id once', () => {
  const snap = snapshot(paper('seed', 2017, 100, ['a'], ['x', 'y']), paper('a', 2016, 90, [], ['x']));
  snap.levels = [{ depth: 1, papers: 10 }, { depth: 2, papers: 100 }];
  assert.equal(hiddenCount(select(snap, { depth: 1 }), snap, 1), 7);
  assert.equal(hiddenCount(select(snap, { depth: 2 }), snap, 2), 107);
});

test('an expanded paper shows all of its references', () => {
  const snap = snapshot(
    paper('seed', 2017, 100, ['a', 'b', 'c']),
    paper('a', 2015, 3),
    paper('b', 2015, 2),
    paper('c', 2015, 1),
  );
  assert.equal(select(snap, { parents: 1 }).ids.length, 2);
  assert.equal(select(snap, { parents: 1, expanded: new Set(['seed']) }).ids.length, 4);
});

test('expanding a paper at the depth limit reaches past it, and only there', () => {
  const snap = snapshot(
    paper('seed', 2017, 100, ['a', 'b']),
    paper('a', 2015, 50, ['c']),
    paper('b', 2015, 40, ['d']),
    paper('c', 2010, 20),
    paper('d', 2010, 10),
  );
  assert.deepEqual(select(snap, { depth: 1, expanded: new Set(['a']) }).ids.sort(), ['a', 'b', 'c', 'seed']);
});

test('hiddenParents counts resolved references the view leaves out', () => {
  const snap = snapshot(
    paper('seed', 2017, 100, ['a', 'b', 'c'], ['x']),
    paper('a', 2015, 3),
    paper('b', 2015, 2),
    paper('c', 2015, 1),
  );
  const hidden = hiddenParents(select(snap, { parents: 2 }));
  assert.equal(hidden.get('seed'), 1);
  assert.equal(hidden.get('a'), 0);
});

test('a parent dated more than two years after its child is suspect', () => {
  const snap = snapshot(
    paper('seed', 2010, 100, ['ok', 'bad', 'undated']),
    paper('ok', 2012, 50),
    paper('bad', 2013, 40),
    paper('undated', null, 30),
  );
  const view = select(snap);
  const out = layout(view.ids, view.edges, view.nodes);
  assert.deepEqual(out.edges.filter((e) => e.suspect).map((e) => e.parent), ['bad']);
});

// A seed with `n` parents, each one row down, so each takes its own lane.
function fan(n) {
  const parents = Array.from({ length: n }, (_, i) => `p${i}`);
  const nodes = [paper('seed', 2017, 1000, parents)];
  parents.forEach((id, i) => nodes.push(paper(id, 2016 - i, 900 - i)));
  const snap = snapshot(...nodes);
  const view = select(snap, { parents: n, depth: 1 });
  return layout(view.ids, view.edges, view.nodes);
}

test('windowView leaves a graph that already fits alone', () => {
  const out = fan(4);
  const win = windowView(out, { width: 12 });
  assert.equal(win.rotates, false);
  assert.equal(win.rows.length, out.rows.length);
});

test('windowView keeps the spine and only papers on lanes in view', () => {
  const out = fan(10);
  const win = windowView(out, { offset: 0, width: 3 });
  assert.equal(win.rotates, true);
  assert.equal(win.lanes, 4);
  assert.ok(win.rows.some((r) => r.id === 'seed' && r.lane === 0));
  assert.ok(win.rows.every((r) => r.lane <= 3));
  assert.equal(win.rows.length, 5); // seed, its first parent on the spine, three side lanes
  assert.equal(win.totalRows, out.rows.length);
});

test('a paper keeps its row at every rotation', () => {
  const out = fan(10);
  const home = new Map(out.rows.map((r) => [r.id, r.row]));
  for (let offset = 0; offset < 9; offset++) {
    for (const r of windowView(out, { offset, width: 3 }).rows) assert.equal(r.row, home.get(r.id));
  }
});

test('turning swaps which papers have rows and wraps around both ways', () => {
  const out = fan(10);
  const ids = (offset) => windowView(out, { offset, width: 3 }).rows.map((r) => r.id).join();
  assert.notEqual(ids(0), ids(3));
  assert.equal(ids(-9), ids(0));
  assert.equal(ids(9), ids(0));
  assert.equal(windowView(out, { offset: -1, width: 3 }).offset, 8);
});

test('links leaving the window become one merged tail per row and direction', () => {
  const win = windowView(fan(10), { offset: 0, width: 3 });
  const seedRow = win.rows.find((r) => r.id === 'seed').row;
  const tails = win.stubs.filter((s) => s.row === seedRow);
  assert.ok(tails.length >= 1 && tails.length <= 2);
  assert.equal(tails.reduce((sum, s) => sum + s.links.length, 0), 6);
});

test('every drawn edge in a window has both ends on rows in view', () => {
  const win = windowView(fan(10), { offset: 2, width: 3 });
  for (const e of win.edges) {
    assert.equal(win.rows.find((r) => r.row === e.from).id, e.child);
    assert.equal(win.rows.find((r) => r.row === e.to).id, e.parent);
  }
});

test('offsetFor brings a lane into the window', () => {
  const out = fan(10);
  const target = out.rows.find((r) => r.id === 'p8');
  const offset = offsetFor(target.lane, { width: 3, sideLanes: out.lanes - 1 });
  assert.ok(windowView(out, { offset, width: 3 }).rows.some((r) => r.id === 'p8'));
});

test('layout gives each of the seed\'s references one sector of neighbouring lanes', () => {
  const nodes = {
    S: { id: 'S', year: 2020, cited: 9 },
    A: { id: 'A', year: 2019, cited: 5 },
    B: { id: 'B', year: 2019, cited: 4 },
    A1: { id: 'A1', year: 2010, cited: 3 },
    A2: { id: 'A2', year: 2010, cited: 2 },
    B1: { id: 'B1', year: 2010, cited: 3 },
    B2: { id: 'B2', year: 2010, cited: 2 },
    Z: { id: 'Z', year: 2000, cited: 1 },
  };
  const edges = [['S', 'A'], ['S', 'B'], ['A', 'A1'], ['A', 'A2'], ['B', 'B1'], ['B', 'B2'], ['A2', 'Z'], ['B2', 'Z']];
  const ids = Object.keys(nodes);
  const { rows, sectors, lanes } = layout(ids, edges, nodes, { grouped: true });

  assert.deepEqual(sectors.map((s) => s.id), ['A', 'B']);
  assert.equal(sectors[0].papers + sectors[1].papers, ids.length - 1);
  assert.equal(sectors[1].first, sectors[0].last + 1);
  assert.equal(sectors[1].last, lanes - 1);
  for (const row of rows) {
    if (row.id === 'S' || row.lane === 0) continue;
    const { first, last } = sectors[row.sector];
    assert.ok(row.lane >= first && row.lane <= last, `${row.id} sits in its sector`);
  }
});

test('compactRows closes gaps between filled rows and keeps their order', () => {
  const frame = {
    rows: [{ id: 'a', row: 0, lane: 0 }, { id: 'b', row: 40, lane: 1 }, { id: 'c', row: 90, lane: 1 }],
    edges: [{ child: 'a', parent: 'c', from: 0, to: 90 }],
    stubs: [{ row: 40, lane: 1, dir: 1, color: 1, count: 1 }],
    totalRows: 200,
  };
  const out = compactRows(frame);
  assert.deepEqual(out.rows.map((r) => [r.id, r.row, r.from]), [['a', 0, 0], ['b', 1, 40], ['c', 2, 90]]);
  assert.deepEqual([out.edges[0].from, out.edges[0].to], [0, 2]);
  assert.equal(out.stubs[0].row, 1);
  assert.equal(out.totalRows, 3);
});

test('connections gives the line to the seed, then neighbours up to the limit', () => {
  const edges = [['S', 'A'], ['A', 'B'], ['B', 'C'], ['S', 'B'], ['C', 'D'], ['C', 'E']].map(([child, parent]) => ({ child, parent }));
  assert.deepEqual([...connections('C', edges)], ['S', 'B', 'C', 'D', 'E']);
  assert.deepEqual([...connections('C', edges, 4)], ['S', 'B', 'C', 'D']);
  assert.deepEqual([...connections('S', edges, 1)], ['S']);
});

test('windowView keeps connected papers in view on extra lanes', () => {
  const nodes = {};
  const ids = ['S', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'A1'];
  ids.forEach((id, i) => { nodes[id] = { id, year: 2020 - i, cited: 20 - i }; });
  const edges = ids.slice(1, 9).map((id) => ['S', id]).concat([['H', 'A1']]);
  const full = layout(ids, edges, nodes);
  const target = full.rows.find((r) => r.id === 'A1');

  const plain = windowView(full, { width: 2, offset: target.lane + 2 });
  assert.ok(!plain.rows.some((r) => r.id === 'A1'));

  const keep = connections('A1', full.edges);
  const kept = windowView(full, { width: 2, offset: target.lane + 2, keep });
  assert.ok(kept.rows.some((r) => r.id === 'A1'));
  assert.ok(kept.drawnLanes > kept.lanes);
  assert.ok(kept.edges.some((e) => e.child === 'H' && e.parent === 'A1'));
  assert.equal(kept.lanes, plain.lanes);
  assert.equal(new Set(kept.rows.map((r) => r.lane)).has(null), false);
});

test('windowView tails list the papers they lead to', () => {
  const nodes = {};
  const ids = ['S', 'A', 'B', 'C', 'D', 'E'];
  ids.forEach((id, i) => { nodes[id] = { id, year: 2020 - i, cited: 20 - i }; });
  const edges = ids.slice(1).map((id) => ['S', id]);
  const full = layout(ids, edges, nodes);
  const frame = windowView(full, { width: 2 });
  const links = frame.stubs.flatMap((s) => s.links);
  const hidden = ids.slice(1).filter((id) => !frame.rows.some((r) => r.id === id));
  assert.ok(hidden.length > 0);
  for (const id of hidden) assert.ok(links.some((l) => l.id === id && l.cites), `S links to ${id}`);
  assert.ok(frame.stubs.every((s) => s.links.length > 0));
});

test('project places a paper on the cone the way the tip and rim say it should', () => {
  const shape = { radius: 100, length: 500, cx: 200, top: 10 };
  const buffers = { xs: new Float32Array(3), ys: new Float32Array(3), nears: new Float32Array(3) };
  project(new Float32Array([0, 0, Math.PI / 2]), new Float32Array([0, 1, 1]), shape, 0, buffers);
  assert.ok(Math.abs(buffers.xs[0] - 200) < 1e-3, 'the tip sits on the axis');
  assert.ok(Math.abs(buffers.ys[0] - 10) < 1e-3, 'the tip sits at the top');
  assert.ok(Math.abs(buffers.xs[1] - 200) < 1e-3, 'straight ahead stays on the axis');
  assert.ok(Math.abs(buffers.nears[1] - 1) < 1e-3, 'straight ahead is nearest');
  assert.ok(buffers.xs[2] > 290, 'a quarter turn reaches the edge');
  assert.ok(Math.abs(buffers.nears[2]) < 1e-3, 'a quarter turn is neither front nor back');
});

test('project turns the cone by the spin', () => {
  const shape = { radius: 100, length: 500, cx: 200, top: 10 };
  const buffers = { xs: new Float32Array(1), ys: new Float32Array(1), nears: new Float32Array(1) };
  project(new Float32Array([1]), new Float32Array([1]), shape, 1, buffers);
  assert.ok(Math.abs(buffers.nears[0] - 1) < 1e-3);
});

test('adjustDetail halves the links when frames run slow, down to a floor', () => {
  assert.equal(adjustDetail(30000, 40), 15000);
  assert.equal(adjustDetail(4000, 80), 3000);
});

test('adjustDetail creeps back up when frames keep time, up to a ceiling', () => {
  assert.equal(adjustDetail(16000, 17), 17600);
  assert.equal(adjustDetail(40000, 17), 40000);
});

test('adjustDetail leaves the links alone in between, or after a pause', () => {
  assert.equal(adjustDetail(20000, 24), 20000);
  assert.equal(adjustDetail(20000, 500), 20000);
});

test('linksInView keeps a link that crosses the view and drops the rest', () => {
  const xs = new Float32Array([10, 20, 500, 600, -50, 150, 50]);
  const ys = new Float32Array([10, 20, 500, 600, 50, 50, 500]);
  const pairs = new Int32Array([0, 1, 2, 3, 4, 5, 0, 6]);
  const out = new Int32Array(pairs.length);
  const box = { left: 0, right: 100, top: 0, bottom: 100 };
  assert.deepEqual([...out.subarray(0, linksInView(pairs, xs, ys, box, out))], [0, 1, 4, 5, 0, 6]);
});

test('windowView gives the same result however many times it turns', () => {
  const edges = [['seed', 'a'], ['seed', 'b'], ['seed', 'c'], ['seed', 'd'], ['a', 'e'], ['b', 'e'], ['c', 'f'], ['d', 'g']];
  const ids = ['seed', 'a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const nodes = Object.fromEntries(ids.map((id, i) => [id, { id, year: 2020 - i, cited: 10 - i }]));
  const graph = layout(ids, edges, nodes);
  const first = windowView(graph, { offset: 1, width: 2 });
  windowView(graph, { offset: 3, width: 2 });
  assert.deepEqual(windowView(graph, { offset: 1, width: 2 }), first);
});
