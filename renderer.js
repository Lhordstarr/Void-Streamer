const DEFAULT_SOURCES = [
  {
    name: 'StreameX', active: true, baseUrl: 'https://streamex.sh',
    latestUrl: 'https://streamex.sh/', searchUrl: 'https://streamex.sh/search?q={query}'
  },
  {
    name: 'Moviepire', active: true, baseUrl: 'https://moviepire.org',
    latestUrl: 'https://moviepire.org/', searchUrl: 'https://moviepire.org/search?q={query}'
  },
  {
    name: 'LunaStream', active: true, baseUrl: 'https://lunastream.watch',
    latestUrl: 'https://lunastream.watch/', searchUrl: 'https://lunastream.watch/search?q={query}'
  },
  {
    name: 'DuloTV', active: true, baseUrl: 'https://dulo.tv',
    latestUrl: 'https://dulo.tv/', searchUrl: 'https://dulo.tv/search?q={query}'
  },
  {
    name: 'LordFlix', active: true, baseUrl: 'https://lordflix.org',
    latestUrl: 'https://lordflix.org/', searchUrl: 'https://lordflix.org/search?q={query}'
  },
  {
    name: 'KawaiiAnime', active: true, baseUrl: 'https://kawaii-anime.com',
    latestUrl: 'https://kawaii-anime.com/browse', searchUrl: 'https://kawaii-anime.com/search?q={query}',
    isKawaiiAnime: true
  },
  {
    name: 'LunaAnime', active: true, baseUrl: 'https://luna-stream.me',
    latestUrl: 'https://luna-stream.me', searchUrl: 'https://luna-stream.me/?q={query}',
    isAnimeSource: true
  },
  {
    name: 'AnimeX', active: true, baseUrl: 'https://animex.one',
    latestUrl: 'https://animex.one', searchUrl: 'https://animex.one/?q={query}',
    isAnimeSource: true
  },
  {
    name: 'AniLight', active: true, baseUrl: 'https://anilight.live',
    latestUrl: 'https://anilight.live', searchUrl: 'https://anilight.live/?q={query}',
    isAnimeSource: true
  },
  {
    name: 'Anikoto', active: true, baseUrl: 'https://anikototv.to',
    latestUrl: 'https://anikototv.to/home', searchUrl: 'https://anikototv.to/filter?keyword={query}',
    isAnimeSource: true
  },
  {
    name: 'RiveStream', active: true, baseUrl: 'https://www.rivestream.app',
    latestUrl: 'https://www.rivestream.app/', searchUrl: 'https://www.rivestream.app/search?q={query}'
  },
  {
    name: '7REELS', active: true, baseUrl: 'https://7reels.cc',
    latestUrl: 'https://7reels.cc/', searchUrl: 'https://7reels.cc/search?q={query}'
  },
  {
    name: 'YouFlex', active: true, baseUrl: 'https://youflex.top',
    latestUrl: 'https://youflex.top/search?type=movie', searchUrl: 'https://youflex.top/search?q={query}'
  },
  {
    name: 'Screenscape', active: true, baseUrl: 'https://screenscape.me',
    latestUrl: 'https://screenscape.me/', searchUrl: 'https://screenscape.me/search?q={query}'
  },
];

const STREAM_EMBEDS = ['play.xpass.top', 'vidcore.net', 'vsembed.ru', 'player.videasy.net', 'zxcstream.xyz', 'vidplays.fun', 'player.vidplus.to', 'vidlink.pro', 'vidsrc.mov', 'vidrock.net', 'vidnest.fun', 'vidup.to', 'player.vidify.top', 'player.vidzee.wtf', 'strigil.cc', 'rivestream.app', '7reels.cc', 'youflex.top', 'screenscape.me'];
const STORAGE_KEYS = { sources: 'vs_sources', downloads: 'vs_downloads', cacheEnabled: 'vs_cache_enabled' };

let _ffmpegInstance = null;

async function remuxTsToMp4(tsData, onProgress) {
  const { createFFmpeg } = FFmpeg;
  if (!_ffmpegInstance) {
    _ffmpegInstance = createFFmpeg({ log: false });
    await _ffmpegInstance.load();
  }
  if (typeof onProgress === 'function') {
    _ffmpegInstance.setProgress(({ ratio }) => { onProgress(Math.min(Math.round(ratio * 100), 100)); });
  }
  let inputData;
  if (tsData instanceof Uint8Array) {
    inputData = tsData;
  } else if (tsData instanceof ArrayBuffer) {
    inputData = new Uint8Array(tsData);
  } else if (tsData instanceof Blob) {
    inputData = new Uint8Array(await tsData.arrayBuffer());
  } else if (typeof tsData === 'string') {
    const resp = await fetch(tsData);
    inputData = new Uint8Array(await resp.arrayBuffer());
  } else {
    inputData = new Uint8Array(tsData);
  }
  _ffmpegInstance.FS('writeFile', 'input.ts', inputData);
  await _ffmpegInstance.run('-fflags', '+igndts', '-i', 'input.ts', '-c', 'copy', '-bsf:a', 'aac_adtstoasc', 'output.mp4');
  const data = _ffmpegInstance.FS('readFile', 'output.mp4');
  _ffmpegInstance.FS('unlink', 'input.ts');
  _ffmpegInstance.FS('unlink', 'output.mp4');
  return new Blob([data.buffer], { type: 'video/mp4' });
}

// ── Virtual Scroll Engine ──────────────────────────────────────────────────────
function createVirtualGrid(container, opts = {}) {
  const CARD_W = opts.cardWidth || 160;
  const ROW_H  = opts.rowHeight || 290;
  const BUFFER = opts.bufferRows || 2;
  const gap = 16;

  let items = [];
  let cols = 5;
  let sentinel = null;
  let inner = null;
  let ticking = false;
  let cardCache = new Map();

  function makeCard(it, i) {
    const img = it.image || 'https://via.placeholder.com/300x450?text=No+Image';
    const div = document.createElement('div');
    div.className = 'card card-fade-in';
    div.dataset.idx = i;
    div.style.width = CARD_W + 'px';
    div.style.flexShrink = '0';
    div.style.flexGrow = '0';
    div.innerHTML =
      '<div class="card-poster"><img src="' + img + '" alt="' + (it.title||'') + '" loading="lazy" referrerpolicy="no-referrer">' +
        '<div class="card-poster-overlay"><div class="card-play"><svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg></div></div>' +
      '</div>' +
      '<div class="card-title">' + (it.title||'Unknown') + '</div>' +
      '<div class="card-meta">' + (it.year||'') + (it.quality ? ' &middot; ' + it.quality : '') + '</div>';
    return div;
  }

  function calcCols() {
    const w = container.clientWidth || 1000;
    return Math.max(1, Math.floor((w + gap) / (CARD_W + gap)));
  }

  function render() {
    if (!inner) return;
    const scrollTop = container.scrollTop;
    const viewH = container.clientHeight;
    cols = calcCols();
    const rows = Math.ceil(items.length / cols);
    const totalH = rows * (ROW_H + gap);
    sentinel.style.height = totalH + 'px';

    const startRow = Math.max(0, Math.floor(scrollTop / (ROW_H + gap)) - BUFFER);
    const endRow = Math.min(rows, Math.ceil((scrollTop + viewH) / (ROW_H + gap)) + BUFFER);

    const startIdx = startRow * cols;
    const endIdx = Math.min(items.length, endRow * cols);

    inner.style.transform = `translate3d(0, ${startRow * (ROW_H + gap)}px, 0)`;

    const visible = new Set();
    for (let i = startIdx; i < endIdx; i++) {
      if (items[i]) visible.add(i);
    }

    for (const [idx, el] of cardCache) {
      if (!visible.has(idx)) { el.remove(); cardCache.delete(idx); }
    }

    for (let i = startIdx; i < endIdx; i++) {
      const it = items[i];
      if (!it) continue;
      let el = cardCache.get(i);
      if (!el) {
        el = makeCard(it, i);
        cardCache.set(i, el);
        inner.appendChild(el);
      } else if (parseInt(el.dataset.idx) !== i) {
        el.dataset.idx = i;
      }
    }
    ticking = false;
  }

  function onScroll() {
    if (!ticking) { requestAnimationFrame(render); ticking = true; }
  }

  function init() {
    container.innerHTML = '';
    container.style.overflowY = 'auto';
    container.style.position = 'relative';
    container.style.display = 'block';
    sentinel = document.createElement('div');
    sentinel.style.width = '1px';
    sentinel.style.pointerEvents = 'none';
    container.appendChild(sentinel);
    inner = document.createElement('div');
    inner.className = 'virtual-scroll-inner';
    inner.style.position = 'absolute';
    inner.style.top = '0';
    inner.style.left = '0';
    inner.style.right = '0';
    inner.style.display = 'flex';
    inner.style.flexWrap = 'wrap';
    inner.style.gap = '16px';
    inner.style.padding = '0 60px 30px';
    container.appendChild(inner);
    container.addEventListener('scroll', onScroll, { passive: true });

    inner.addEventListener('click', (e) => {
      const card = e.target.closest('.card');
      if (card) {
        const idx = parseInt(card.dataset.idx);
        if (idx >= 0 && idx < items.length && opts.onItemClick) opts.onItemClick(items[idx]);
      }
    });
  }

  function setItems(newItems) {
    items = newItems;
    for (const el of cardCache.values()) el.remove();
    cardCache.clear();
    container.scrollTop = 0;
    render();
  }

  function refresh() {
    cols = calcCols();
    render();
  }

  init();

  return { setItems, refresh, render };
}

let state = {
  sources: [], currentSection: 'home', navStack: [], currentMovie: null, currentSource: null,
  currentDownloads: [], savedDownloads: [], cachedDownloads: [], activeCaches: [], heroItems: [], heroIndex: 0, heroInterval: null,
  searchTimeout: null, animeLang: 'sub', cacheEnabled: true
};

function normalizeTitle(t) { return (t||'').toLowerCase().replace(/[^a-z0-9]/g,''); }
function deduplicateItems(items) {
  const map = new Map();
  for (const item of items) {
    const key = normalizeTitle(item.title);
    if (map.has(key)) {
      const e = map.get(key);
      if (!e._allLinks) e._allLinks = [{ source: e.source, link: e.link }];
      e._allLinks.push({ source: item.source, link: item.link });
      if (item.image && !e.image) e.image = item.image;
      if (item.year && !e.year) e.year = item.year;
      if (item.quality && !e.quality) e.quality = item.quality;
    } else {
      map.set(key, { ...item, _allLinks: [{ source: item.source, link: item.link }] });
    }
  }
  return Array.from(map.values());
}

