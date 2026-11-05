'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { crawl, prune } = require('../../scripts/snapshot');

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
