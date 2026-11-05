/*
 * graph.js — draw a Lineage layout as an SVG commit graph, one row per paper.
 */
'use strict';

const ROW_H = 30;
const LANE_W = 16;
const GRAPH_PAD = 12;
const SIDE_COLORS = 4;
const FADE_LENGTH = 20;
const STUB_REACH = 14;
const STUB_DROP = 9;
const SVG_NS = 'http://www.w3.org/2000/svg';

const laneX = (lane) => GRAPH_PAD + lane * LANE_W;
const rowY = (row) => row * ROW_H + ROW_H / 2;
const graphWidth = (lanes) => GRAPH_PAD * 2 + Math.max(lanes - 1, 0) * LANE_W;

// Color 0 is the spine; everything else shares a few quieter colors.
const colorIndex = (color) => (color === 0 ? 0 : 1 + (color - 1) % SIDE_COLORS);

// A curve from one lane to another across the height of a single row.
function hop(x1, y1, x2, y2) {
  const mid = (y1 + y2) / 2;
  return `C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`;
}

function edgePath(e) {
  const x1 = laneX(e.fromLane);
  const y1 = rowY(e.from);
  const y2 = rowY(e.to);
  if (e.to === e.from + 1) return `M ${x1} ${y1} ${hop(x1, y1, laneX(e.toLane), y2)}`;
  const via = laneX(e.via);
  const parts = [`M ${x1} ${y1}`];
  if (e.fromLane !== e.via) parts.push(hop(x1, y1, via, rowY(e.from + 1)));
  parts.push(`L ${via} ${rowY(e.to - 1)}`);
  parts.push(hop(via, rowY(e.to - 1), laneX(e.toLane), y2));
  return parts.join(' ');
}

function svgEl(name, attrs) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function nodeMark(row, node, isSeed) {
  const x = laneX(row.lane);
  const y = rowY(row.row);
  const cls = `lane-${colorIndex(row.color)}`;
  if (node.missing) {
    return svgEl('path', { d: `M ${x - 4} ${y - 4} l 8 8 m 0 -8 l -8 8`, class: 'mark-dead' });
  }
  if (node.refCount === 0) {
    return svgEl('rect', { x: x - 4, y: y - 4, width: 8, height: 8, class: `mark-root ${cls}` });
  }
  return svgEl('circle', { cx: x, cy: y, r: isSeed ? 6 : 4, class: `mark ${cls}${isSeed ? ' mark-seed' : ''}` });
}

function fadeDefs() {
  const defs = svgEl('defs', {});
  for (let i = 0; i <= SIDE_COLORS; i++) {
    const gradient = svgEl('linearGradient', { id: `fade-${i}`, x1: 0, y1: 0, x2: 0, y2: 1 });
    gradient.append(
      svgEl('stop', { offset: '0%', style: `stop-color: var(--lane-${i}); stop-opacity: 1` }),
      svgEl('stop', { offset: '100%', style: `stop-color: var(--lane-${i}); stop-opacity: 0` }),
    );
    defs.appendChild(gradient);
  }
  return defs;
}

// A rect rather than a stroke: a gradient can't span a straight line's empty bounding box.
function fadeStub(row) {
  const stub = svgEl('rect', {
    x: laneX(row.lane) - 1,
    y: rowY(row.row),
    width: 2,
    height: FADE_LENGTH,
    class: 'fade',
    fill: `url(#fade-${colorIndex(row.color)})`,
  });
  stub.dataset.id = row.id;
  return stub;
}

// A tail for links that leave the window, leaning the way they went.
function stubPath(stub) {
  const x = laneX(stub.lane);
  const y = rowY(stub.row);
  return `M ${x} ${y} q ${stub.dir * 7} 1 ${stub.dir * STUB_REACH} ${STUB_DROP}`;
}

function drawGraph(layout, nodes, seed, frontier) {
  const svg = svgEl('svg', {
    class: 'graph',
    width: graphWidth(layout.lanes),
    height: layout.totalRows * ROW_H,
    'aria-hidden': 'true',
  });
  svg.appendChild(fadeDefs());
  for (const e of layout.edges) {
    const dead = nodes[e.parent].missing;
    const path = svgEl('path', {
      d: edgePath(e),
      class: `edge lane-${colorIndex(e.color)}${dead ? ' edge-dead' : ''}${e.join ? ' edge-join' : ''}${e.suspect ? ' edge-suspect' : ''}`,
    });
    path.dataset.child = e.child;
    path.dataset.parent = e.parent;
    svg.appendChild(path);
  }
  for (const stub of layout.stubs) {
    svg.appendChild(svgEl('path', { d: stubPath(stub), class: `stub lane-${colorIndex(stub.color)}` }));
  }
  for (const row of layout.rows) if (frontier.has(row.id)) svg.appendChild(fadeStub(row));
  for (const row of layout.rows) {
    const mark = nodeMark(row, nodes[row.id], row.id === seed);
    mark.dataset.id = row.id;
    svg.appendChild(mark);
  }
  return svg;
}
