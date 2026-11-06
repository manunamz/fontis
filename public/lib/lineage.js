/*
 * lineage.js — turn a citation snapshot into a commit graph.
 *
 * The one idea pprhub rests on: a paper's references are its parent commits.
 * A bibliography is a merge commit, and a lineage is `git log --graph`.
 *
 * Pure functions, no DOM: loaded as a classic script in the browser (as the
 * global `Lineage`) and required directly by the tests and the snapshot script.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Lineage = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // A citation can outrun its target's date by a year or two (preprints, late
  // journal issues). Past that, the link or the date is likely wrong.
  const SUSPECT_YEARS = 2;
  const CONNECTION_LIMIT = 12;

  function isSuspect(child, parent) {
    return child.year != null && parent.year != null && parent.year - child.year > SUSPECT_YEARS;
  }

  // Rank references the way a reader would skim them: most cited first, ties
  // broken by id so a snapshot always renders the same way.
  function rankParents(ids, nodes) {
    return ids
      .filter((id) => nodes[id])
      .sort((a, b) => (nodes[b].cited - nodes[a].cited) || (a < b ? -1 : 1));
  }

  /*
   * Pick the visible subgraph: walk from the seed, following each paper's top
   * `parents` references down to `depth`. Papers in `expanded` show all of
   * their references, even from beyond `depth`. Dead references are kept (when
   * `showDead`) because they are the point: pointers that open onto air. A
   * paper's dead references share one stub, so they can't crowd out the lineage.
   *
   * Returns { ids, edges, nodes } where edges are [child, parent] pairs and
   * nodes is the snapshot's plus those stubs.
   */
  function select(snapshot, { depth = 3, parents = 3, showDead = true, expanded = new Set() } = {}) {
    const { seed } = snapshot;
    const nodes = { ...snapshot.nodes };
    const seen = new Set([seed]);
    const edges = [];
    let level = [seed];
    for (let d = 1; level.length; d++) {
      const next = [];
      for (const id of level) {
        const open = expanded.has(id);
        if (d > depth && !open) continue;
        const node = nodes[id];
        const ranked = rankParents(node.parents || [], nodes);
        const top = open ? ranked : ranked.slice(0, parents);
        for (const pid of top) {
          edges.push([id, pid]);
          if (!seen.has(pid)) { seen.add(pid); next.push(pid); }
        }
        if (showDead && node.dead && node.dead.length) {
          const stub = `dead:${id}`;
          nodes[stub] = { id: stub, missing: true, deadIds: node.dead, year: null, cited: 0 };
          edges.push([id, stub]);
          seen.add(stub);
        }
      }
      level = next;
    }
    return { ids: [...seen], edges, nodes };
  }

  /*
   * Order rows the way a commit log does: children above their parents, newest
   * first where that freedom exists. A citation can point forward in time
   * (a preprint cites a paper dated later), so the year alone can't be the
   * sort key. Citation cycles do exist; the edge that would close one is
   * dropped and reported in `cut`, since a commit graph can't draw it.
   */
  function order(ids, edges, nodes) {
    const parentsOf = new Map(ids.map((id) => [id, []]));
    for (const [c, p] of edges) parentsOf.get(c).push(p);

    const state = new Map();
    const cut = [];
    const kept = [];
    for (const start of ids) {
      if (state.has(start)) continue;
      const stack = [[start, 0]];
      state.set(start, 'open');
      while (stack.length) {
        const top = stack[stack.length - 1];
        const [id, i] = top;
        const ps = parentsOf.get(id);
        if (i >= ps.length) { state.set(id, 'done'); stack.pop(); continue; }
        top[1]++;
        const p = ps[i];
        if (state.get(p) === 'open') { cut.push([id, p]); continue; }
        kept.push([id, p]);
        if (!state.has(p)) { state.set(p, 'open'); stack.push([p, 0]); }
      }
    }

    // A dead reference has no year, so it sorts directly beneath the youngest
    // paper citing it. It reads as a short stub rather than a line to nowhere.
    const yearOf = new Map();
    for (const id of ids) yearOf.set(id, nodes[id].year);
    for (const [c, p] of kept) {
      if (yearOf.get(p) == null) yearOf.set(p, Math.max(yearOf.get(p) ?? -Infinity, yearOf.get(c) ?? -Infinity));
    }

    const pending = new Map(ids.map((id) => [id, 0]));
    const childrenOf = new Map(ids.map((id) => [id, []]));
    for (const [c, p] of kept) {
      pending.set(p, pending.get(p) + 1);
      childrenOf.get(c).push(p);
    }
    const before = (a, b) =>
      (yearOf.get(b) ?? -Infinity) - (yearOf.get(a) ?? -Infinity) ||
      (nodes[a].missing ? -1 : 0) - (nodes[b].missing ? -1 : 0) ||
      (nodes[b].cited || 0) - (nodes[a].cited || 0) ||
      (a < b ? -1 : 1);
    const ready = ids.filter((id) => pending.get(id) === 0);
    const rows = [];
    while (ready.length) {
      ready.sort(before);
      const id = ready.shift();
      rows.push(id);
      for (const p of childrenOf.get(id)) {
        pending.set(p, pending.get(p) - 1);
        if (pending.get(p) === 0) ready.push(p);
      }
    }
    return { rows, edges: kept, cut };
  }

  /*
   * Split the ancestry into sectors, one per resolved reference of the seed,
   * so every paper belongs to a single line of descent. Walking level by level,
   * a paper shared by several sectors goes to the smallest of them, which keeps
   * one heavily cited reference from swallowing the rest.
   */
  function assignSectors(seed, parentsOf, nodes) {
    const roots = parentsOf.get(seed).filter((id) => !nodes[id].missing);
    const sectorOf = new Map(roots.map((id, i) => [id, i]));
    const sizes = roots.map(() => 1);
    let level = roots;
    while (level.length) {
      const claims = new Map();
      for (const id of level) {
        for (const p of parentsOf.get(id)) {
          if (p === seed || sectorOf.has(p)) continue;
          if (!claims.has(p)) claims.set(p, []);
          claims.get(p).push(sectorOf.get(id));
        }
      }
      for (const [id, sectors] of claims) {
        const smallest = sectors.reduce((a, b) => (sizes[b] < sizes[a] || (sizes[b] === sizes[a] && b < a) ? b : a));
        sectorOf.set(id, smallest);
        sizes[smallest]++;
      }
      level = [...claims.keys()];
    }
    return { roots, sectorOf };
  }

  /*
   * Assign lanes, SourceTree style. Walk the rows top to bottom keeping a list
   * of open lanes, each waiting for one parent. A paper lands on the leftmost
   * lane waiting for it; its most-cited parent continues that lane (the
   * first-parent line reads as the paper's main inheritance) and the others
   * open new lanes, or join a lane already waiting for that parent. That join
   * is what a merge looks like: two papers sharing an ancestor.
   *
   * Lane 0 belongs to the seed's first-parent line alone, so the graph has one
   * straight spine, even where another paper reached a spine paper first.
   *
   * With `grouped`, every other lane belongs to one sector and sectors sit side
   * by side, so neighbouring lanes share a line of descent. That costs width, so
   * it's for views that wrap the lanes around. A paper's sector is reported on
   * its row, and `sectors` lists each one's root paper and, when grouped, span
   * of lanes.
   *
   * Returns { rows: [{ id, row, lane, color, sector }], edges, lanes, sectors, cut } where each
   * edge is { child, parent, from, to, fromLane, via, toLane, color, join } in
   * row/lane coordinates: leave `from`, run down lane `via`, arrive at `to`.
   * `join` marks an edge that merged into a lane already open, and `suspect`
   * one whose parent is dated well after its child.
   */
  function layout(ids, allEdges, nodes, { grouped = false } = {}) {
    const { rows, edges, cut } = order(ids, allEdges, nodes);
    const rowOf = new Map(rows.map((id, i) => [id, i]));
    const parentsOf = new Map(ids.map((id) => [id, []]));
    for (const [c, p] of edges) parentsOf.get(c).push(p);
    for (const ps of parentsOf.values()) {
      ps.sort((a, b) => (nodes[a].missing ? 1 : 0) - (nodes[b].missing ? 1 : 0) ||
        (nodes[b].cited || 0) - (nodes[a].cited || 0) || (a < b ? -1 : 1));
    }

    const spineNext = new Map();
    for (let id = rows[0], next; id; id = next) {
      next = parentsOf.get(id).find((p) => !nodes[p].missing);
      if (next) spineNext.set(id, next);
    }

    const { roots, sectorOf } = assignSectors(rows[0], parentsOf, nodes);
    const sectorFor = (id) => sectorOf.get(id) ?? 0;
    const groupFor = grouped ? sectorFor : () => 0;

    const lanes = [{ wants: rows[0], color: 0 }]; // lane index -> { wants: id, color } | null
    const laneSector = [null];
    let nextColor = 1;
    const openLane = (wants, color) => {
      const group = groupFor(wants);
      let i = lanes.findIndex((l, at) => at > 0 && l === null && laneSector[at] === group);
      if (i === -1) { i = lanes.length; lanes.push(null); laneSector.push(group); }
      lanes[i] = { wants, color };
      return i;
    };

    const placed = [];
    const paths = [];
    const arrivals = new Map(); // parent id -> paths still running toward it
    rows.forEach((id, row) => {
      const waiting = [];
      lanes.forEach((l, i) => { if (l && l.wants === id) waiting.push(i); });
      const lane = waiting.length ? waiting[0] : openLane(id, nextColor++);
      const color = lanes[lane].color;
      for (const i of waiting) lanes[i] = null;
      lanes[lane] = null;
      for (const p of arrivals.get(id) || []) p.toLane = lane;

      placed.push({ id, row, lane, color, sector: sectorFor(id) });

      parentsOf.get(id).forEach((pid, i) => {
        let via = lanes.findIndex((l) => l && l.wants === pid);
        let edgeColor;
        let join = false;
        if (spineNext.get(id) === pid) {
          via = 0;
          edgeColor = 0;
          lanes[0] = { wants: pid, color: 0 };
        } else if (via !== -1) {
          edgeColor = lanes[via].color;
          join = true;
        } else if (i === 0 && lane !== 0 && lanes[lane] === null && groupFor(pid) === laneSector[lane]) {
          via = lane;
          edgeColor = color;
          lanes[lane] = { wants: pid, color };
        } else {
          edgeColor = nextColor++;
          via = openLane(pid, edgeColor);
        }
        const path = { child: id, parent: pid, from: row, to: rowOf.get(pid), fromLane: lane, via, toLane: via, color: edgeColor, join, suspect: isSuspect(nodes[id], nodes[pid]) };
        paths.push(path);
        if (!arrivals.has(pid)) arrivals.set(pid, []);
        arrivals.get(pid).push(path);
      });
    });

    // Lanes were numbered as they opened; lay them out sector by sector.
    const sorted = lanes.map((_, i) => i).slice(1).sort((a, b) => laneSector[a] - laneSector[b] || a - b);
    const lanePosition = new Map([[0, 0], ...sorted.map((lane, i) => [lane, i + 1])]);
    for (const row of placed) row.lane = lanePosition.get(row.lane);
    for (const path of paths) {
      path.fromLane = lanePosition.get(path.fromLane);
      path.via = lanePosition.get(path.via);
      path.toLane = lanePosition.get(path.toLane);
    }
    const sectors = roots.map((id, sector) => {
      const held = grouped ? sorted.filter((lane) => laneSector[lane] === sector).map((lane) => lanePosition.get(lane)) : [];
      return { id, sector, first: held[0] ?? null, last: held[held.length - 1] ?? null, papers: placed.filter((r) => r.sector === sector && sectorOf.has(r.id)).length };
    });

    return { rows: placed, edges: paths, lanes: lanes.length, sectors, cut };
  }

  // Everything reachable from `id` in both directions, for tracing one
  // paper's line through the graph.
  function lineage(id, edges) {
    const up = new Map();
    const down = new Map();
    for (const e of edges) {
      if (!up.has(e.parent)) up.set(e.parent, []);
      up.get(e.parent).push(e.child);
      if (!down.has(e.child)) down.set(e.child, []);
      down.get(e.child).push(e.parent);
    }
    const walk = (start, next) => {
      const seen = new Set();
      const stack = [start];
      while (stack.length) {
        for (const n of next.get(stack.pop()) || []) {
          if (!seen.has(n)) { seen.add(n); stack.push(n); }
        }
      }
      return seen;
    };
    return new Set([id, ...walk(id, up), ...walk(id, down)]);
  }

  /*
   * What to show alongside a selected paper: its shortest line back to the
   * seed, then the papers citing it and the papers it cites, up to `limit`.
   */
  function connections(id, edges, limit = CONNECTION_LIMIT) {
    const citers = new Map();
    const cited = new Map();
    for (const e of edges) {
      if (!citers.has(e.parent)) citers.set(e.parent, []);
      citers.get(e.parent).push(e.child);
      if (!cited.has(e.child)) cited.set(e.child, []);
      cited.get(e.child).push(e.parent);
    }
    const via = new Map([[id, null]]);
    const queue = [id];
    let root = id;
    for (let i = 0; i < queue.length; i++) {
      const next = citers.get(queue[i]) || [];
      if (!next.length) { root = queue[i]; break; }
      for (const child of next) {
        if (!via.has(child)) { via.set(child, queue[i]); queue.push(child); }
      }
    }
    const keep = new Set();
    for (let at = root; at; at = via.get(at)) keep.add(at);
    for (const near of [...(citers.get(id) || []), ...(cited.get(id) || [])]) {
      if (keep.size >= limit) break;
      keep.add(near);
    }
    return keep;
  }

  // Rows whose lineage carries on past the view: resolved references exist, but
  // none are drawn. These are limits of the view, not ends of the trail.
  function frontier(layout, nodes) {
    const drawn = new Set();
    for (const e of layout.edges) if (!nodes[e.parent].missing) drawn.add(e.child);
    return layout.rows.filter((r) => nodes[r.id].resolvedCount > 0 && !drawn.has(r.id));
  }

  // Each visible paper's count of resolved references the view isn't drawing.
  function hiddenParents(view) {
    const drawn = new Map();
    for (const [child, parent] of view.edges) {
      if (!view.nodes[parent].missing) drawn.set(child, (drawn.get(child) || 0) + 1);
    }
    const hidden = new Map();
    for (const id of view.ids) {
      const node = view.nodes[id];
      hidden.set(id, (node.parentTotal ?? (node.parents || []).length) - (drawn.get(id) || 0));
    }
    return hidden;
  }

  /*
   * Rotate the graph: a fixed window of side lanes on a loop, so turning either
   * way brings the far side around. The spine stays pinned. Every paper keeps
   * its row: turning only fills or empties rows, and `compactRows` can close
   * the gaps.
   * A link leaving the window becomes a tail, merged per row and direction, at
   * whichever of its ends is in view. Each tail lists the papers it leads to.
   *
   * Papers in `keep` stay in view however it's turned, on extra lanes past the
   * window: `lanes` counts the window and spine, `drawnLanes` the extras too.
   *
   * Returns { rows, edges, stubs, lanes, drawnLanes, kept, offset, sideLanes, rotates, totalRows }.
   * Rows keep their `layout` numbers; lanes are renumbered for the window.
   */
  function windowView(layout, { offset = 0, width = 12, keep = new Set() } = {}) {
    const sideLanes = layout.lanes - 1;
    if (sideLanes <= width) {
      return { rows: layout.rows, edges: layout.edges, stubs: [], lanes: layout.lanes, drawnLanes: layout.lanes, kept: new Set(), offset: 0, sideLanes, rotates: false, totalRows: layout.rows.length };
    }
    const turned = ((offset % sideLanes) + sideLanes) % sideLanes;
    const place = (lane) => (lane - 1 - turned + sideLanes) % sideLanes;
    const inWindow = (lane) => lane === 0 || place(lane) < width;

    const extraLanes = new Set();
    for (const row of layout.rows) if (keep.has(row.id) && !inWindow(row.lane)) extraLanes.add(row.lane);
    for (const e of layout.edges) {
      if (!keep.has(e.child) || !keep.has(e.parent)) continue;
      for (const lane of [e.fromLane, e.via, e.toLane]) if (!inWindow(lane)) extraLanes.add(lane);
    }
    const extra = new Map([...extraLanes].sort((a, b) => a - b).map((lane, i) => [lane, width + 1 + i]));

    const visible = (lane) => {
      if (lane === 0) return 0;
      if (inWindow(lane)) return place(lane) + 1;
      return extra.get(lane) ?? null;
    };
    // Which way round is shorter to reach a lane that's out of view.
    const towards = (lane) => (place(lane) - width < sideLanes - place(lane) ? 1 : -1);

    const rows = [];
    const shown = new Set();
    const kept = new Set();
    for (const row of layout.rows) {
      if (keep.has(row.id)) kept.add(row.row);
      if (!inWindow(row.lane) && !keep.has(row.id)) continue;
      rows.push({ ...row, lane: visible(row.lane) });
      shown.add(row.id);
    }

    const edges = [];
    const stubs = new Map();
    const addStub = (row, lane, dir, color, link) => {
      const key = `${row}:${dir}`;
      if (!stubs.has(key)) stubs.set(key, { row, lane, dir, color, links: [] });
      stubs.get(key).links.push(link);
    };
    for (const e of layout.edges) {
      const [from, via, to] = [visible(e.fromLane), visible(e.via), visible(e.toLane)];
      const [showsChild, showsParent] = [shown.has(e.child), shown.has(e.parent)];
      if (showsChild && showsParent && via !== null) {
        edges.push({ ...e, fromLane: from, via, toLane: to });
        continue;
      }
      const away = [e.via, e.toLane, e.fromLane].find((lane) => visible(lane) === null) ?? e.toLane;
      if (showsChild) addStub(e.from, from, towards(away), e.color, { id: e.parent, cites: true });
      if (showsParent) addStub(e.to, to, towards(away), e.color, { id: e.child, cites: false });
    }
    return { rows, edges, stubs: [...stubs.values()], lanes: width + 1, drawnLanes: width + 1 + extra.size, kept, offset: turned, sideLanes, rotates: true, totalRows: layout.rows.length };
  }

  /*
   * Close the gaps between a window's filled rows. Rows keep their order, and
   * `from` on each row remembers its place in the full layout.
   */
  function compactRows(frame) {
    const position = new Map(frame.rows.map((row, i) => [row.row, i]));
    return {
      ...frame,
      rows: frame.rows.map((row, i) => ({ ...row, row: i, from: row.row })),
      edges: frame.edges.map((e) => ({ ...e, from: position.get(e.from), to: position.get(e.to) })),
      stubs: frame.stubs.map((stub) => ({ ...stub, row: position.get(stub.row) })),
      totalRows: frame.rows.length,
    };
  }

  // The rotation that centres a lane in the window.
  function offsetFor(lane, { width = 12, sideLanes }) {
    if (lane === 0) return null;
    return (lane - 1 - Math.floor(width / 2) + sideLanes) % sideLanes;
  }

  // How many papers measured down to `depth` the view leaves out.
  function hiddenCount(view, snapshot, depth) {
    const measured = snapshot.levels.filter((l) => l.depth <= depth).reduce((sum, l) => sum + l.papers, 0);
    const shown = new Set();
    for (const id of view.ids) {
      if (id === snapshot.seed) continue;
      if (view.nodes[id].missing) view.nodes[id].deadIds.forEach((d) => shown.add(d));
      else shown.add(id);
    }
    return Math.max(0, measured - shown.size);
  }

  return { select, order, layout, lineage, connections, rankParents, frontier, hiddenCount, hiddenParents, isSuspect, windowView, compactRows, offsetFor };
});
