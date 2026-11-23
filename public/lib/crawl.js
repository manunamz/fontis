/*
 * crawl.js — walk a paper's ancestry through OpenAlex and shape it for the page.
 *
 * Every level is fetched in full so the per-level counts are measured. List
 * calls cost $0.0001 for 50 papers from a $0.10 daily anonymous budget. Single
 * lookups are free but run at about 4 papers a second, so running out of budget
 * mid-crawl keeps going at that pace.
 *
 * No DOM: loaded as a classic script in the browser (as the global `Crawl`)
 * and required by the snapshot script and the tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Crawl = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const API = 'https://api.openalex.org';
  const SELECT = 'id,title,publication_year,referenced_works,type,cited_by_count,doi,ids,locations,authorships,primary_topic,is_retracted';
  const BATCH = 50;
  const THROTTLE_MS = 120;
  const FIRST_LOAD_PARENTS = 5; // the most the parents-per-paper control can ask for
  const STATUS = { continues: 0, noRefs: 1, dead: 2, retracted: 3 };

  // A DOI, arXiv ID or OpenAlex ID as OpenAlex's single-work route takes it, or
  // null for anything else. URLs and `doi:` or `arXiv:` prefixes are fine.
  function parseRef(text) {
    const ref = text.trim();
    const doi = ref.match(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)?(10\.\d{4,9}\/\S+)$/i);
    if (doi) return `doi:${doi[1]}`;
    const arxiv = ref.match(/^(?:https?:\/\/arxiv\.org\/(?:abs|pdf)\/|arxiv:\s*)?(\d{4}\.\d{4,5})(?:v\d+)?(?:\.pdf)?$/i);
    if (arxiv) return `doi:10.48550/arXiv.${arxiv[1]}`;
    const openalex = ref.match(/^(?:https?:\/\/openalex\.org\/)?(W\d+)$/i);
    return openalex ? openalex[1].toUpperCase() : null;
  }

  async function openalexGet(url, options) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch(url, options).catch(() => null); // a dropped connection counts as a failed try
      await new Promise((r) => setTimeout(r, THROTTLE_MS));
      if (res && res.status === 404) return null;
      if (res && res.status === 429) throw Object.assign(new Error('OpenAlex budget exhausted (429)'), { budget: true });
      if (res && res.ok) return res.json();
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(`OpenAlex request kept failing: ${url}`);
  }

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

  /*
   * Resolve ids into `works`. A batch query silently omits ids that were merged
   * into another record, so anything it skips is retried alone: the single-work
   * route follows the redirect, and only a real 404 counts as dead. Merged ids
   * land in `aliases`.
   */
  async function resolve(ids, state, get, single = false) {
    const { works, dead, aliases, remember, onSpent } = state;
    const todo = ids.filter((id) => !works.has(id) && !dead.has(id) && !aliases.has(id));
    const skipped = single ? todo : [];
    for (let i = 0; !single && i < todo.length; i += BATCH) {
      const chunk = todo.slice(i, i + BATCH);
      let data;
      try {
        data = await get(`${API}/works?filter=openalex:${chunk.join('|')}&per_page=${BATCH}&select=${SELECT}`);
      } catch (e) {
        if (!e.budget) throw e;
        onSpent();
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

  async function crawl(seedRef, depth, get, { single = false, cached = [], remember = () => {}, onSpent = () => {}, onDepth = () => {}, onLevel = async () => {} } = {}) {
    const state = { works: new Map(), dead: new Set(), aliases: new Map(), remember, onSpent, single };
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
      if (!refs.size) break; // every line ended above this depth
      onDepth(d, refs.size);
      await resolve([...refs], state, get, state.single);
      const fresh = [...new Set([...refs].map(canon))].filter((id) => !depthOf.has(id));
      fresh.forEach((id) => depthOf.set(id, d));
      const live = fresh.filter((id) => state.works.has(id));
      const zero = live.filter((id) => state.works.get(id).refs.length === 0);
      levels.push({ depth: d, papers: fresh.length, dead: fresh.length - live.length, zeroRefs: zero.length, withRefs: live.length - zero.length });
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

  // The three files a paper's page reads, from a crawl finished through `detail`.
  function shape(result, detail) {
    const stamp = { source: 'OpenAlex', fetched: new Date().toISOString().slice(0, 10) };
    const full = { ...prune(result, detail), detail, ...stamp };
    return { first: firstLoad(full), full, tree: { ...treeColumns(result, detail), ...stamp } };
  }

  return { API, SELECT, parseRef, openalexGet, crawl, prune, resolve, toNode, firstLoad, treeColumns, shape };
});
