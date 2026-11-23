/*
 * home.js — the search page, and the crawl that runs when a paper is picked.
 *
 * There's no backend: search and crawl both call OpenAlex from this tab, and
 * spend the visitor's own budget. Autocomplete and single lookups are free.
 */
'use strict';

const SEARCH_WAIT_MS = 250;
const MIN_QUERY = 3;
const MAX_AUTHORS = 3;
const AUTHOR_PAPERS = 10;
const CRAWL_DEPTH = 3;
const CRAWL_CACHE = 'fontis-crawls';
const INTRO_KEY = 'fontis-intro-dismissed';

let searchRun = 0; // a newer search abandons an older one

const openalexId = (url) => url.split('/').pop();

function paperHref(id) {
  const ready = PAPERS.find((p) => p.seed === id);
  return ready ? `?paper=${ready.slug}` : `?work=${id}`;
}

function resultRow(id, title, hint, cited) {
  const a = el('a', 'result');
  a.href = paperHref(id);
  a.append(el('span', 'result-title', title));
  const meta = [hint, cited ? `${formatCount(cited)} citations` : null].filter(Boolean).join(' · ');
  if (meta) a.append(el('span', 'result-meta', meta));
  if (!a.href.includes('work=')) a.append(el('span', 'badge badge-ready', 'ready'));
  return a;
}

function authorRow(author) {
  const button = el('button', 'result');
  button.type = 'button';
  button.append(el('span', 'result-title', author.display_name));
  const papers = author.works_count === 1 ? '1 paper' : `${formatCount(author.works_count)} papers`;
  const meta = [author.hint, papers, `${formatCount(author.cited_by_count)} citations`].filter(Boolean).join(' · ');
  button.append(el('span', 'result-meta', `author · ${meta}`));
  button.addEventListener('click', () => showAuthor(author));
  return button;
}

function showResults(rows, message = null) {
  const list = $('results');
  list.replaceChildren(...rows);
  if (message) list.append(el('p', 'results-note', message));
  list.hidden = !rows.length && !message;
  $('home-papers').hidden = !list.hidden;
}

const autocomplete = async (kind, query) => {
  const data = await Crawl.openalexGet(`${Crawl.API}/autocomplete/${kind}?q=${encodeURIComponent(query)}`);
  return data.results;
};

async function searchNames(query, run) {
  const [works, authors] = await Promise.all([autocomplete('works', query), autocomplete('authors', query)]);
  if (run !== searchRun) return;
  const people = authors.filter((a) => a.works_count).slice(0, MAX_AUTHORS);
  const rows = [...works, ...people]
    .sort((a, b) => (b.cited_by_count || 0) - (a.cited_by_count || 0))
    .map((hit) => (hit.entity_type === 'author' ? authorRow(hit) : resultRow(openalexId(hit.id), hit.display_name, hit.hint, hit.cited_by_count)));
  showResults(rows, rows.length ? null : 'No papers or authors match that.');
}

async function lookUp(ref, run) {
  const work = await Crawl.openalexGet(`${Crawl.API}/works/${ref}?select=${Crawl.SELECT}`);
  if (run !== searchRun) return;
  if (!work) { showResults([], 'OpenAlex has no paper with that ID.'); return; }
  const node = Crawl.toNode(work);
  showResults([resultRow(node.id, node.title, [node.authors.join(', '), node.year].filter(Boolean).join(' · '), node.cited)]);
}

async function showAuthor(author) {
  const run = ++searchRun;
  showResults([], 'Finding their papers…');
  const url = `${Crawl.API}/works?filter=author.id:${openalexId(author.id)}&sort=cited_by_count:desc&per_page=${AUTHOR_PAPERS}&select=id,title,publication_year,cited_by_count`;
  try {
    const { results } = await Crawl.openalexGet(url);
    if (run !== searchRun) return;
    const rows = results.map((w) => resultRow(openalexId(w.id), w.title, w.publication_year, w.cited_by_count));
    showResults(rows, `Most cited papers by ${author.display_name}`);
  } catch (e) {
    if (run !== searchRun) return;
    showResults([], e.budget ? 'Today\'s free OpenAlex budget is spent, so author pages are off until it resets. Paper titles and DOIs still work.' : 'Could not reach OpenAlex.');
  }
}

async function search() {
  const query = $('search').value.trim();
  const run = ++searchRun;
  const ref = Crawl.parseRef(query);
  if (!ref && query.length < MIN_QUERY) { showResults([]); return; }
  try {
    await (ref ? lookUp(ref, run) : searchNames(query, run));
  } catch {
    if (run === searchRun) showResults([], 'Could not reach OpenAlex.');
  }
}