const DEAD_SOURCES = ['overlook.to', 'themoviebox.xyz', 'moviebox']; // removed/defunct sources
function loadSources() {
  try {
    const s = localStorage.getItem(STORAGE_KEYS.sources);
    const saved = s ? JSON.parse(s) : [];
    const cleaned = saved.filter(src => {
      if (DEAD_SOURCES.some(d => (src.baseUrl || '').includes(d) || (src.name || '').includes(d))) return false;
      return true;
    });
    const defaultsByName = {};
    DEFAULT_SOURCES.forEach(d => { defaultsByName[d.name] = d; });
    const merged = cleaned.map(src => {
      const def = defaultsByName[src.name];
      if (def) return { ...def, ...src, isKawaiiAnime: def.isKawaiiAnime || src.isKawaiiAnime, isAnimeSource: def.isAnimeSource || src.isAnimeSource };
      return src;
    });
    const savedNames = new Set(merged.map(src => src.name));
    const missing = DEFAULT_SOURCES.filter(src => !savedNames.has(src.name));
    state.sources = [...merged, ...missing];
    if (cleaned.length !== saved.length || merged.some((s, i) => s !== cleaned[i])) saveSources();
  } catch {
    state.sources = [...DEFAULT_SOURCES];
  }
}
function saveSources() { localStorage.setItem(STORAGE_KEYS.sources, JSON.stringify(state.sources)); }
function loadSavedDownloads() {
  try { const s = localStorage.getItem(STORAGE_KEYS.downloads); state.savedDownloads = s ? JSON.parse(s) : []; }
  catch { state.savedDownloads = []; }
}
function saveSavedDownloads() { localStorage.setItem(STORAGE_KEYS.downloads, JSON.stringify(state.savedDownloads)); }
function loadCacheEnabled() {
  try {
    const v = localStorage.getItem(STORAGE_KEYS.cacheEnabled);
    state.cacheEnabled = v === null ? true : v === '1';
  } catch { state.cacheEnabled = true; }
}
function saveCacheEnabled() {
  localStorage.setItem(STORAGE_KEYS.cacheEnabled, state.cacheEnabled ? '1' : '0');
}
function hideSuggestions() { const b = $('#search-suggestions'); if (b) b.classList.add('hidden'); }

function formatQualityLabel(item) {
  const raw = item.label || item.resolution || '';
  const m = raw.match(/(\d+)x(\d+)/);
  if (m) return m[2] + 'p';
  return raw || 'Auto';
}

const $ = (s, p = document) => p.querySelector(s);
const $$ = (s, p = document) => Array.from(p.querySelectorAll(s));

function prismPulse() {
  document.documentElement.style.setProperty('--flow-duration', '0.8s');
  setTimeout(() => document.documentElement.style.setProperty('--flow-duration', '4s'), 1200);
}

function showSection(name, skipLoad) {
  $$('section').forEach(s => s.classList.add('hidden'));
  const sec = $(`#${name === 'detail' ? 'movie-detail' : name}-section`);
  if (sec) sec.classList.remove('hidden');
  $$('.nav-link').forEach(l => l.classList.toggle('active', l.dataset.section === name));
  state.currentSection = name;

  // Toggle rainbow glow: only active section gets it
  $$('.glow-border').forEach(el => el.classList.remove('glow-active'));
  if (sec) {
    sec.querySelectorAll('.glow-border').forEach(el => el.classList.add('glow-active'));
  }
  prismPulse();

  if (skipLoad) return;
  if (name === 'home') loadHome();
  if (name === 'movies') loadSectionGrid('movies');
  if (name === 'tv') loadSectionGrid('tv');
  if (name === 'anime') loadSectionGrid('anime');
  if (name === 'downloads') { loadCachedDownloads(); loadActiveCaches(); renderDownloads(); }
}
function pushNav() { state.navStack.push(state.currentSection); }
function popNav() {
  const playerContainer = $('#modal-video-container');
  if (playerContainer && !playerContainer.classList.contains('hidden')) {
    destroyPlayer();
    playerContainer.classList.add('hidden');
    const closeBtn = $('#modal-video-close');
    if (closeBtn) closeBtn.style.display = 'none';
    const lo = $('#video-loading-overlay');
    if (lo) lo.classList.add('hidden');
    const cpb = document.getElementById('centerPlayBtn');
    if (cpb) cpb.style.display = '';
    setVideoTitle('');
    return;
  }
  if (state.navStack.length > 0) { showSection(state.navStack.pop(), true); }
  else showSection('home', true);
}

function createCard(item) {
  const d = document.createElement('div');
  d.className = 'card card-fade-in';
  const img = item.image || 'https://via.placeholder.com/300x450?text=No+Image';
  d.innerHTML = `
    <div class="card-poster">
      <img src="${img}" alt="${item.title}" loading="lazy" referrerpolicy="no-referrer">
      <div class="card-poster-overlay">
        <div class="card-play">
          <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        </div>
      </div>
    </div>
    <div class="card-title">${item.title||'Unknown'}</div>
    <div class="card-meta">${item.year||''} ${item.quality?' · '+item.quality:''}</div>`;
  d.addEventListener('click', () => openDetail(item));
  return d;
}

function renderContentRow(container, items, title, id) {
  if (!items || !items.length) return;
  const row = document.createElement('div');
  row.className = 'content-section';
  row.innerHTML = `
    <div class="section-header">
      <h2 class="section-title">${title}</h2>
    </div>
    <div class="content-row">
      <button class="scroll-arrow left" data-scroll="left" data-target="${id}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg>
      </button>
      <div class="content-scroll" id="${id}"></div>
      <button class="scroll-arrow right" data-scroll="right" data-target="${id}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>
      </button>
    </div>`;
  container.appendChild(row);
  const scroll = $(`#${id}`, row);
  items.forEach(it => scroll.appendChild(createCard(it)));
  $(`.scroll-arrow.left`, row).addEventListener('click', () => scroll.scrollBy({ left: -400, behavior: 'smooth' }));
  $(`.scroll-arrow.right`, row).addEventListener('click', () => scroll.scrollBy({ left: 400, behavior: 'smooth' }));
}

async function fetchSourceItems(source, query, section) {
  try {
    const config = {
      containerSelector: source.containerSelector,
      titleSelector: source.titleSelector,
      yearSelector: source.yearSelector,
      imageSelector: source.imageSelector,
      linkSelector: source.linkSelector,
      qualitySelector: source.qualitySelector,
      descSelector: source.descSelector
    };
    if (query) config.searchQuery = query;
    if (section) config.section = section;

    let url;
    if (query) {
      url = source.searchUrl.replace('{query}', encodeURIComponent(query));
    } else {
      url = source.latestUrl;
    }
    const r = await window.api.scrapeUrl(url, config);
    if (r.success && r.items) {
      return r.items.map(it => ({ ...it, source: source.name, baseUrl: source.baseUrl }));
    }
  } catch (e) { console.error(`Failed fetching ${source.name}:`, e); }
  return [];
}

async function loadHome() {
  const trendingRow = $('#home-trending-row');
  const tvRow = $('#home-tv-row');
  const animeRow = $('#home-anime-row');
  if (trendingRow) trendingRow.innerHTML = '';
  if (tvRow) tvRow.innerHTML = '';
  if (animeRow) animeRow.innerHTML = '';
  const rowsEl = $('#home-source-rows');
  if (rowsEl) rowsEl.innerHTML = '';

  const activeTmdb = state.sources.filter(s => s.active && !s.isKawaiiAnime && !s.isAnimeSource);
  const movieItems = [];
  const tvItems = [];

  await Promise.all(activeTmdb.map(async source => {
    const [movies, tv] = await Promise.all([
      fetchSourceItems(source, null, 'movie'),
      fetchSourceItems(source, null, 'tv')
    ]);
    movieItems.push(...movies);
    tvItems.push(...tv);
  }));

  const dedupedMovies = deduplicateItems(movieItems);
  const dedupedTv = deduplicateItems(tvItems);
  const allItems = [...dedupedMovies, ...dedupedTv];

  state.heroItems = allItems.slice(0, 10);
  state.heroIndex = 0;
  renderHero();
  const heroLoading = $('#movies-loading-home');
  if (heroLoading) heroLoading.classList.add('hidden');
  if (trendingRow) allItems.slice(0, 15).forEach(it => trendingRow.appendChild(createCard(it)));
  if (tvRow) dedupedTv.slice(0, 15).forEach(it => tvRow.appendChild(createCard(it)));

  const animeSources = state.sources.filter(s => s.active && (s.isKawaiiAnime || s.isAnimeSource));
  const animeItems = [];
  await Promise.all(animeSources.map(async source => {
    const items = await fetchSourceItems(source);
    animeItems.push(...items);
  }));
  const dedupedAnime = deduplicateItems(animeItems);
  if (dedupedAnime.length && animeRow) dedupedAnime.slice(0, 15).forEach(it => animeRow.appendChild(createCard(it)));
  prismPulse();
}

function renderHero() {
  const heroEl = $('#hero');
  if (!heroEl || !state.heroItems.length) return;
  const item = state.heroItems[state.heroIndex];
  const bg = $('#hero-bg');
  if (bg) bg.style.backgroundImage = `url('${item.backdrop || item.image || ''}')`;
  const pills = $('#hero-pills');
  if (pills) {
    const type = item.isTv ? 'TV' : item.mediaType === 'tv' ? 'TV' : 'MOVIE';
    pills.innerHTML = `<span class="hero-pill">${type}</span>
      ${item.year?`<span class="hero-pill">${item.year}</span>`:''}
      ${item.quality?`<span class="hero-pill rating">${item.quality}</span>`:''}`;
  }
  const title = $('#hero-title');
  if (title) title.textContent = item.title || '';
  const desc = $('#hero-desc');
  if (desc) desc.textContent = item.description || '';
  const dots = $('#slideshow-dots');
  if (dots) {
    dots.innerHTML = state.heroItems.map((_, i) =>
      `<button class="hero-dot ${i===state.heroIndex?'active':''}" data-index="${i}"></button>`
    ).join('');
    $$('.hero-dot', dots).forEach(d => d.addEventListener('click', () => {
      state.heroIndex = parseInt(d.dataset.index);
      renderHero();
      resetHeroInterval();
    }));
  }
  resetHeroInterval();
}

