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
 * --single uses only the free single lookups. Fetched papers land in
 * .snapshot-cache/, so a long crawl can pick up where it stopped.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const { parseRef, openalexGet, crawl, prune, resolve, toNode, firstLoad, treeColumns, shape } = require('../public/lib/crawl');

const CACHE_DIR = path.join(__dirname, '..', '.snapshot-cache');

function writeFiles(slug, result, detail) {
  const { first, full, tree } = shape(result, detail);
  const files = { '': first, '.full': full, '.tree': tree };
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
  const seedRef = parseRef(ref) || `doi:10.48550/arXiv.${ref}`;

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cacheFile = path.join(CACHE_DIR, `${slug}.jsonl`);
  const cached = fs.existsSync(cacheFile) ? readCache(fs.readFileSync(cacheFile, 'utf8')) : [];
  if (cached.length) console.error(`resuming with ${cached.length} cached entries`);
  const cache = fs.createWriteStream(cacheFile, { flags: 'a' });

  const get = (url) => openalexGet(url, { headers: { 'User-Agent': 'fontis-snapshot' } });
  await crawl(seedRef, depth, get, {
    single,
    cached,
    remember: (entry) => cache.write(`${JSON.stringify(entry)}\n`),
    onSpent: () => console.error('list budget spent; carrying on with free single lookups'),
    onLevel: async (d, result) => {
      const { papers, dead, zeroRefs } = result.levels[d - 1];
      console.error(`depth ${d}: ${papers} papers, ${dead} dead, ${zeroRefs} with no references`);
      if (d >= detail) writeFiles(slug, result, detail);
    },
  });
  cache.end();
}

if (require.main === module) main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });

module.exports = { crawl, prune, resolve, toNode, firstLoad, treeColumns, readCache };