// Up and down walk from the box through the results; Enter takes the first.
function moveThroughResults(e) {
  const rows = [...$('results').querySelectorAll('.result')];
  if (e.key === 'Enter' && e.target === $('search') && rows.length) {
    e.preventDefault();
    rows[0].click();
  }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const at = rows.indexOf(document.activeElement) + (e.key === 'ArrowDown' ? 1 : -1);
  (at < 0 ? $('search') : rows[Math.min(at, rows.length - 1)] || $('search')).focus();
}

// The same text as the ? button, open until someone dismisses it for good.
function showIntro() {
  let dismissed = null;
  try { dismissed = localStorage.getItem(INTRO_KEY); } catch { /* storage blocked */ }
  if (dismissed) return;
  const intro = $('intro');
  const copy = $('info-body').cloneNode(true);
  copy.removeAttribute('id');
  intro.prepend(copy);
  initInfoTabs(copy);
  intro.hidden = false;
  $('intro-dismiss').addEventListener('click', () => {
    intro.hidden = true;
    try { localStorage.setItem(INTRO_KEY, '1'); } catch { /* storage blocked */ }
  });
}

function showHome() {
  document.body.classList.add('landing');
  $('home').hidden = false;
  showIntro();
  renderPills($('home-papers'));
  let timer = null;
  $('search').addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(search, SEARCH_WAIT_MS);
  });
  $('home').addEventListener('keydown', moveThroughResults);
  $('home').addEventListener('submit', (e) => e.preventDefault());
  $('search').focus();
}

async function savedCrawl(id) {
  try {
    const hit = await (await caches.open(CRAWL_CACHE)).match(`crawl-${id}`);
    return hit ? await hit.json() : null;
  } catch { return null; } // no cache here; it just crawls again
}

async function saveCrawl(id, files) {
  try {
    await (await caches.open(CRAWL_CACHE)).put(`crawl-${id}`, new Response(JSON.stringify(files)));
  } catch { /* the page works without it */ }
}

/*
 * Crawl a paper from this tab and resolve with its files, or with null if
 * nothing can be shown. Stopping keeps every level that finished.
 */
async function crawlPaper(id) {
  const saved = await savedCrawl(id);
  if (saved) return saved;

  document.body.classList.add('landing');
  $('crawl').hidden = false;
  const status = (text) => { $('crawl-status').textContent = text; };
  let stopped = false;
  let finished = null; // the crawl as of the last full level
  let fetched = 0;
  let total = 0;
  let level = 0;
  const showCount = () => status(`Depth ${level} of ${CRAWL_DEPTH}: ${fetched.toLocaleString()} of ${total.toLocaleString()} references`);

  $('crawl-stop').addEventListener('click', () => { stopped = true; status('Stopping…'); });
  const get = async (url) => {
    if (stopped) throw Object.assign(new Error('stopped'), { stopped: true });
    return Crawl.openalexGet(url);
  };

  try {
    finished = await Crawl.crawl(id, CRAWL_DEPTH, get, {
      remember: () => { fetched++; if (!stopped) showCount(); },
      onSpent: () => { $('crawl-note').textContent = 'Today\'s free OpenAlex budget is spent, so this has slowed to about 4 papers a second. Stop whenever you like and see the levels that finished.'; },
      onDepth: (d, count) => {
        level = d;
        fetched = 0;
        total = count;
        showCount();
        if (d === 1) $('crawl-title').textContent = 'Following the references…';
      },
      onLevel: async (d, result) => {
        finished = result;
        $('crawl-stop').hidden = false;
        $('crawl-stop').textContent = `stop at depth ${d}`;
      },
    });
  } catch (e) {
    if (!finished) {
      const missing = e.message.startsWith('no such work');
      status(e.stopped ? 'Stopped.' : missing ? 'OpenAlex has no paper with that ID.' : 'Could not reach OpenAlex.');
      $('crawl-note').hidden = true;
      return null;
    }
  }

  if (!finished.levels.length) {
    $('crawl-title').textContent = finished.works.get(finished.seed).title;
    status('OpenAlex has no references on record for this paper, so its trail stops here.');
    $('crawl-note').hidden = true;
    return null;
  }

  const files = Crawl.shape(finished, finished.levels.length);
  if (!stopped) await saveCrawl(id, files);
  document.body.classList.remove('landing');
  $('crawl').hidden = true;
  return files;
}
