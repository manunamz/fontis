'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { select, order, layout, lineage, frontier, hiddenCount } = require('../../public/lib/lineage');

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
