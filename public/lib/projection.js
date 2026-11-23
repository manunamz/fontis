/*
 * projection.js — where a paper lands on the cone, and how much of a big tree
 * to draw while it spins. Fast enough to run on every paper every frame, so it writes into
 * buffers rather than allocating.
 *
 * Pure functions, no DOM: loaded as a classic script in the browser (as the
 * global `Projection`) and required directly by the tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Projection = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CONE_TILT = 0.3;
  const CONE_DEPTH = 0.3; // how much nearer the front is drawn than the back
  const TILT_COS = Math.cos(CONE_TILT);
  const TILT_SIN = Math.sin(CONE_TILT);
  const MIN_LINKS = 3000;
  const MAX_LINKS = 40000;
  const KEEPING_UP_MS = 20;
  const FALLING_BEHIND_MS = 30;
  const PAUSED_MS = 200; // a gap this long isn't a slow frame, the cone had stopped

  // Screen position of one point on the cone, plus how far towards you it is (-1 to 1).
  function conePoint({ radius, length, cx, top }, theta, drop) {
    const x = Math.sin(theta) * drop;
    const near = Math.cos(theta) * drop;
    return {
      x: cx + x * radius * (1 + near * CONE_DEPTH),
      y: top + drop * length * TILT_COS + near * radius * TILT_SIN,
      near,
    };
  }

  // `conePoint` for every paper at once, turned by `spin`.
  function project(angle, drop, { radius, length, cx, top }, spin, { xs, ys, nears }) {
    const rise = length * TILT_COS;
    const lean = radius * TILT_SIN;
    for (let i = 0; i < angle.length; i++) {
      const theta = angle[i] - spin;
      const d = drop[i];
      const near = Math.cos(theta) * d;
      xs[i] = cx + Math.sin(theta) * d * radius * (1 + near * CONE_DEPTH);
      ys[i] = top + d * rise + near * lean;
      nears[i] = near;
    }
  }

  // How many links to draw next, given the last gap between frames in ms. It
  // falls fast and climbs slowly, so a slow machine settles rather than stutters.
  function adjustDetail(links, gap) {
    if (gap > PAUSED_MS || (gap >= KEEPING_UP_MS && gap <= FALLING_BEHIND_MS)) return links;
    if (gap > FALLING_BEHIND_MS) return Math.max(MIN_LINKS, links / 2);
    return Math.min(MAX_LINKS, links * 1.1);
  }

  // Copy into `out` the links whose bounds meet `box`, and return how many
  // numbers that took. Zoomed in, this is what lets the view show more detail.
  function linksInView(pairs, xs, ys, { left, right, top, bottom }, out) {
    let kept = 0;
    for (let i = 0; i < pairs.length; i += 2) {
      const [a, b] = [pairs[i], pairs[i + 1]];
      const [ax, bx, ay, by] = [xs[a], xs[b], ys[a], ys[b]];
      if ((ax < left && bx < left) || (ax > right && bx > right) || (ay < top && by < top) || (ay > bottom && by > bottom)) continue;
      out[kept++] = a;
      out[kept++] = b;
    }
    return kept;
  }

  return { CONE_TILT, MAX_LINKS, conePoint, project, adjustDetail, linksInView };
});
