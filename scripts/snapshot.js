#!/usr/bin/env node
/*
 * snapshot.js — crawl a paper's ancestry from OpenAlex into public/snapshots/.
 *
 *   node scripts/snapshot.js <slug> <arXiv id | DOI | OpenAlex id> [--depth 3] [--detail n] [--single]
 *   node scripts/snapshot.js attention 1706.03762 --depth 4 --detail 3
 *   node scripts/snapshot.js watson-crick 10.1038/171737a0 --depth 4 --single
 *
 * Every level is fetched in full so the per-level counts are measured. Each
 * paper then gets three files, rewritten as each level at or past --detail
 * (default: --depth) finishes:
 *
 *   <slug>.json       the first load: each paper's top references, down to --detail
 *   <slug>.full.json  every paper and link down to --detail, fetched on expand
 *   <slug>.tree.json  one dot per paper down to --depth, for the overview
 *
 * List calls cost $0.0001 for 50 papers from a $0.10 daily anonymous budget.
 * Single lookups are free but run at about 4 papers a second, so --single, or
 * running out of budget mid-crawl, keeps going at that pace. Fetched papers
 * land in .snapshot-cache/, so a long crawl can pick up where it stopped.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const API = 'https://api.openalex.org';
const SELECT = 'id,title,publication_year,referenced_works,type,cited_by_count,doi,ids,locations,authorships,primary_topic,is_retracted';
const BATCH = 50;
const THROTTLE_MS = 120;
const FIRST_LOAD_PARENTS = 5; // the most the parents-per-paper control can ask for
const CACHE_DIR = path.join(__dirname, '..', '.snapshot-cache');
const STATUS = { continues: 0, noRefs: 1, dead: 2, retracted: 3 };

const shortId = (url) => url.split('/').pop();

// OpenAlex has no arXiv id field; it shows up in a location's URL or the DOI.
function arxivId(work) {
  const urls = (work.locations || []).map((l) => l.landing_page_url || '');
  for (const url of [...urls, work.doi || '']) {
    const hit = url.match(/arxiv\.org\/(?:abs|pdf)\/(.+?)(?:v\d+)?(?:\.pdf)?$/i) || url.match(/10\.48550\/arxiv\.(.+)$/i);
    if (hit) return hit[1];
  }
  return null;
}

function toNode(work) {
  const authors = (work.authorships || []).map((a) => a.author && a.author.display_name).filter(Boolean);
  const ids = work.ids || {};
  return {
    id: shortId(work.id),
    title: (work.title || '(untitled)').replace(/<[^>]+>/g, ''), // titles can carry inline markup
    year: work.publication_year,
    cited: work.cited_by_count || 0,
    type: work.type,
    doi: work.doi ? work.doi.replace('https://doi.org/', '') : null,
    arxiv: arxivId(work),
    pmid: ids.pmid ? shortId(ids.pmid) : null,
    pmcid: ids.pmcid ? shortId(ids.pmcid.replace(/\/$/, '')).replace(/^PMC/i, '') : null,
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
    if (res.status === 429) throw Object.assign(new Error('OpenAlex budget exhausted (429)'), { budget: true });
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
async function resolve(ids, state, get, single = false) {
  const { works, dead, aliases, remember } = state;
  const todo = ids.filter((id) => !works.has(id) && !dead.has(id) && !aliases.has(id));
  const skipped = single ? todo : [];
  for (let i = 0; !single && i < todo.length; i += BATCH) {
    const chunk = todo.slice(i, i + BATCH);
    let data;
    try {
      data = await get(`${API}/works?filter=openalex:${chunk.join('|')}&per_page=${BATCH}&select=${SELECT}`);
    } catch (e) {
      if (!e.budget) throw e;
      console.error('list budget spent; carrying on with free single lookups');
      skipped.push(...todo.slice(i));
      state.single = true;
      break;
    }
    const found = new Set();
    for (const work of (data ? data.results : [])) {
      const node = toNode(work);
      works.set(node.id, node);
      found.add(node.id);
      remember({ node });
    }
    skipped.push(...chunk.filter((id) => !found.has(id)));
  }
  for (const id of skipped) {
    const work = await get(`${API}/works/${id}?select=${SELECT}`);
    if (!work) { dead.add(id); remember({ dead: id }); continue; }
    const node = toNode(work);
    works.set(node.id, node);
    remember({ node });
    if (node.id !== id) { aliases.set(id, node.id); remember({ alias: [id, node.id] }); }
  }
}

async function crawl(seedRef, depth, get, { single = false, cached = [], remember = () => {}, onLevel = async () => {} } = {}) {
  const state = { works: new Map(), dead: new Set(), aliases: new Map(), remember, single };
  for (const entry of cached) {
    if (entry.node) state.works.set(entry.node.id, entry.node);
    if (entry.dead) state.dead.add(entry.dead);
    if (entry.alias) state.aliases.set(...entry.alias);
  }
  const seedWork = await get(`${API}/works/${seedRef}?select=${SELECT}`);
  if (!seedWork) throw new Error(`no such work: ${seedRef}`);
  const seed = toNode(seedWork);
  state.works.set(seed.id, seed);

  const canon = (id) => state.aliases.get(id) || id;
  const levels = [];
  const depthOf = new Map([[seed.id, 0]]);
  let frontier = [seed.id];
  for (let d = 1; d <= depth; d++) {
    const refs = new Set();
    for (const id of frontier) for (const ref of state.works.get(id).refs) refs.add(ref);
    await resolve([...refs], state, get, state.single);
    const fresh = [...new Set([...refs].map(canon))].filter((id) => !depthOf.has(id));
    fresh.forEach((id) => depthOf.set(id, d));
    const live = fresh.filter((id) => state.works.has(id));
    const zero = live.filter((id) => state.works.get(id).refs.length === 0);
    levels.push({ depth: d, papers: fresh.length, dead: fresh.length - live.length, zeroRefs: zero.length, withRefs: live.length - zero.length });
    console.error(`depth ${d}: ${fresh.length} papers, ${fresh.length - live.length} dead, ${zero.length} with no references`);
    frontier = live;
    await onLevel(d, { seed: seed.id, ...state, levels, canon, depthOf });
  }
  return { seed: seed.id, ...state, levels, canon, depthOf };
}

// Reduce the crawl to what the UI reads. Papers at the depth limit keep their
// counts, but their references were never fetched, so they have no parents.
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
      const parents = d === depth ? [] : ranked;
      const gone = d === depth ? [] : refs.filter((r) => dead.has(r));
      const { refs: _omit, ...rest } = work;
      nodes[id] = { ...rest, refCount: work.refs.length, resolvedCount: live.length, parents, dead: gone };
      for (const r of parents) if (!kept.has(r)) { kept.add(r); next.push(r); }
    }
    level = next;
  }
  return { seed, nodes, levels };
}

// The first load: what the default view can reach. `parentTotal` keeps the real
// count, so a row can offer to expand before the full file has arrived.
function firstLoad(full) {
  const nodes = {};
  const queue = [full.seed];
  while (queue.length) {
    const id = queue.pop();
    if (nodes[id]) continue;
    const node = full.nodes[id];
    const parents = node.parents.slice(0, FIRST_LOAD_PARENTS);
    nodes[id] = { ...node, parents, parentTotal: node.parents.length };
    queue.push(...parents);
  }
  return { ...full, nodes, partial: true };
}

// One dot per paper, in crawl order, as parallel arrays: years, depths and
// statuses for everything; ids only down to `detail`, where a dot can open a row.
function treeColumns({ seed, works, dead, depthOf, levels }, detail) {
  const tree = { seed, detail, levels, years: [], depths: [], statuses: [], ids: [] };
  for (const [id, depth] of depthOf) {
    const work = works.get(id);
    tree.years.push(work ? work.year || 0 : 0);
    tree.depths.push(depth);
    if (!work) tree.statuses.push(STATUS.dead);
    else if (work.retracted) tree.statuses.push(STATUS.retracted);
    else tree.statuses.push(work.refs.length ? STATUS.continues : STATUS.noRefs);
    if (depth <= detail) tree.ids.push(id);
  }
  return tree;
}

function writeFiles(slug, result, detail) {
  const stamp = { source: 'OpenAlex', fetched: new Date().toISOString().slice(0, 10) };
  const full = { ...prune(result, detail), detail, ...stamp };
  const files = { '': firstLoad(full), '.full': full, '.tree': { ...treeColumns(result, detail), ...stamp } };
  const dir = path.join(__dirname, '..', 'public', 'snapshots');
  fs.mkdirSync(dir, { recursive: true });
  for (const [suffix, data] of Object.entries(files)) {
    const out = path.join(dir, `${slug}${suffix}.json`);
    fs.writeFileSync(`${out}.tmp`, JSON.stringify(data));
    fs.renameSync(`${out}.tmp`, out);
    console.error(`wrote ${path.basename(out)}: ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
  }
}

// A crawl stopped mid-write leaves a torn last line; that paper is just refetched.
function readCache(text) {
  const entries = [];
  for (const line of text.split('\n').filter(Boolean)) {
    try { entries.push(JSON.parse(line)); } catch { /* torn line */ }
  }
  return entries;
}