function resetHeroInterval() {
  if (state.heroInterval) clearInterval(state.heroInterval);
  state.heroInterval = setInterval(() => {
    state.heroIndex = (state.heroIndex + 1) % state.heroItems.length;
    renderHero();
  }, 5000);
}

async function loadSectionGrid(section) {
  const gridEl = $(`#${section}-grid`);
  const loadingEl = $(`#${section}-loading`);
  const emptyEl = $(`#${section}-empty`);
  const contentEl = $(`#${section}-content`);
  if (!gridEl) return;
  gridEl.innerHTML = '';
  if (loadingEl) loadingEl.classList.remove('hidden');
  if (emptyEl) emptyEl.classList.add('hidden');
  if (contentEl) contentEl.classList.add('hidden');

  const sectionType = section === 'anime' ? 'anime' : section === 'tv' ? 'tv' : 'movie';
  let targetSources;
  if (section === 'anime') targetSources = state.sources.filter(s => s.active && (s.isKawaiiAnime || s.isAnimeSource));
  else targetSources = state.sources.filter(s => s.active && !s.isKawaiiAnime && !s.isAnimeSource);

  const allItems = [];
  await Promise.all(targetSources.map(async source => {
    const items = await fetchSourceItems(source, null, sectionType);
    allItems.push(...items);
  }));

  if (loadingEl) loadingEl.classList.add('hidden');
  const deduped = deduplicateItems(allItems);
  if (!deduped.length) { if (emptyEl) emptyEl.classList.remove('hidden'); return; }
  if (contentEl) contentEl.classList.remove('hidden');
  deduped.forEach(it => gridEl.appendChild(createCard(it)));
  prismPulse();
}

let _lastSearchResults = [];
let _searchVirtualGrid = null;

function populateSourceFilter() {
  const sel = $('#filter-source-select');
  if (!sel) return;
  sel.innerHTML = '<option value="all">All Sources</option>' +
    state.sources.map(s => `<option value="${s.name}">${s.name}</option>`).join('');
}

function renderSearchGrid(items, filter) {
  const gridEl = $('#search-grid');
  const countEl = $('#search-result-count');
  if (!gridEl) return;
  const filtered = (filter && filter !== 'all')
    ? items.filter(it => it.source === filter || (it._allLinks && it._allLinks.some(l => l.source === filter)))
    : items;
  if (countEl) countEl.textContent = `${filtered.length} results`;

  if (!_searchVirtualGrid) {
    _searchVirtualGrid = createVirtualGrid(gridEl, {
      cardWidth: 160,
      rowHeight: 240,
      bufferRows: 2,
      onItemClick: (item) => openDetail(item)
    });
  }
  _searchVirtualGrid.setItems(filtered);
}

async function performSearch(query) {
  const loadingEl = $('#search-loading');
  const noResEl = $('#search-no-results');
  const contentEl = $('#search-results-content');
  const queryDisp = $('#search-query-display');
  const sourceSelect = $('#filter-source-select');

  _lastSearchResults = [];
  if (sourceSelect) sourceSelect.value = 'all';

  if (!query || query.trim().length < 2) {
    if (loadingEl) loadingEl.classList.add('hidden');
    if (noResEl) noResEl.classList.remove('hidden');
    if (contentEl) contentEl.classList.add('hidden');
    return;
  }

  if (loadingEl) loadingEl.classList.remove('hidden');
  if (noResEl) noResEl.classList.add('hidden');
  if (contentEl) contentEl.classList.add('hidden');
  if (queryDisp) queryDisp.textContent = query;

  const activeSources = state.sources.filter(s => s.active);
  const allItems = [];

  await Promise.all(activeSources.map(async source => {
    const items = await fetchSourceItems(source, query);
    allItems.push(...items);
  }));

  if (loadingEl) loadingEl.classList.add('hidden');
  _lastSearchResults = deduplicateItems(allItems);
  if (!_lastSearchResults.length) { if (noResEl) noResEl.classList.remove('hidden'); return; }
  if (contentEl) contentEl.classList.remove('hidden');

  // Populate source filter dropdown
  if (sourceSelect) {
    const allSourceNames = new Set();
    _lastSearchResults.forEach(it => {
      if (it.source) allSourceNames.add(it.source);
      if (it._allLinks) it._allLinks.forEach(l => { if (l.source) allSourceNames.add(l.source); });
    });
    sourceSelect.innerHTML = '<option value="all">All Sources</option>' +
      [...allSourceNames].map(s => `<option value="${s}">${s}</option>`).join('');
  }

  renderSearchGrid(_lastSearchResults, sourceSelect ? sourceSelect.value : 'all');
}

async function openDetail(movie) {
  pushNav();
  state.currentMovie = movie;
  showSection('detail');

  const backdrop = $('#detail-hero-backdrop');
  if (backdrop) backdrop.style.backgroundImage = `url('${movie.backdrop || movie.image || ''}')`;
  const poster = $('#detail-poster-img');
  if (poster) { poster.src = movie.image || 'https://via.placeholder.com/300x450?text=No+Image'; poster.referrerPolicy = 'no-referrer'; }
  const posterPH = $('#detail-poster-placeholder');
  if (posterPH) posterPH.classList.add('hidden');
  const title = $('#detail-title');
  if (title) title.textContent = movie.title || 'Unknown';
  const desc = $('#detail-description');
  if (desc) desc.textContent = 'Loading details...';

  const yearChip = $('#detail-year-chip');
  const yearVal = $('#detail-year-val');
  if (movie.year && yearChip && yearVal) { yearChip.classList.remove('hidden'); yearVal.textContent = movie.year; }
  else if (yearChip) yearChip.classList.add('hidden');

  const ratingChip = $('#detail-rating-chip');
  const ratingVal = $('#detail-rating-val');
  if (movie.rating && ratingChip && ratingVal) { ratingChip.classList.remove('hidden'); ratingVal.textContent = movie.rating; }
  else if (ratingChip) ratingChip.classList.add('hidden');

  const seasonsChip = $('#detail-seasons-chip');
  if (seasonsChip) seasonsChip.classList.add('hidden');
  const genreChip = $('#detail-genre-chip');
  if (genreChip) genreChip.classList.add('hidden');

  const seasonsSection = $('#detail-seasons-section');
  if (seasonsSection) seasonsSection.classList.add('hidden');
  const castSection = $('#detail-cast-section');
  if (castSection) castSection.classList.add('hidden');
  const relatedSection = $('#detail-related-section');
  if (relatedSection) relatedSection.classList.add('hidden');
  const dlContainer = $('#dl-options-list');
  if (dlContainer) dlContainer.innerHTML = '';
  const dlLoading = $('#dl-loading');
  if (dlLoading) dlLoading.classList.remove('hidden');
  const dlError = $('#dl-error');
  if (dlError) dlError.classList.add('hidden');

  const source = state.sources.find(s => s.name === movie.source) || state.sources.find(s => s.active);
  state.currentSource = source;

  const chipsEl = $('#source-chips');
  if (chipsEl) {
    chipsEl.innerHTML = state.sources.map(s =>
      `<button class="source-chip ${s.name===source.name?'active':''}" data-source="${s.name}">${s.name}</button>`
    ).join('');
    $$('.source-chip', chipsEl).forEach(c => c.addEventListener('click', () => switchSource(c.dataset.source, movie)));
  }

  const detailUrl = movie.link && movie.link.startsWith('http') ? movie.link : (movie.baseUrl || source.baseUrl) + (movie.link || '');
  try {
    const detail = await window.api.scrapeDetail(detailUrl, {
      downloadContainerSelector: source.downloadContainerSelector,
      downloadQualitySelector: source.downloadQualitySelector,
      downloadSizeSelector: source.downloadSizeSelector,
      downloadSeedsSelector: source.downloadSeedsSelector,
      downloadTorrentSelector: source.downloadTorrentSelector
    });
    renderDetailInfo(movie, detail, source);
  } catch (e) {
    console.error('Detail failed', e);
    if (desc) desc.textContent = 'Failed to load details.';
    if (dlLoading) dlLoading.classList.add('hidden');
  }
}

function renderDetailInfo(movie, detail, source) {
  const desc = $('#detail-description');
  if (desc) desc.textContent = detail.description || movie.description || '';
  if (detail.isAnimeSource) movie._isAnimeSource = true;

  if (detail.rating) {
    const rc = $('#detail-rating-chip');
    const rv = $('#detail-rating-val');
    if (rc && rv) { rc.classList.remove('hidden'); rv.textContent = detail.rating; }
  }
  if (detail.genres && detail.genres.length) {
    const gc = $('#detail-genre-chip');
    if (gc) { gc.classList.remove('hidden'); gc.textContent = detail.genres.join(', '); }
  }
  if (detail.seasons && detail.seasons > 0) {
    const sc = $('#detail-seasons-chip');
    const sv = $('#detail-seasons-val');
    if (sc && sv) { sc.classList.remove('hidden'); sv.textContent = `${detail.seasons} Season${detail.seasons>1?'s':''}`; }
    renderSeasons(detail.seasons, detail.episodesData || {}, movie);
  } else if (detail.episodes && detail.episodes.length > 0) {
    const sc = $('#detail-seasons-chip');
    const sv = $('#detail-seasons-val');
    if (sc && sv) { sc.classList.remove('hidden'); sv.textContent = `${detail.episodes.length} Episodes`; }
    const epsData = { 'Season 1': detail.episodes };
    renderSeasons(1, epsData, movie);
  } else if (detail.isAnimeSource && detail.episodesData) {
    const seasonKeys = Object.keys(detail.episodesData);
    if (seasonKeys.length) {
      const total = seasonKeys.reduce((sum, k) => sum + (detail.episodesData[k]?.length || 0), 0);
      if (total > 0) {
        const sc = $('#detail-seasons-chip');
        const sv = $('#detail-seasons-val');
        if (sc && sv) { sc.classList.remove('hidden'); sv.textContent = `${total} Episodes`; }
        renderSeasons(seasonKeys.length, detail.episodesData, movie);
      }
    }
  }
  if (detail.cast && detail.cast.length) {
    const castSection = $('#detail-cast-section');
    const castList = $('#detail-cast-list');
    if (castSection && castList) {
      castSection.classList.remove('hidden');
      castList.innerHTML = detail.cast.map(c => `
        <div class="cast-member">
          <div class="cast-avatar"><img src="${c.image||'https://via.placeholder.com/64?text=?'}" alt="${c.name||''}" loading="lazy"></div>
          <div class="cast-name">${c.name||''}</div>
        </div>`).join('');
    }
  }

  const relSection = $('#detail-related-section');
  const relGrid = $('#detail-related-grid');
  if (relSection && relGrid) {
    relGrid.innerHTML = '';
    if (detail.related && detail.related.length) {
      relSection.classList.remove('hidden');
      detail.related.forEach(it => {
        if (!it.title) return;
        const link = it.link || (it.tmdbId && movie.baseUrl && it.mediaType ? `${movie.baseUrl}/${it.mediaType}/${it.tmdbId}` : '');
        if (!link) return;
        const card = createCard({ ...it, source: movie.source, baseUrl: movie.baseUrl, link });
        card.addEventListener('click', () => openDetail({ ...it, source: movie.source, baseUrl: movie.baseUrl, link }));
        relGrid.appendChild(card);
      });
    } else {
      relSection.classList.add('hidden');
    }
  }

  const dlSection = $('#detail-download-section');
  if (dlSection) dlSection.classList.toggle('hidden', !detail.isMovie);
  renderDownloadsList(detail.downloads || [], movie);

  const watchBtn = $('#detail-watch-btn');
  const watchLabel = $('#detail-watch-label');
  if (watchLabel) watchLabel.textContent = detail.isMovie ? 'Watch Now' : detail.seasons > 0 ? 'Watch S1 E1' : 'Watch Now';
  if (watchBtn) {
    watchBtn.onclick = async () => {
      const downloads = detail.downloads || [];
      const streamable = downloads.find(d => {
        const u = (d.torrentUrl||d.sourceUrl||d.url||'').toLowerCase();
        return STREAM_EMBEDS.some(h => u.includes(h)) || u.includes('.m3u8') || u.includes('.mp4') || u.includes('.txt');
      });
      if (streamable) {
        playVideo(streamable.torrentUrl||streamable.sourceUrl||streamable.url);
      } else if (downloads.length && downloads[0].sourceUrl) {
        playVideo(downloads[0].sourceUrl);
      } else if (downloads.length && downloads[0].torrentUrl) {
        playVideo(downloads[0].torrentUrl);
      } else if (detail.episodesData) {
        const seasonKeys = Object.keys(detail.episodesData);
        if (seasonKeys.length && detail.episodesData[seasonKeys[0]].length) {
          const firstEp = detail.episodesData[seasonKeys[0]][0];
          if (firstEp.link) playVideo(addLangToUrl(firstEp.link, state.animeLang), firstEp.title || `${movie.title} S1E1`, state.animeLang);
        }
      }
    };
  }
}

