'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { crawl, prune, toNode, firstLoad, treeColumns, readCache } = require('../../scripts/snapshot');
const { parseRef } = require('../../public/lib/crawl');

const work = (id, cited, refs = []) => ({
  id: `https://openalex.org/${id}`,
  title: id,
  publication_year: 2000,
  cited_by_count: cited,
  referenced_works: refs.map((r) => `https://openalex.org/${r}`),
});

// A stand-in for the OpenAlex API. `merged` maps an old id to the record it
// now redirects to: batch queries skip it, the single-work route follows it.
function fakeApi(records, merged = {}) {
  return async (url) => {
    const batch = url.match(/filter=openalex:([^&]+)/);
    if (batch) {
      const ids = batch[1].split('|');
      return { results: ids.filter((id) => records[id]).map((id) => records[id]) };
    }
    const id = url.match(/works\/([^?]+)/)[1];
    return records[id] || records[merged[id]] || null;
  };
}

const records = {
  W1: work('W1', 100, ['W2', 'W3', 'W9', 'W7']),
  W2: work('W2', 50, ['W4']),
  W3: work('W3', 10),
  W4: work('W4', 5),
  W8: work('W8', 20),
};

test('a batch-skipped id is dead only if the single-work route 404s too', async () => {
  const out = await crawl('W1', 2, fakeApi(records, { W7: 'W8' }));
  assert.ok(out.dead.has('W9'));
  assert.ok(!out.dead.has('W7'));
  assert.equal(out.aliases.get('W7'), 'W8');
});

test('per-level counts separate dead, zero-reference, and continuing papers', async () => {
  const out = await crawl('W1', 2, fakeApi(records, { W7: 'W8' }));
  assert.deepEqual(out.levels[0], { depth: 1, papers: 4, dead: 1, zeroRefs: 2, withRefs: 1 });
  assert.deepEqual(out.levels[1], { depth: 2, papers: 1, dead: 0, zeroRefs: 1, withRefs: 0 });
});

test('prune keeps dead references and rewrites merged ids to their new record', async () => {
  const out = prune(await crawl('W1', 2, fakeApi(records, { W7: 'W8' })), 2);
  assert.deepEqual(out.nodes.W1.dead, ['W9']);
  assert.equal(out.nodes.W9, undefined);
  assert.deepEqual(out.nodes.W1.parents, ['W2', 'W8', 'W3']);
  assert.equal(out.nodes.W1.refCount, 4);
  assert.equal(out.nodes.W1.resolvedCount, 3);
});

test('papers at the depth limit keep their counts but no parents', async () => {
  const out = prune(await crawl('W1', 1, fakeApi(records, { W7: 'W8' })), 1);
  assert.deepEqual(out.nodes.W2.parents, []);
  assert.equal(out.nodes.W2.refCount, 1);
});

test('--single resolves everything without touching the batch route', async () => {
  const api = fakeApi(records, { W7: 'W8' });
  const urls = [];
  const out = await crawl('W1', 2, (url) => { urls.push(url); return api(url); }, { single: true });
  assert.ok(urls.every((u) => !u.includes('filter=')));
  assert.deepEqual(out.levels, (await crawl('W1', 2, api)).levels);
});

test('toNode finds arXiv ids in locations and the DOI, dropping the version', () => {
  const at = (url) => ({ ...work('W1', 1), locations: [{ landing_page_url: url }] });
  assert.equal(toNode(at('http://arxiv.org/abs/1706.03762')).arxiv, '1706.03762');
  assert.equal(toNode(at('https://arxiv.org/pdf/1706.03762v5')).arxiv, '1706.03762');
  assert.equal(toNode(at('https://arxiv.org/abs/hep-th/9711200v3')).arxiv, 'hep-th/9711200');
  assert.equal(toNode({ ...work('W1', 1), doi: 'https://doi.org/10.48550/arxiv.1706.03762' }).arxiv, '1706.03762');
  assert.equal(toNode(at('https://doi.org/10.1038/171737a0')).arxiv, null);
});

test('toNode keeps bare PubMed and PMC ids', () => {
  const node = toNode({
    ...work('W1', 1),
    ids: { pmid: 'https://pubmed.ncbi.nlm.nih.gov/13054692', pmcid: 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC123456/' },
  });
  assert.equal(node.pmid, '13054692');
  assert.equal(node.pmcid, '123456');
});

test('a spent budget falls back to single lookups instead of failing', async () => {
  const api = fakeApi(records, { W7: 'W8' });
  const out = await crawl('W1', 2, async (url) => {
    if (url.includes('filter=')) throw Object.assign(new Error('429'), { budget: true });
    return api(url);
  });
  assert.deepEqual(out.levels, (await crawl('W1', 2, api)).levels);
});

test('a crawl resumes from cached papers without fetching them again', async () => {
  const api = fakeApi(records, { W7: 'W8' });
  const entries = [];
  const first = await crawl('W1', 2, api, { remember: (e) => entries.push(e) });
  const urls = [];
  const again = await crawl('W1', 2, (url) => { urls.push(url); return api(url); }, { cached: entries });
  assert.equal(urls.length, 1); // only the seed
  assert.deepEqual(again.levels, first.levels);
});

test('firstLoad caps parents but remembers the real count', async () => {
  const many = { W1: work('W1', 100, ['W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8']) };
  for (let i = 2; i <= 8; i++) many[`W${i}`] = work(`W${i}`, 100 - i);
  const small = firstLoad(prune(await crawl('W1', 2, fakeApi(many)), 2));
  assert.equal(small.partial, true);
  assert.equal(small.nodes.W1.parents.length, 5);
  assert.equal(small.nodes.W1.parentTotal, 7);
  assert.equal(small.nodes.W8, undefined);
});

test('treeColumns gives every paper a dot and ids only down to detail', async () => {
  const tree = treeColumns(await crawl('W1', 2, fakeApi(records, { W7: 'W8' })), 1);
  assert.equal(tree.years.length, 6);
  assert.deepEqual(tree.depths, [0, 1, 1, 1, 1, 2]);
  assert.equal(tree.ids.length, 5);
  assert.equal(tree.statuses.filter((s) => s === 2).length, 1);
});

test('readCache skips a torn last line', () => {
  assert.deepEqual(readCache('{"dead":"W1"}\n{"dead":"W2"}\n{"node":{"id'), [{ dead: 'W1' }, { dead: 'W2' }]);
});

test('parseRef reads DOIs, arXiv IDs and OpenAlex IDs however they are pasted', () => {
  assert.equal(parseRef('10.1038/171737a0'), 'doi:10.1038/171737a0');
  assert.equal(parseRef(' https://doi.org/10.1038/171737a0 '), 'doi:10.1038/171737a0');
  assert.equal(parseRef('doi:10.1038/171737a0'), 'doi:10.1038/171737a0');
  assert.equal(parseRef('1706.03762'), 'doi:10.48550/arXiv.1706.03762');
  assert.equal(parseRef('https://arxiv.org/abs/1706.03762v5'), 'doi:10.48550/arXiv.1706.03762');
  assert.equal(parseRef('arXiv:1706.03762'), 'doi:10.48550/arXiv.1706.03762');
  assert.equal(parseRef('https://openalex.org/W2626778328'), 'W2626778328');
  assert.equal(parseRef('attention is all you need'), null);
  assert.equal(parseRef(''), null);
});
