#!/usr/bin/env node
/*
 * snapshot.js — crawl a paper's ancestry from OpenAlex into public/snapshots/.
 *
 *   node scripts/snapshot.js <slug> <arXiv id | DOI | OpenAlex id> [--depth 3] [--single]
 *   node scripts/snapshot.js attention 1706.03762
 *   node scripts/snapshot.js watson-crick 10.1038/171737a0 --depth 4 --single
 *
 * Every level is fetched in full so the per-level counts are measured, then
 * the saved file keeps only what the UI can draw: each paper's top references
 * plus all of its dead ones. A depth-3 crawl of a 28-reference paper costs
 * about 130 list calls, or $0.013 of the $0.10 anonymous daily budget. Single
 * lookups are free, so --single keeps working when that budget runs out, at
 * about 8 papers a second.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const API = 'https://api.openalex.org';
const SELECT = 'id,title,publication_year,referenced_works,type,cited_by_count,doi,authorships,primary_topic,is_retracted';
const BATCH = 50;
const KEEP_PARENTS = 5;
const THROTTLE_MS = 120;

const shortId = (url) => url.split('/').pop();

function toNode(work) {
  const authors = (work.authorships || []).map((a) => a.author && a.author.display_name).filter(Boolean);
  return {
    id: shortId(work.id),
    title: (work.title || '(untitled)').replace(/<[^>]+>/g, ''), // titles can carry inline markup
    year: work.publication_year,
    cited: work.cited_by_count || 0,
    type: work.type,
    doi: work.doi ? work.doi.replace('https://doi.org/', '') : null,
    authors: authors.slice(0, 3),
    authorCount: authors.length,
    field: work.primary_topic && work.primary_topic.field ? work.primary_topic.field.display_name : null,
    retracted: !!work.is_retracted,
    refs: (work.referenced_works || []).map(shortId),
  };
}

async function openalexGet(url) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': 'pprhub-snapshot' } });
    await new Promise((r) => setTimeout(r, THROTTLE_MS));
    if (res.status === 404) return null;
    if (res.status === 429) throw new Error('OpenAlex budget exhausted (429); try again tomorrow');
    if (res.ok) return res.json();
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`OpenAlex request kept failing: ${url}`);
}

/*
 * Resolve ids into `works`. A batch query silently omits ids that were merged
 * into another record, so anything it skips is retried alone: the single-work
 * route follows the redirect, and only a real 404 counts as dead. Merged ids
 * land in `aliases`.
 */
async function resolve(ids, { works, dead, aliases }, get, single = false) {
  const todo = ids.filter((id) => !works.has(id) && !dead.has(id) && !aliases.has(id));
  const skipped = single ? todo : [];
  for (let i = 0; !single && i < todo.length; i += BATCH) {
    const chunk = todo.slice(i, i + BATCH);
    const data = await get(`${API}/works?filter=openalex:${chunk.join('|')}&per_page=${BATCH}&select=${SELECT}`);
    const found = new Set();
    for (const work of (data ? data.results : [])) {
      const node = toNode(work);
      works.set(node.id, node);
      found.add(node.id);
    }
    skipped.push(...chunk.filter((id) => !found.has(id)));
  }
  for (const id of skipped) {
    const work = await get(`${API}/works/${id}?select=${SELECT}`);
    if (!work) { dead.add(id); continue; }
    const node = toNode(work);
    works.set(node.id, node);
    if (node.id !== id) aliases.set(id, node.id);
  }
}

async function crawl(seedRef, depth, get, { single = false } = {}) {
  const state = { works: new Map(), dead: new Set(), aliases: new Map() };
  const seedWork = await get(`${API}/works/${seedRef}?select=${SELECT}`);
  if (!seedWork) throw new Error(`no such work: ${seedRef}`);
  const seed = toNode(seedWork);
  state.works.set(seed.id, seed);

  const canon = (id) => state.aliases.get(id) || id;
  const levels = [];
  const seen = new Set([seed.id]);
  let frontier = [seed.id];
  for (let d = 1; d <= depth; d++) {
    const refs = new Set();
    for (const id of frontier) for (const ref of state.works.get(id).refs) refs.add(ref);
    await resolve([...refs], state, get, single);
    const fresh = [...new Set([...refs].map(canon))].filter((id) => !seen.has(id));
    fresh.forEach((id) => seen.add(id));
    const live = fresh.filter((id) => state.works.has(id));
    const zero = live.filter((id) => state.works.get(id).refs.length === 0);
    levels.push({ depth: d, papers: fresh.length, dead: fresh.length - live.length, zeroRefs: zero.length, withRefs: live.length - zero.length });
    console.error(`depth ${d}: ${fresh.length} papers, ${fresh.length - live.length} dead, ${zero.length} with no references`);
    frontier = live;
  }
  return { seed: seed.id, ...state, levels, canon };
}

// Keep what the UI draws: all of the seed's references, the top few of
// everyone else's, and every dead reference along those lines.
function prune({ seed, works, dead, canon, levels }, depth) {
  const nodes = {};
  let level = [seed];
  const kept = new Set(level);
  for (let d = 0; d <= depth && level.length; d++) {
    const next = [];
    for (const id of level) {
      const work = works.get(id);
      const refs = [...new Set(work.refs.map(canon))];
      const live = refs.filter((r) => works.has(r));
      const ranked = live.sort((a, b) => works.get(b).cited - works.get(a).cited);
      const parents = d === depth ? [] : (id === seed ? ranked : ranked.slice(0, KEEP_PARENTS));
      const gone = d === depth ? [] : refs.filter((r) => dead.has(r));
      const { refs: _omit, ...rest } = work;
      nodes[id] = { ...rest, refCount: work.refs.length, resolvedCount: live.length, parents, dead: gone };
      for (const r of parents) if (!kept.has(r)) { kept.add(r); next.push(r); }
    }
    level = next;
  }
  return { seed, nodes, levels };
}

async function main(argv) {
  const single = argv.includes('--single');
  const [slug, ref] = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--depth');
  const depthAt = argv.indexOf('--depth');
  const depth = depthAt === -1 ? 3 : Number(argv[depthAt + 1]);
  if (!slug || !ref) {
    console.error('usage: node scripts/snapshot.js <slug> <arXiv id | DOI | OpenAlex id> [--depth 3] [--single]');
    process.exit(1);
  }
  const seedRef = /^W\d+$/.test(ref) ? ref : ref.startsWith('10.') ? `doi:${ref}` : `doi:10.48550/arXiv.${ref}`;
  const result = await crawl(seedRef, depth, openalexGet, { single });
  const snapshot = { ...prune(result, depth), source: 'OpenAlex', fetched: new Date().toISOString().slice(0, 10) };
  const out = path.join(__dirname, '..', 'public', 'snapshots', `${slug}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(snapshot));
  console.error(`wrote ${out}: ${Object.keys(snapshot.nodes).length} nodes, ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
}

if (require.main === module) main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });

module.exports = { crawl, prune, resolve, toNode };