function searchForMovie(title) {
  pushNav();
  showSection('search');
  const input = $('#search-input');
  if (input) input.value = title;
  const queryDisp = $('#search-query-display');
  if (queryDisp) queryDisp.textContent = title;
  performSearch(title);
}

async function searchForRelated(title, container, movie) {
  const allItems = [];
  const activeSources = state.sources.filter(s => s.active && !s.isKawaiiAnime && !s.isAnimeSource);
  await Promise.all(activeSources.map(async source => {
    const items = await fetchSourceItems(source, title);
    allItems.push(...items);
  }));
  const deduped = deduplicateItems(allItems).filter(it => normalizeTitle(it.title) !== normalizeTitle(movie.title));
  deduped.slice(0, 10).forEach(it => container.appendChild(createCard(it)));
}

function addLangToUrl(url, lang) {
  const lower = url.toLowerCase();
  if (lower.includes('anilight.live')) {
    return url.replace(/lang=\w+/i, `lang=${lang}`);
  }
  const sep = url.includes('?') ? '&' : '?';
  if (lower.includes('luna-stream.me') || lower.includes('animex.one') || lower.includes('kawaii-anime.com/watch')) {
    return url + sep + `lang=${lang}`;
  }
  return url;
}

let _activeSeasonKey = null;

function renderSeasons(seasons, episodesData, movie) {
  const section = $('#detail-seasons-section');
  const listEl = $('#detail-seasons-list');
  const epsGrid = $('#detail-episodes-grid');
  const langToggle = $('#anime-lang-toggle');
  if (!section || !listEl || !epsGrid) return;
  section.classList.remove('hidden');
  const seasonKeys = Object.keys(episodesData);
  if (!seasonKeys.length) {
    listEl.innerHTML = '';
    epsGrid.innerHTML = '<p style="color:var(--text-muted);padding:16px">No episodes available</p>';
    return;
  }
  if (!_activeSeasonKey || !seasonKeys.includes(_activeSeasonKey)) _activeSeasonKey = seasonKeys[0];
  const isAnime = movie && (movie._isAnimeSource || (movie.source && ['LunaAnime','AnimeX','AniLight','KawaiiAnime','Anikoto'].includes(movie.source)));
  if (langToggle) {
    langToggle.classList.toggle('hidden', !isAnime);
    if (isAnime) {
      $$('.lang-btn', langToggle).forEach(btn => {
        btn.classList.toggle('active', btn.dataset.lang === state.animeLang);
        btn.onclick = () => {
          state.animeLang = btn.dataset.lang;
          $$('.lang-btn', langToggle).forEach(b => b.classList.toggle('active', b.dataset.lang === state.animeLang));
          const cur = _activeSeasonKey || seasonKeys[0];
          if (episodesData[cur]) renderEpisodes(episodesData[cur], epsGrid, movie);
        };
      });
    }
  }
  listEl.innerHTML = seasonKeys.map((key, i) =>
    `<button class="source-chip ${key===_activeSeasonKey?'active':''}" data-season="${key}">${key}</button>`
  ).join('');
  $$('.source-chip', listEl).forEach(b => b.addEventListener('click', () => {
    _activeSeasonKey = b.dataset.season;
    $$('.source-chip', listEl).forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    renderEpisodes(episodesData[_activeSeasonKey], epsGrid, movie);
  }));
  renderEpisodes(episodesData[_activeSeasonKey], epsGrid, movie);
}