function option(argv, name, fallback) {
  const at = argv.indexOf(name);
  return at === -1 ? fallback : Number(argv[at + 1]);
}

async function main(argv) {
  const single = argv.includes('--single');
  const [slug, ref] = argv.filter((a, i) => !a.startsWith('--') && !['--depth', '--detail'].includes(argv[i - 1]));
  const depth = option(argv, '--depth', 3);
  const detail = option(argv, '--detail', depth);
  if (!slug || !ref) {
    console.error('usage: node scripts/snapshot.js <slug> <arXiv id | DOI | OpenAlex id> [--depth 3] [--detail n] [--single]');
    process.exit(1);
  }
  const seedRef = /^W\d+$/.test(ref) ? ref : ref.startsWith('10.') ? `doi:${ref}` : `doi:10.48550/arXiv.${ref}`;

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cacheFile = path.join(CACHE_DIR, `${slug}.jsonl`);
  const cached = fs.existsSync(cacheFile) ? readCache(fs.readFileSync(cacheFile, 'utf8')) : [];
  if (cached.length) console.error(`resuming with ${cached.length} cached entries`);
  const cache = fs.createWriteStream(cacheFile, { flags: 'a' });

  await crawl(seedRef, depth, openalexGet, {
    single,
    cached,
    remember: (entry) => cache.write(`${JSON.stringify(entry)}\n`),
    onLevel: async (d, result) => { if (d >= detail) writeFiles(slug, result, detail); },
  });
  cache.end();
}

if (require.main === module) main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });

module.exports = { crawl, prune, resolve, toNode, firstLoad, treeColumns, readCache };