function renderEpisodes(episodes, container, movie) {
  if (!episodes || !episodes.length) {
    container.innerHTML = '<p style="color:var(--text-muted);padding:16px">No episodes available</p>';
    return;
  }
  container.innerHTML = episodes.map(ep => {
    const epNum = ep.number || ep.epNum || '?';
    const epTitle = (ep.title || ep.name || 'Untitled').replace(/"/g, '&quot;');
    const thumb = ep.thumbnail || '';
    const link = (ep.link || '').replace(/"/g, '&quot;');
    const thumbBg = thumb ? `background-image:url('${thumb.replace(/'/g, '%27')}')` : '';
    return `
    <div class="episode-card" data-link="${link}" data-title="${epTitle}" data-ep-num="${epNum}">
      <div class="episode-thumb" ${thumbBg ? `style="${thumbBg};background-size:cover;background-position:center"` : ''}>
        <div class="episode-play"><div class="episode-play-circle">
          <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        </div></div>
      </div>
      <div class="episode-info">
        <div class="episode-number">E${epNum}</div>
        <div class="episode-title">${epTitle}</div>
        <button class="episode-dl-btn" data-ep-link="${link}" data-ep-title="${epTitle}" data-ep-num="${epNum}">Download</button>
        <div class="episode-quality-picker hidden" data-ep-num="${epNum}"></div>
      </div>
    </div>`;
  }).join('');
  $$('.episode-card', container).forEach(card => card.addEventListener('click', async e => {
    if (e.target.closest('.episode-dl-btn') || e.target.closest('.episode-quality-picker')) return;
    let link = card.dataset.link;
    const epTitle = card.dataset.title || 'Episode';
    const epNum = parseInt(card.dataset.epNum || '1');

    if (link) {
      link = addLangToUrl(link, state.animeLang);
      playVideo(link, epTitle, state.animeLang);
    }
  }));
  $$('.episode-dl-btn', container).forEach(btn => btn.addEventListener('click', async e => {
    e.stopPropagation();
    btn.disabled = true;
    btn.textContent = 'Analyzing...';
    const epLink = addLangToUrl(btn.dataset.epLink, state.animeLang);
    const epTitle = btn.dataset.epTitle;
    const epNum = btn.dataset.epNum;
    const showTitle = movie?.title || 'Episode';
    const fileName = `${showTitle} - S01E${epNum} - ${epTitle}`;

    let streamUrl = epLink;
    const isEmbed = !/\.(m3u8|mp4|txt|ts)(\?|$)/i.test(epLink.toLowerCase());
    if (isEmbed) {
      try {
        const lower = epLink.toLowerCase();
        const isKawaii = lower.includes('kawaii-anime.com/watch/');
    const isAnimeSrc = lower.includes('luna-stream.me/') || lower.includes('animex.one/') || lower.includes('anilight.live/') || lower.includes('anikototv.to/');
        const result = isKawaii
          ? await window.api.scrapeKawaiiVideo(epLink)
          : isAnimeSrc
          ? await window.api.scrapeAnimeSourceVideo(epLink, state.animeLang)
          : await window.api.scrapeMoviboxStream(epLink);
        if (result.success && result.streamUrl) streamUrl = result.streamUrl;
      } catch {}
    }

    let qualities = [];
    try {
      const analysis = await window.api.analyzeStream(streamUrl);
      if (analysis.success && analysis.qualities?.length > 0) qualities = analysis.qualities;
    } catch {}

    const picker = btn.parentElement.querySelector('.episode-quality-picker');
    if (picker) {
      if (!qualities.length) qualities = [{ url: streamUrl, label: 'Default', estimatedSize: 'Unknown' }];
      picker.innerHTML = qualities.map(q => {
        const qlabel = formatQualityLabel(q);
        const size = q.estimatedSize && q.estimatedSize !== 'Unknown' ? ' · ' + q.estimatedSize : '';
        return `<button class="quality-chip" data-url="${q.url}">${qlabel}${size}</button>`;
      }).join('');
      picker.classList.remove('hidden');
      btn.classList.add('hidden');
      $$('.quality-chip', picker).forEach(chip => chip.addEventListener('click', () => {
        const cu = chip.dataset.url;
        window.api.startDownload(cu, fileName, chip.textContent.trim(), movie?.image || '');
      }));
    } else {
      window.api.startDownload(streamUrl, fileName, '', movie?.image || '');
      btn.textContent = 'Download';
      btn.disabled = false;
    }
  }));
}

function renderDownloadsList(downloads, movie) {
  const container = $('#dl-options-list');
  const loading = $('#dl-loading');
  const errorEl = $('#dl-error');
  if (!container) return;
  if (loading) loading.classList.add('hidden');
  if (!downloads.length) {
    if (errorEl) { errorEl.classList.remove('hidden'); const msg = $('#dl-error-msg'); if (msg) msg.textContent = 'No download links found'; }
    return;
  }
  if (errorEl) errorEl.classList.add('hidden');
  container.innerHTML = downloads.map((d, i) => `
    <div class="download-item">
      <div class="download-info">
        <div class="download-title">${d.quality||'Unknown'}${d.size?' · '+d.size:''}</div>
      </div>
      <div class="download-actions">
        <button class="download-btn primary play-dl-btn" data-idx="${i}">Play</button>
        <button class="download-btn secondary save-dl-btn" data-idx="${i}">Download</button>
        <div class="quality-picker hidden" data-idx="${i}"></div>
      </div>
    </div>`).join('');

  $$('.play-dl-btn', container).forEach(btn => btn.addEventListener('click', async () => {
    const d = downloads[parseInt(btn.dataset.idx)];
    if (!d) return;
    const url = d.torrentUrl || d.sourceUrl || d.url;
    if (url) playVideo(url);
  }));

  $$('.save-dl-btn', container).forEach(btn => btn.addEventListener('click', async () => {
    const d = downloads[parseInt(btn.dataset.idx)];
    if (!d) return;
    const url = d.torrentUrl || d.sourceUrl || d.url;
    btn.textContent = 'Analyzing...';
    btn.disabled = true;

    let streamUrl = url;
    if (d.isMoviboxStream && url) {
      try {
        const result = await window.api.scrapeMoviboxStream(url);
        if (result.success && result.streamUrl) streamUrl = result.streamUrl;
      } catch {}
    }

    let qualities = [];
    try {
      const analysis = await window.api.analyzeStream(streamUrl);
      if (analysis.success && analysis.qualities?.length > 0) {
        qualities = analysis.qualities;
      }
    } catch {}

    // Always show a picker — even with a single fallback option
    const picker = btn.parentElement.querySelector('.quality-picker');
    if (picker) {
      if (qualities.length === 0) {
        qualities = [{ url: streamUrl, label: 'Default', estimatedSize: 'Unknown' }];
      }
      picker.innerHTML = qualities.map(q => {
        const qualityLabel = formatQualityLabel(q);
        const sizeLabel = q.estimatedSize && q.estimatedSize !== 'Unknown' ? ' · ' + q.estimatedSize : '';
        return `<button class="quality-chip" data-url="${q.url}">${qualityLabel}${sizeLabel}</button>`;
      }).join('');
      picker.classList.remove('hidden');
      btn.classList.add('hidden');
      $$('.quality-chip', picker).forEach(chip => chip.addEventListener('click', () => {
        const cu = chip.dataset.url;
        window.api.startDownload(cu, movie.title, chip.textContent.trim(), movie.image);
      }));
    } else {
      // Fallback if picker element not found
      window.api.startDownload(streamUrl, movie.title, d.quality, movie.image);
      btn.textContent = 'Download';
      btn.disabled = false;
    }
  }));
}

// Active Video.js player instance (for cleanup)
let _customInitialized = false;
let _hlsInstance = null;

function initCustomControls() {
  if (_customInitialized) return;
  _customInitialized = true;
  const video = document.getElementById('modal-video-player');
  const playToggle = document.getElementById('playToggle');
  const centerPlayBtn = document.getElementById('centerPlayBtn');
  const volumeBtn = document.getElementById('volumeBtn');
  const volumeSlider = document.getElementById('volumeSlider');
  const timelineScrubber = document.getElementById('timelineScrubber');
  const timelineProgress = document.getElementById('timelineProgress');
  const timeDisplay = document.getElementById('timeDisplay');
  const skipBackBtn = document.getElementById('skipBackBtn');
  const skipForwardBtn = document.getElementById('skipForwardBtn');
  const pipBtn = document.getElementById('pipBtn');
  const fullscreenBtn = document.getElementById('fullscreenBtn');
  const cacheBtn = document.getElementById('cacheBtn');
  if (!video) return;

  function fmt(seconds) {
    if (!isFinite(seconds)) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60).toString().padStart(2, '0');
    return m + ':' + s;
  }

  function updateUI() {
    const cur = video.currentTime;
    const dur = video.duration;
    timeDisplay.textContent = fmt(cur) + ' / ' + fmt(dur);
    const pct = dur > 0 ? (cur / dur) * 100 : 0;
    timelineProgress.style.width = Math.min(pct, 100) + '%';
    timelineScrubber.value = dur > 0 ? (cur / dur) * 1000 : 0;
  }

  function togglePlay() {
    if (video.paused) {
      video.play();
      centerPlayBtn.style.display = 'none';
      playToggle.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';
    } else {
      video.pause();
      centerPlayBtn.style.display = '';
      playToggle.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
    }
  }

  playToggle.addEventListener('click', togglePlay);
  centerPlayBtn.addEventListener('click', togglePlay);
  video.addEventListener('play', () => {
    centerPlayBtn.style.display = 'none';
    playToggle.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';
  });
  video.addEventListener('pause', () => {
    centerPlayBtn.style.display = '';
    playToggle.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
  });
  video.addEventListener('timeupdate', updateUI);
  video.addEventListener('loadedmetadata', updateUI);
  video.addEventListener('ended', updateUI);

  // Volume
  volumeBtn.addEventListener('click', () => {
    video.muted = !video.muted;
    volumeBtn.innerHTML = video.muted
      ? '<svg viewBox="0 0 24 24"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>'
      : '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>';
  });
  volumeSlider.addEventListener('input', () => {
    video.volume = parseFloat(volumeSlider.value);
    video.muted = false;
  });
  video.addEventListener('volumechange', () => {
    volumeSlider.value = video.muted ? 0 : video.volume;
  });

  // Seek
  timelineScrubber.addEventListener('input', () => {
    const dur = video.duration;
    if (!isFinite(dur)) return;
    video.currentTime = (parseInt(timelineScrubber.value) / 1000) * dur;
  });

  // Skip
  skipBackBtn.addEventListener('click', () => { video.currentTime = Math.max(0, video.currentTime - 10); });
  skipForwardBtn.addEventListener('click', () => {
    const dur = video.duration;
    if (isFinite(dur)) video.currentTime = Math.min(dur, video.currentTime + 10);
  });

  // PiP
  pipBtn.addEventListener('click', () => {
    if (document.pictureInPictureElement) {
      document.exitPictureInPicture();
    } else if (video.requestPictureInPicture) {
      video.requestPictureInPicture();
    }
  });

  // Save-for-offline: start caching the current video manually
  cacheBtn.addEventListener('click', () => {
    if (!_currentPlayingUrl) return;
    if (isHlsUrl(_currentPlayingUrl)) {
      showToast('HLS streams cannot be saved for offline');
      return;
    }
    if (isLocalServerUrl(_currentPlayingUrl)) {
      showToast('This video is already available offline');
      return;
    }
    if (_cachingUrl === _currentPlayingUrl) {
      showToast('Already caching this video');
      return;
    }
    startBackgroundCache(_currentPlayingUrl, _currentPlayingTitle);
  });

  // Fullscreen
  fullscreenBtn.addEventListener('click', () => {
    const container = document.getElementById('playerContainer');
    if (!document.fullscreenElement) {
      if (container.requestFullscreen) container.requestFullscreen();
      else if (container.webkitRequestFullscreen) container.webkitRequestFullscreen();
    } else {
      if (document.exitFullscreen) document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    }
  });

  // Keyboard
  document.addEventListener('keydown', (e) => {
    const container = document.getElementById('modal-video-container');
    if (!container || container.classList.contains('hidden')) return;
    if (e.key === ' ') { e.preventDefault(); togglePlay(); }
    if (e.key === 'Escape') {
      destroyPlayer();
      container.classList.add('hidden');
      const closeBtn = $('#modal-video-close');
      if (closeBtn) closeBtn.style.display = 'none';
      const lo = $('#video-loading-overlay');
      if (lo) lo.classList.add('hidden');
      setVideoTitle('');
    }
  });
}

function setVideoTitle(title) {
  const el = document.getElementById('videoTitleText');
  if (el) el.textContent = title || '';
}

function getVideoMimeType(url) {
  const lower = url.toLowerCase();
  if (lower.includes('.m3u8')) return 'application/x-mpegURL';
  if (lower.endsWith('.ts') && !lower.includes('.srt') && !lower.includes('.vtt')) return 'video/mp2t';
  if (lower.includes('.mp4')) return 'video/mp4';
  if (lower.includes('.webm')) return 'video/webm';
  if (lower.includes('.mkv')) return 'video/x-matroska';
  if (lower.includes('.avi')) return 'video/x-msvideo';
  if (lower.includes('.mov')) return 'video/quicktime';
  if (lower.includes('.flv')) return 'video/x-flv';
  if (lower.endsWith('.txt') && !lower.includes('.srt') && !lower.includes('.vtt')) return 'application/x-mpegURL';
  return 'video/mp4';
}

function destroyPlayer() {
  if (_hlsInstance) {
    _hlsInstance.destroy();
    _hlsInstance = null;
  }
  const video = document.getElementById('modal-video-player');
  if (video) {
    video.pause();
    video.removeAttribute('src');
    video.load();
  }
}

function isHlsUrl(url) {
  const lower = url.toLowerCase();
  return lower.includes('.m3u8') || (lower.endsWith('.txt') && !lower.includes('.srt') && !lower.includes('.vtt'));
}

function getExt(url) {
  const lower = url.toLowerCase();
  for (const ext of ['.m3u8', '.mp4', '.ts', '.webm', '.mkv', '.avi', '.mov', '.flv', '.txt']) {
    if (lower.includes(ext) && !lower.includes('.srt') && !lower.includes('.vtt')) return ext;
  }
  return '.mp4';
}

const MIME_MAP = {
  '.m3u8': 'application/x-mpegURL',
  '.mp4': 'video/mp4',
  '.ts': 'video/mp2t',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
  '.flv': 'video/x-flv',
  '.txt': 'application/x-mpegURL'
};

async function loadStream(video, url, title) {
  if (_hlsInstance) { _hlsInstance.destroy(); _hlsInstance = null; }
  _currentPlayingUrl = url;
  _currentPlayingTitle = title || '';
  video.removeAttribute('src');
  video.innerHTML = '';

  if (isHlsUrl(url) && typeof Hls !== 'undefined' && Hls.isSupported()) {
    _hlsInstance = new Hls();
    _hlsInstance.loadSource(url);
    _hlsInstance.attachMedia(video);
    _hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
    _hlsInstance.on(Hls.Events.ERROR, (e, data) => {
      if (data.fatal) { console.error('[hls] fatal error:', data); _hlsInstance.destroy(); _hlsInstance = null; }
    });
    return;
  }

  // Direct media: start playback immediately from the source,
  // and cache the file in the background for offline saving.
  const playUrl = url;
  if (url.startsWith('http://') || url.startsWith('https://')) {
    if (!isLocalServerUrl(url) && state.cacheEnabled) startBackgroundCache(url, _currentPlayingTitle);
  }

  const ext = getExt(playUrl);
  const type = MIME_MAP[ext] || 'video/mp4';
  const source = document.createElement('source');
  source.src = playUrl;
  source.type = type;
  video.appendChild(source);
  video.load();
  video.play().catch(() => {});
}

function isLocalServerUrl(url) {
  return url.includes('127.0.0.1') || url.includes('localhost');
}

let _activeCacheUnsub = null;
let _currentPlayingUrl = null;
let _currentPlayingTitle = '';
let _cachingUrl = null;
let _cachingPercent = 0;

function getCacheBadge() {
  return $('#cache-badge');
}

function showToast(msg) {
  let t = $('#toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._toastTimer);
  t._toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

// Reflect the current cache state on the player's Save button.
function updateCacheButton() {
  const btn = $('#cacheBtn');
  if (!btn) return;
  btn.classList.remove('caching', 'cached');
  if (_cachingUrl) {
    btn.classList.add('caching');
    btn.title = _cachingPercent >= 100 ? 'Cached — save it offline in Downloads > Cached' : `Caching... ${_cachingPercent}%`;
  } else if (_currentPlayingUrl && isLocalServerUrl(_currentPlayingUrl)) {
    btn.classList.add('cached');
    btn.title = 'Already saved for offline';
  } else {
    btn.title = state.cacheEnabled ? 'Caching automatically — tap to start over' : 'Save for offline';
  }
}

// Start caching a video in the background while the player keeps playing.
function startBackgroundCache(url, title) {
  if (_cachingUrl === url) return;
  if (isLocalServerUrl(url)) return;
  const badge = getCacheBadge();
  const myId = `cache_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  _cachingUrl = url;
  _cachingPercent = 0;
  if (_activeCacheUnsub) { _activeCacheUnsub(); _activeCacheUnsub = null; }
  if (badge) { badge.textContent = 'Caching...'; badge.classList.remove('hidden'); }
  updateCacheButton();

  const unsub = window.api.onCacheProgress(({ cacheId, percent }) => {
    if (cacheId && cacheId !== myId) return;
    _cachingPercent = Math.min(percent, 100);
    if (badge) badge.textContent = `Caching... ${_cachingPercent}%`;
    updateCacheButton();
  });
  _activeCacheUnsub = unsub;

  window.api.cacheVideo(url, title || '', myId).then((result) => {
    try { if (unsub) unsub(); } catch {}
    _activeCacheUnsub = null;
    _cachingUrl = null;
    _cachingPercent = 0;
    if (badge) badge.classList.add('hidden');
    updateCacheButton();
    if (result && result.success && result.path) {
      loadCachedDownloads();
      showToast('Cached — save it offline in Downloads > Cached');
    } else {
      console.warn('[cache] background cache failed:', result && result.error);
    }
  }).catch((e) => {
    try { if (unsub) unsub(); } catch {}
    _activeCacheUnsub = null;
    _cachingUrl = null;
    _cachingPercent = 0;
    if (badge) badge.classList.add('hidden');
    updateCacheButton();
    console.warn('[cache] background cache error:', e.message);
  });
}

async function playVideo(url, title, lang) {
  if (!url) return;
  const lower = url.toLowerCase();
  lang = lang || state.animeLang || 'sub';

  const isDirectVideo = /\.(m3u8|mp4|txt|ts)(\?|$)/i.test(lower) && !lower.includes('.srt') && !lower.includes('.vtt');
  const isEmbed = !isDirectVideo;

  // Show modal + close button + loading overlay immediately
  const container = $('#modal-video-container');
  if (!container) return;
  container.classList.remove('hidden');
  const closeBtn = $('#modal-video-close');
  if (closeBtn) closeBtn.style.display = 'flex';
  const loadingOverlay = $('#video-loading-overlay');
  if (loadingOverlay) loadingOverlay.classList.remove('hidden');
  destroyPlayer();

  // Close button handler — defined once before any async work so it always works
  const hideModal = () => {
    destroyPlayer();
    container.classList.add('hidden');
    if (closeBtn) closeBtn.style.display = 'none';
    container.querySelectorAll('.glow-border').forEach(el => el.classList.remove('glow-active'));
    const lo = $('#video-loading-overlay');
    if (lo) lo.classList.add('hidden');
    const cpb = document.getElementById('centerPlayBtn');
    if (cpb) cpb.style.display = '';
    setVideoTitle('');
    hideQualityPicker();
  };
  if (closeBtn) closeBtn.onclick = hideModal;
  container.querySelectorAll('.glow-border').forEach(el => el.classList.add('glow-active'));

  let resolvedUrl = url;
  if (isEmbed) {
    const isKawaii = lower.includes('kawaii-anime.com/watch/');
    const isAnimeSrc = lower.includes('luna-stream.me/') || lower.includes('animex.one/') || lower.includes('anilight.live/') || lower.includes('anikototv.to/');
    try {
      const result = isKawaii
        ? await window.api.scrapeKawaiiVideo(url)
        : isAnimeSrc
        ? await window.api.scrapeAnimeSourceVideo(url, lang)
        : await window.api.scrapeMoviboxStream(url);
      if (result.success && result.streamUrl) {
        resolvedUrl = result.streamUrl;
      } else {
        if (loadingOverlay) loadingOverlay.classList.add('hidden');
        console.error('[player] scrape failed:', result.error);
        return;
      }
    } catch (e) {
      if (loadingOverlay) loadingOverlay.classList.add('hidden');
      console.error('[player] scrape error:', e);
      return;
    }
  }

  initCustomControls();

  // Play
  const lo = $('#video-loading-overlay');
  if (lo) lo.classList.remove('hidden');

  const video = document.getElementById('modal-video-player');
  if (!video) return;

  // Set title
  setVideoTitle(title);

  // Analyze stream for quality variants
  let qualities = [];
  try {
    console.log('[player] analyzing stream:', resolvedUrl.substring(0, 120));
    const analysis = await window.api.analyzeStream(resolvedUrl, true);
    console.log('[player] analysis result:', analysis);
    if (analysis.success && analysis.qualities?.length > 0) qualities = analysis.qualities;
  } catch (e) {
    console.warn('[player] analyzeStream failed:', e);
  }

  if (qualities.length > 1) {
    // Show quality picker
    showQualityPicker(qualities, title, lo);
  } else {
    // Single quality or analysis failed — play directly
    console.log('[player] playing:', resolvedUrl.substring(0, 120));
    try { await loadStream(video, resolvedUrl, title); } catch (e) { console.error('[player] loadStream error:', e); }
    if (lo) lo.classList.add('hidden');
  }
}

function showQualityPicker(qualities, title, loadingOverlay) {
  const pickerOverlay = $('#quality-picker-overlay');
  const pickerList = $('#quality-picker-list');
  const cancelBtn = $('#quality-picker-cancel');
  if (!pickerOverlay || !pickerList) return;

  pickerList.innerHTML = qualities.map((q, i) => {
    const size = q.estimatedSize && q.estimatedSize !== 'Unknown' ? q.estimatedSize : '';
    return `<button class="quality-pick-btn" data-idx="${i}"><span>${q.label || 'Auto'}</span>${size ? `<span class="qp-size">${size}</span>` : ''}</button>`;
  }).join('');

  pickerOverlay.classList.remove('hidden');

  $$('.quality-pick-btn', pickerList).forEach(btn => btn.addEventListener('click', async () => {
    const idx = parseInt(btn.dataset.idx, 10);
    const chosen = qualities[idx];
    hideQualityPicker();
    const video = document.getElementById('modal-video-player');
    if (!video) return;
    try { await loadStream(video, chosen.url, title); } catch (e) { console.error('[player] loadStream error:', e); }
    if (loadingOverlay) loadingOverlay.classList.add('hidden');
  }));

  if (cancelBtn) cancelBtn.onclick = () => {
    hideQualityPicker();
    destroyPlayer();
    const container = $('#modal-video-container');
    if (container) container.classList.add('hidden');
    const closeBtn = $('#modal-video-close');
    if (closeBtn) closeBtn.style.display = 'none';
    const cpb = document.getElementById('centerPlayBtn');
    if (cpb) cpb.style.display = '';
    setVideoTitle('');
  };
}

function hideQualityPicker() {
  const pickerOverlay = $('#quality-picker-overlay');
  if (pickerOverlay) pickerOverlay.classList.add('hidden');
}

async function switchSource(sourceName, movie) {
  const source = state.sources.find(s => s.name === sourceName);
  if (!source) return;
  state.currentSource = source;
  $$('.source-chip').forEach(c => c.classList.toggle('active', c.dataset.source === sourceName));
  const desc = $('#detail-description');
  if (desc) desc.textContent = 'Loading...';
  const dlLoading = $('#dl-loading');
  if (dlLoading) dlLoading.classList.remove('hidden');
  const dlError = $('#dl-error');
  if (dlError) dlError.classList.add('hidden');
  const dlContainer = $('#dl-options-list');
  if (dlContainer) dlContainer.innerHTML = '';
  const dlSection = $('#detail-download-section');
  if (dlSection) dlSection.classList.remove('hidden');
  const seasonsSection = $('#detail-seasons-section');
  if (seasonsSection) seasonsSection.classList.add('hidden');

  let detailUrl;
  if (source.isKawaiiAnime || source.isAnimeSource || ['KawaiiAnime', ...Object.keys({ 'luna-stream.me': 1, 'animex.one': 1, 'anilight.live': 1, 'anikototv.to': 1 })].includes(sourceName)) {
    detailUrl = await (async () => {
      try {
        const results = await fetchSourceItems(source, movie.title);
        if (results.length) return results[0].link;
      } catch (e) {}
      return null;
    })();
    if (!detailUrl) {
      if (desc) desc.textContent = 'Anime not found on ' + sourceName;
      if (dlLoading) dlLoading.classList.add('hidden');
      return;
    }
  } else {
    const oldLink = movie.link || '';
    const pathMatch = oldLink.match(/\/(movie|tv)\/(\d+)/);
    if (pathMatch) {
      detailUrl = source.baseUrl + '/' + pathMatch[1] + '/' + pathMatch[2];
    } else {
      // Search by title on this source (for anime-to-movie source switching)
      try {
        const items = await fetchSourceItems(source, movie.title || '', 'anime');
        if (items.length) {
          // Prefer TV show result to get episodes; fallback to movie
          const tvItem = items.find(it => it.link && it.link.includes('/tv/'));
          const chosen = tvItem || items.find(it => it.link);
          if (chosen) {
            const itemLink = chosen.link;
            detailUrl = itemLink.startsWith('http') ? itemLink : source.baseUrl + itemLink;
          } else {
            detailUrl = null;
          }
        } else {
          detailUrl = null;
        }
      } catch (e) {
        detailUrl = null;
      }
    }
  }

  if (!detailUrl) {
    if (desc) desc.textContent = 'Not found on ' + sourceName;
    if (dlLoading) dlLoading.classList.add('hidden');
    return;
  }

  try {
    const detail = await window.api.scrapeDetail(detailUrl, {
      downloadContainerSelector: source.downloadContainerSelector,
      downloadQualitySelector: source.downloadQualitySelector,
      downloadSizeSelector: source.downloadSizeSelector,
      downloadSeedsSelector: source.downloadSeedsSelector,
      downloadTorrentSelector: source.downloadTorrentSelector
    });
    renderDetailInfo(movie, detail, source);
    if (dlLoading) dlLoading.classList.add('hidden');
  } catch (e) {
    if (desc) desc.textContent = 'Failed to load from ' + sourceName;
    if (dlLoading) dlLoading.classList.add('hidden');
  }
}

function renderActiveDownloads() {
  const listEl = $('#dl-active-list');
  const emptyEl = $('#dl-active-empty');
  const badge = $('#nav-download-badge');
  const activeCountEl = $('#dl-active-count');

  if (!listEl) return;
  const active = state.currentDownloads;
  const saved = state.savedDownloads;
  const total = active.length + saved.length;

  if (badge) {
    if (active.length > 0) { badge.classList.remove('hidden'); badge.textContent = active.length; }
    else badge.classList.add('hidden');
  }
  if (activeCountEl) activeCountEl.textContent = active.length;
  if (!active.length) {
    listEl.innerHTML = '';
    if (emptyEl) emptyEl.classList.remove('hidden');
    return;
  }
  if (emptyEl) emptyEl.classList.add('hidden');

  listEl.innerHTML = active.map(d => {
    const pct = d.progress || 0;
    const speed = d.paused ? 'Paused' : (d.speed ? formatSpeed(d.speed) : '');
    const received = d.received ? formatBytes(d.received) : '';
    const totalSize = d.total && d.total > 0 ? formatBytes(d.total) : '';
    const isPaused = d.paused;
    return `
      <div class="active-dl-item${isPaused ? ' is-paused' : ''}" data-id="${d.id}">
        <div class="active-dl-icon${isPaused ? ' paused' : ''}">
          ${isPaused ? `<svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><polygon points="5 3 19 12 5 21 5 3"/></svg>` :
          `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="20" height="20">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>`}
        </div>
        <div class="active-dl-info">
          <div class="active-dl-top">
            <span class="active-dl-title">${d.title}</span>
            <span class="active-dl-pct">${isPaused ? 'Paused' : pct + '%'}</span>
          </div>
          <div class="active-dl-bar">
            <div class="active-dl-bar-fill${isPaused ? ' paused' : ''}" style="width:${pct}%"></div>
          </div>
          <div class="active-dl-bottom">
            <span class="active-dl-speed">${speed}</span>
            <span class="active-dl-size">${received && totalSize ? received + ' / ' + totalSize : ''}</span>
          </div>
        </div>
        <div class="active-dl-btns">
          <button class="active-dl-btn dl-pause-play" data-id="${d.id}" title="${isPaused ? 'Resume' : 'Pause'}">
            ${isPaused ?
              `<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><polygon points="5 3 19 12 5 21 5 3"/></svg>` :
              `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="14" height="14">
                <rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>
              </svg>`}
          </button>
          <button class="active-dl-btn dl-cancel" data-id="${d.id}" title="Cancel">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="14" height="14">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
      </div>`;
  }).join('');

  // Pause/Resume buttons
  $$('.dl-pause-play', listEl).forEach(btn => {
    btn.addEventListener('click', async () => {
      const d = active.find(d => d.id === btn.dataset.id);
      if (!d) return;
      if (d.paused) {
        await window.api.resumeDownload(d.id);
        d.paused = false;
      } else {
        await window.api.pauseDownload(d.id);
        d.paused = true;
      }
      renderActiveDownloads();
    });
  });

  // Cancel buttons
  $$('.dl-cancel', listEl).forEach(btn => {
    btn.addEventListener('click', async () => {
      await window.api.cancelDownload(btn.dataset.id);
      state.currentDownloads = state.currentDownloads.filter(d => d.id !== btn.dataset.id);
      renderActiveDownloads();
    });
  });
}

function renderCompletedDownloads() {
  const listEl = $('#dl-completed-list');
  const emptyEl = $('#dl-completed-empty');
  const completedCountEl = $('#dl-completed-count');
  const saved = state.savedDownloads;

  if (completedCountEl) completedCountEl.textContent = saved.length;
  if (!saved.length) {
    if (listEl) listEl.innerHTML = '';
    if (emptyEl) emptyEl.classList.remove('hidden');
    return;
  }
  if (emptyEl) emptyEl.classList.add('hidden');
  if (!listEl) return;

  listEl.innerHTML = saved.map((d, i) => `
    <div class="saved-dl-item">
      <div class="saved-dl-poster">
        ${d.image ? `<img src="${d.image}" alt="${d.title}" loading="lazy">` : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="20" height="20"><polyline points="20 6 9 17 4 12"/></svg>`}
      </div>
      <div class="saved-dl-info">
        <div class="saved-dl-title">${d.title}</div>
        <div class="saved-dl-meta">${d.quality||''} ${d.path ? '· ' + d.path.split(/[/\\]/).pop() : ''}</div>
      </div>
      <div class="saved-dl-actions">
        <button class="download-btn primary play-saved" data-path="${d.path}">Play</button>
        <button class="download-btn secondary remove-saved" data-idx="${i}">Remove</button>
      </div>
    </div>`).join('');

  $$('.play-saved', listEl).forEach(b => b.addEventListener('click', async () => {
    const result = await window.api.playLocalFile(b.dataset.path);
    if (result.success && result.url) {
      playVideo(result.url, b.dataset.path.split(/[/\\]/).pop());
    }
  }));
  $$('.remove-saved', listEl).forEach(b => b.addEventListener('click', () => {
    state.savedDownloads.splice(parseInt(b.dataset.idx), 1);
    saveSavedDownloads();
    renderCompletedDownloads();
  }));
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

async function loadCachedDownloads() {
  try {
    const result = await window.api.listCache();
    state.cachedDownloads = result.success ? (result.items || []) : [];
  } catch {
    state.cachedDownloads = [];
  }
  renderCachedDownloads();
}

async function loadActiveCaches() {
  try {
    const result = await window.api.listActiveCaches();
    state.activeCaches = result.success ? (result.caches || []) : [];
  } catch {
    state.activeCaches = [];
  }
  renderCachedDownloads();
}

function upsertActiveCache(data) {
  if (!data || !data.cacheId) return;
  const existing = state.activeCaches.find(a => a.cacheId === data.cacheId);
  if (existing) Object.assign(existing, data);
  else state.activeCaches.push({ cacheId: data.cacheId, ...data });
}

function updateActiveCacheItem(cacheId, percent, received) {
  const row = document.querySelector(`#dl-caching-list [data-cid="${cacheId}"]`);
  if (!row) return;
  const meta = row.querySelector('.saved-dl-meta');
  if (meta) meta.textContent = `Caching ${percent}% · ${formatBytes(received)}`;
  const fill = row.querySelector('.cache-progress-fill');
  if (fill) fill.style.width = `${Math.min(percent, 100)}%`;
}

function renderCachedDownloads() {
  const listEl = $('#dl-cached-list');
  const cacheListEl = $('#dl-caching-list');
  const emptyEl = $('#dl-cached-empty');
  const countEl = $('#dl-cached-count');
  if (countEl) countEl.textContent = state.cachedDownloads.length;
  const hasActive = state.activeCaches.length > 0;

  if (cacheListEl) {
    cacheListEl.innerHTML = state.activeCaches.map(c => `
      <div class="saved-dl-item" data-cid="${c.cacheId}">
        <div class="saved-dl-poster">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="20" height="20"><path d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>
        </div>
        <div class="saved-dl-info">
          <div class="saved-dl-title">${escapeHtml(c.title || c.filename || 'Caching video...')}</div>
          <div class="saved-dl-meta">Caching ${Math.min(c.percent || 0, 100)}% · ${formatBytes(c.received || 0)}</div>
          <div class="cache-progress-track"><div class="cache-progress-fill" style="width:${Math.min(c.percent || 0, 100)}%"></div></div>
        </div>
        <div class="saved-dl-actions">
          <button class="download-btn danger cancel-cache" data-cid="${c.cacheId}">Cancel</button>
        </div>
      </div>`).join('');

    $$('.cancel-cache', cacheListEl).forEach(b => b.addEventListener('click', async () => {
      const cid = b.dataset.cid;
      await window.api.cancelCache(cid);
      state.activeCaches = state.activeCaches.filter(a => a.cacheId !== cid);
      renderCachedDownloads();
    }));
  }

  if (!listEl) return;
  if (!state.cachedDownloads.length) {
    listEl.innerHTML = '';
    if (emptyEl) emptyEl.classList.toggle('hidden', hasActive);
    return;
  }
  if (emptyEl) emptyEl.classList.add('hidden');

  listEl.innerHTML = state.cachedDownloads.map((c, i) => `
    <div class="saved-dl-item">
      <div class="saved-dl-poster">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="20" height="20"><path d="M19 8H5v12h14V8zm0-2H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2zm-7 12V6"/></svg>
      </div>
      <div class="saved-dl-info">
        <div class="saved-dl-title">${escapeHtml(c.name)}</div>
        <div class="saved-dl-meta">${c.size > 0 ? formatBytes(c.size) : 'Unknown size'} · Cached</div>
      </div>
      <div class="saved-dl-actions">
        <button class="download-btn primary play-cache" data-idx="${i}">Play</button>
        <button class="download-btn secondary save-cache" data-idx="${i}">Save</button>
        <button class="download-btn danger delete-cache" data-idx="${i}">Delete</button>
      </div>
    </div>`).join('');

  $$('.play-cache', listEl).forEach(b => b.addEventListener('click', async () => {
    const c = state.cachedDownloads[parseInt(b.dataset.idx)];
    if (!c) return;
    const result = await window.api.playLocalFile(c.path);
    if (result.success && result.url) {
      playVideo(result.url, c.name);
    } else {
      showToast('Cannot play this cached file');
    }
  }));

  $$('.save-cache', listEl).forEach(b => b.addEventListener('click', async () => {
    const c = state.cachedDownloads[parseInt(b.dataset.idx)];
    if (!c) return;
    b.disabled = true;
    b.textContent = 'Saving...';
    const result = await window.api.saveCache(c.path);
    b.disabled = false;
    b.textContent = 'Save';
    if (result.success) {
      state.savedDownloads.unshift({
        title: result.filename || c.name,
        quality: 'Cached',
        image: '',
        path: result.path
      });
      saveSavedDownloads();
      renderCompletedDownloads();
      showToast('Saved to Downloads/Void Streamer');
    } else {
      showToast('Save failed: ' + (result.error || 'Unknown error'));
    }
  }));

  $$('.delete-cache', listEl).forEach(b => b.addEventListener('click', async () => {
    const c = state.cachedDownloads[parseInt(b.dataset.idx)];
    if (!c) return;
    const result = await window.api.deleteCache(c.path);
    if (result.success) {
      state.cachedDownloads.splice(parseInt(b.dataset.idx), 1);
      renderCachedDownloads();
    } else {
      showToast('Delete failed: ' + (result.error || 'Unknown error'));
    }
  }));
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatSpeed(bytesPerSec) {
  return formatBytes(bytesPerSec) + '/s';
}

function renderDownloads() {
  renderActiveDownloads();
  renderCompletedDownloads();
  renderCachedDownloads();
}

function initCacheListeners() {
  window.api.onCacheStarted((d) => { upsertActiveCache(d); renderCachedDownloads(); });
  window.api.onCacheProgress((d) => {
    if (d.cacheId && state.activeCaches.some(a => a.cacheId === d.cacheId)) {
      upsertActiveCache(d);
      updateActiveCacheItem(d.cacheId, d.percent || 0, d.received || 0);
    }
  });
  window.api.onCacheDone((d) => {
    state.activeCaches = state.activeCaches.filter(a => a.cacheId !== d.cacheId);
    if (d && d.success) loadCachedDownloads();
    else renderCachedDownloads();
  });
}

function initDownloadListeners() {
  window.api.onDownloadStarted((data) => {
    state.currentDownloads.push({
      id: data.downloadId,
      title: data.filename || data.url?.split('/').pop() || 'Downloading',
      quality: '',
      image: data.image || '',
      progress: 0,
      speed: 0,
      received: 0,
      total: 0,
      path: ''
    });
    renderDownloads();
  });
  window.api.onDownloadProgress((data) => {
    const dl = state.currentDownloads.find(d => d.id === data.downloadId);
    if (dl) {
      dl.progress = data.percent || 0;
      dl.speed = data.speed || 0;
      dl.received = data.received || 0;
      dl.total = data.total || 0;
      if (data.paused !== undefined) dl.paused = data.paused;
      const item = $(`.active-dl-item[data-id="${data.downloadId}"]`);
      if (item) {
        const fill = $('.active-dl-bar-fill', item);
        const pct = $('.active-dl-pct', item);
        const speed = $('.active-dl-speed', item);
        const size = $('.active-dl-size', item);
        if (fill) {
          fill.style.width = `${dl.progress}%`;
          fill.classList.toggle('paused', dl.paused);
        }
        if (pct) pct.textContent = dl.paused ? 'Paused' : `${dl.progress}%`;
        if (speed) speed.textContent = dl.paused ? 'Paused' : (dl.speed ? formatSpeed(dl.speed) : '');
        if (size && dl.received && dl.total) size.textContent = `${formatBytes(dl.received)} / ${formatBytes(dl.total)}`;
      }
    }
  });
  window.api.onDownloadDone((data) => {
    const idx = state.currentDownloads.findIndex(d => d.id === data.downloadId);
    if (idx !== -1) {
      const dl = state.currentDownloads.splice(idx, 1)[0];
      if (data.state === 'completed') {
        state.savedDownloads.unshift({
          title: dl.title,
          quality: dl.quality,
          image: dl.image || '',
          path: data.path || data.filePath || ''
        });
        saveSavedDownloads();
      }
      renderDownloads();
    }
  });
}

function initDownloadTabs() {
  $$('.dl-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      $$('.dl-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const target = tab.dataset.tab;
      const activeContent = $('#dl-tab-active');
      const completedContent = $('#dl-tab-completed');
      const cachedContent = $('#dl-tab-cached');
      if (target === 'active') {
        if (activeContent) activeContent.classList.remove('hidden');
        if (completedContent) completedContent.classList.add('hidden');
        if (cachedContent) cachedContent.classList.add('hidden');
      } else if (target === 'completed') {
        if (activeContent) activeContent.classList.add('hidden');
        if (completedContent) completedContent.classList.remove('hidden');
        if (cachedContent) cachedContent.classList.add('hidden');
      } else {
        if (activeContent) activeContent.classList.add('hidden');
        if (completedContent) completedContent.classList.add('hidden');
        if (cachedContent) cachedContent.classList.remove('hidden');
      }
    });
  });
}

function initEventListeners() {
  $$('.nav-link').forEach(link => link.addEventListener('click', e => {
    e.preventDefault();
    const sec = link.dataset.section;
    if (sec) { pushNav(); showSection(sec); }
  }));
  $$('[data-scroll]').forEach(btn => btn.addEventListener('click', () => {
    const target = $(`#${btn.dataset.target}`);
    if (target) target.scrollBy({ left: btn.dataset.scroll === 'left' ? -400 : 400, behavior: 'smooth' });
  }));
  const heroWatch = $('#hero-watch');
  if (heroWatch) heroWatch.addEventListener('click', () => {
    if (state.heroItems.length) openDetail(state.heroItems[state.heroIndex]);
  });
  const prev = $('#slideshow-prev');
  const next = $('#slideshow-next');
  if (prev) prev.addEventListener('click', () => {
    state.heroIndex = (state.heroIndex - 1 + state.heroItems.length) % state.heroItems.length;
    renderHero();
  });
  if (next) next.addEventListener('click', () => {
    state.heroIndex = (state.heroIndex + 1) % state.heroItems.length;
    renderHero();
  });
  const searchForm = $('#search-form');
  if (searchForm) searchForm.addEventListener('submit', e => {
    e.preventDefault();
    const q = $('#search-input');
    if (q) { hideSuggestions(); performSearch(q.value); }
  });
  const filterSourceSelect = $('#filter-source-select');
  if (filterSourceSelect) filterSourceSelect.addEventListener('change', () => {
    renderSearchGrid(_lastSearchResults, filterSourceSelect.value);
  });
  const searchInput = $('#search-input');
  const suggestionsBox = $('#search-suggestions');
  const searchSection = $('#search-section');
  let suggestionTimer = null;
  function positionSuggestions() {
    const form = $('#search-form');
    if (!form || !searchSection || !suggestionsBox) return;
    const fr = form.getBoundingClientRect();
    const sr = searchSection.getBoundingClientRect();
    suggestionsBox.style.top = (fr.bottom - sr.top + 8) + 'px';
    suggestionsBox.style.left = (fr.left - sr.left) + 'px';
    suggestionsBox.style.width = fr.width + 'px';
  }
  if (searchInput && suggestionsBox) {
    searchInput.addEventListener('input', () => {
      clearTimeout(suggestionTimer);
      const val = searchInput.value.trim();
      if (val.length < 2) { suggestionsBox.classList.add('hidden'); return; }
      suggestionTimer = setTimeout(async () => {
        const activeSources = state.sources.filter(s => s.active);
        const allItems = [];
        await Promise.all(activeSources.map(async src => {
          const items = await fetchSourceItems(src, val);
          allItems.push(...items);
        }));
        const deduped = deduplicateItems(allItems).slice(0, 8);
        suggestionsBox.innerHTML = '';
        if (!deduped.length) { suggestionsBox.classList.add('hidden'); return; }
        deduped.forEach(it => {
          const item = document.createElement('div');
          item.className = 'search-suggestion-item';
          item.innerHTML = `<img src="${it.image || 'https://via.placeholder.com/36x54?text=No+Image'}" alt="" loading="lazy" referrerpolicy="no-referrer"><span class="suggestion-title">${it.title || ''}</span><span class="suggestion-year">${it.year || ''}</span>`;
          item.addEventListener('click', () => { suggestionsBox.classList.add('hidden'); openDetail({ ...it, source: it._source || it.source, baseUrl: it._baseUrl || it.baseUrl }); });
          suggestionsBox.appendChild(item);
        });
        positionSuggestions();
        suggestionsBox.classList.remove('hidden');
      }, 300);
    });
    searchInput.addEventListener('keydown', e => { if (e.key === 'Escape') suggestionsBox.classList.add('hidden'); });
    document.addEventListener('click', e => { if (!searchForm.contains(e.target) && !suggestionsBox.contains(e.target)) suggestionsBox.classList.add('hidden'); });
    window.addEventListener('resize', () => { if (!suggestionsBox.classList.contains('hidden')) positionSuggestions(); });
  }
  const backBtn = $('#btn-detail-back');
  if (backBtn) backBtn.addEventListener('click', popNav);
  $$('.page-back-btn').forEach(b => b.addEventListener('click', popNav));
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      const playerContainer = $('#modal-video-container');
      if (playerContainer && !playerContainer.classList.contains('hidden')) {
        popNav();
      } else if (state.currentSection === 'detail') {
        popNav();
      }
    }
  });
}

function init() {
  loadSources();
  loadSavedDownloads();
  loadCacheEnabled();
  initEventListeners();
  initDownloadListeners();
  initDownloadTabs();
  populateSourceFilter();
  initCacheListeners();
  loadCachedDownloads();
  loadActiveCaches();
  const cacheToggle = $('#cache-enabled-toggle');
  if (cacheToggle) {
    cacheToggle.checked = state.cacheEnabled;
    cacheToggle.addEventListener('change', () => {
      state.cacheEnabled = cacheToggle.checked;
      saveCacheEnabled();
      showToast(state.cacheEnabled ? 'Auto-cache enabled' : 'Auto-cache disabled');
    });
  }
  showSection('home');
}

document.addEventListener('DOMContentLoaded', init);
