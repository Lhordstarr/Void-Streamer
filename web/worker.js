// Void Streamer (Web Edition) — Cloudflare Workers backend
// All plain-HTTP logic from main.js: resolvers, HLS proxies, subtitles,
// TMDB-driven scrape, analyze, download concatenation, health checks.
// No Chromium is available on Workers, so browser-flavored scraping
// (embed sniffing) is intentionally unsupported.

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const ABIBLI_ORIGIN = 'https://rov.funnyotter.xyz';
const ABIBLI_STREAM_HOST = 's5v.lazyrocket.space';
const TMDB_API_KEY = 'd9fa6f599339d23ed1f9c0070105b8dc';
const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMG = 'https://image.tmdb.org/t/p/w342';
const TMDB_IMG_HD = 'https://image.tmdb.org/t/p/w1280';
const TMDB_GENRES = {
  28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime',
  99: 'Documentary', 18: 'Drama', 10751: 'Family', 14: 'Fantasy', 36: 'History',
  27: 'Horror', 10402: 'Music', 9648: 'Mystery', 10749: 'Romance', 878: 'Sci-Fi',
  10770: 'TV Movie', 53: 'Thriller', 10752: 'War', 37: 'Western',
  10759: 'Action & Adventure', 10762: 'Kids', 10763: 'News', 10764: 'Reality',
  10765: 'Sci-Fi & Fantasy', 10766: 'Soap', 10767: 'Talk', 10768: 'War & Politics'
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}
async function jget(url, headers) {
  const r = await fetch(url, { headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json', ...(headers || {}) } });
  return { status: r.status, body: r.status === 200 ? await r.json().catch(() => null) : null, raw: r.status === 200 ? await r.text().catch(() => '') : '' };
}
async function jpost(url, payload, headers) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json', 'Content-Type': 'application/json', ...(headers || {}) },
    body: JSON.stringify(payload)
  });
  return { status: r.status, body: r.status === 200 ? await r.json().catch(() => null) : null };
}

// ─── StreameX/TMDB ───
async function streamexFetch(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const url = `https://streamex.sh/api/tmdb${path}?${qs}`;
  const r = await fetch(url, { headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' } });
  return await r.json().catch(() => ({}));
}
async function tmdbFetch(path, params = {}) {
  const qs = new URLSearchParams({ api_key: TMDB_API_KEY, language: 'en-US', ...params }).toString();
  const r = await fetch(`${TMDB_BASE}${path}?${qs}`, { headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' } });
  return await r.json().catch(() => ({}));
}

// Ported from scraper.js (TMDB paths only — no browser scraping needed).
const TMDB_IMG_LOD = TMDB_IMG;
async function scrapeTMDBListing(searchQuery, section = 'movie', baseUrl = 'https://streamex.sh') {
  let results = [];
  if (searchQuery) {
    const data = await streamexFetch('/search/multi', { query: searchQuery, page: 1 });
    results = (data.results || []).filter(item => {
      if (section === 'movie') return item.media_type === 'movie';
      if (section === 'tv') return item.media_type === 'tv';
      if (section === 'anime') return item.media_type === 'movie' || item.media_type === 'tv';
      return true;
    });
  } else {
    if (section === 'movie') {
      const data = await streamexFetch('/movie/popular', { page: 1 });
      results = (data.results || []).map(item => ({ ...item, media_type: 'movie' }));
    } else if (section === 'tv') {
      const data = await streamexFetch('/tv/popular', { page: 1 });
      results = (data.results || []).map(item => ({ ...item, media_type: 'tv' }));
    } else if (section === 'anime') {
      const [movieData, tvData] = await Promise.all([
        streamexFetch('/discover/movie', { with_genres: 16, sort_by: 'popularity.desc', with_original_language: 'ja', page: 1 }),
        streamexFetch('/discover/tv', { with_genres: 16, sort_by: 'popularity.desc', with_original_language: 'ja', page: 1 })
      ]);
      results = [
        ...(movieData.results || []).map(item => ({ ...item, media_type: 'movie' })),
        ...(tvData.results || []).map(item => ({ ...item, media_type: 'tv' }))
      ];
    } else {
      const data = await streamexFetch('/movie/popular', { page: 1 });
      results = (data.results || []).map(item => ({ ...item, media_type: 'movie' }));
    }
  }
  return results.slice(0, 40).map(item => {
    const type = item.media_type || section || 'movie';
    const tmdbId = item.id;
    const title = item.title || item.name || 'Unknown';
    const year = (item.release_date || item.first_air_date || '').split('-')[0] || '';
    const posterPath = item.poster_path || '';
    const backdropPath = item.backdrop_path || '';
    const quality = item.vote_average ? `★ ${item.vote_average.toFixed(1)}` : 'HD';
    const rating = item.vote_average ? item.vote_average.toFixed(1) : '';
    const isTv = type === 'tv';
    return {
      title,
      link: `${baseUrl}/${type}/${tmdbId}`,
      image: posterPath ? `${TMDB_IMG_LOD}${posterPath}` : '',
      backdrop: backdropPath ? `${TMDB_IMG_HD}${backdropPath}` : '',
      year,
      quality,
      rating,
      description: item.overview || '',
      tmdbId,
      mediaType: type,
      isTv,
      seasons: isTv ? item.number_of_seasons : undefined,
      genres: (item.genre_ids || []).slice(0, 3).map(id => TMDB_GENRES[id] || '').filter(Boolean)
    };
  });
}

function buildPeeStreamPseudo(type, tmdbId, s, e, title, year, imdbId) {
  const p = new URLSearchParams({ type, tmdb: tmdbId || '', title: title || '', year: year || '', imdb: imdbId || '' });
  if (type === 'tv') { p.set('season', s || 1); p.set('episode', e || 1); }
  return `peestream://stream?${p.toString()}`;
}
function buildAbibliPseudo(type, title, year, tmdbId, s, e) {
  const p = new URLSearchParams({ type, title: title || '', year: year || '', tmdb: tmdbId || '' });
  if (type === 'tv') { p.set('season', s || 1); p.set('episode', e || 1); }
  return `abibli://stream?${p.toString()}`;
}

async function scrapeStreamexDetail(detailUrl) {
  const m = detailUrl.match(/\/(?:peestream\.in|abibli\.com|streamex\.sh|moviepire\.org|7reels\.cc|www\.rivestream\.app)\/(movie|tv)\/(\d+)/i);
  if (!m) return { success: false, error: 'Invalid TMDB source URL', downloads: [] };
  const mediaType = m[1];
  const tmdbId = m[2];
  const [dataRes, creditsRes, similarRes] = await Promise.all([
    streamexFetch(`/${mediaType}/${tmdbId}`).catch(() => ({})),
    streamexFetch(`/${mediaType}/${tmdbId}/credits`).catch(() => ({})),
    streamexFetch(`/${mediaType}/${tmdbId}/similar`).catch(() => ({}))
  ]);
  const data = dataRes;
  const title = data.title || data.name || '';
  const year = (data.release_date || data.first_air_date || '').split('-')[0] || '';
  const imdbId = data.imdb_id || '';
  let description = data.overview || '';
  let poster = data.poster_path ? `${TMDB_IMG}${data.poster_path}` : '';
  let backdrop = data.backdrop_path ? `${TMDB_IMG_HD}${data.backdrop_path}` : '';
  const rating = data.vote_average ? data.vote_average.toFixed(1) : '';
  let seasons = data.number_of_seasons || 0;
  const genres = (data.genres || []).slice(0, 3).map(g => g.name).filter(Boolean);
  const cast = (creditsRes.cast || []).slice(0, 12).map(c => ({ name: c.name || '', image: c.profile_path ? `${TMDB_IMG}${c.profile_path}` : '' }));
  const related = (similarRes.results || []).slice(0, 12).map(r => ({
    title: r.title || r.name || '', image: r.poster_path ? `${TMDB_IMG}${r.poster_path}` : '',
    year: (r.release_date || r.first_air_date || '').split('-')[0] || '',
    rating: r.vote_average ? r.vote_average.toFixed(1) : '', tmdbId: r.id || '', mediaType, link: ''
  }));

  if (mediaType === 'movie') {
    const downloads = [{ quality: 'PeeStream', size: 'Stream', seeds: '', torrentUrl: '', sourceUrl: buildPeeStreamPseudo('movie', tmdbId, 1, 1, title, year, imdbId), isMoviboxStream: true, isPeestreamStream: true }];
    return { success: true, downloads, poster, title, description, isMovie: true, backdrop, rating, genres, cast, related };
  }
  const episodesData = {};
  try {
    const tvData = await streamexFetch(`/tv/${tmdbId}`);
    const seasonsData = (tvData.seasons || []).filter(s => s.season_number > 0 && s.season_number != null).slice(0, 10);
    seasons = tvData.number_of_seasons || seasons;
    const seasonResults = await Promise.all(seasonsData.map(s => streamexFetch(`/tv/${tmdbId}/season/${s.season_number}`).catch(() => ({ episodes: [] }))));
    seasonsData.forEach((s, i) => {
      const seasonKey = `Season ${s.season_number}`;
      episodesData[seasonKey] = (seasonResults[i].episodes || []).slice(0, 24).map(ep => ({
        number: ep.episode_number,
        title: ep.name || `Episode ${ep.episode_number}`,
        link: buildPeeStreamPseudo('tv', tmdbId, s.season_number, ep.episode_number, title, year, imdbId),
        thumbnail: ep.still_path ? `${TMDB_IMG}${ep.still_path}` : ''
      }));
    });
  } catch {}
  return { success: true, poster, title, description, isMovie: false, backdrop, rating, genres, seasons, cast, related, episodesData };
}

// ─── HLS proxy (playlist rewrite + streaming) ───
const abibliSessions = new Map(); // token -> { playlistUrl, client, createdAt }
function pruneSessions() {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [t, s] of abibliSessions) if (!s || s.createdAt < cutoff) abibliSessions.delete(t);
}
function rewritePlaylist(body, baseUrl, wrap, authQuery) {
  const proxyUri = (raw) => {
    if (!raw || raw.startsWith('data:') || raw.startsWith('blob:')) return raw;
    let abs;
    try { abs = new URL(raw, baseUrl); } catch { return raw; }
    if (authQuery) {
      for (const [k, v] of new URLSearchParams(authQuery)) abs.searchParams.set(k, v);
    }
    return wrap(abs.href);
  };
  return body.split(/\r?\n/).map((line) => {
    if (!line.trim()) return line;
    if (line.trimStart().startsWith('#')) return line.replace(/URI="([^"]+)"/g, (m, uri) => `URI="${proxyUri(uri)}"`);
    return proxyUri(line.trim());
  }).join('\n');
}
function isPlaylist(target, contentType) {
  let pn = '';
  try { pn = new URL(target).pathname.toLowerCase(); } catch {}
  return pn.endsWith('.m3u8') || pn.endsWith('.txt') || (contentType || '').toLowerCase().includes('mpegurl');
}
function proxyOutHeaders(upstreamHeaders) {
  const h = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Type'
  };
  for (const k of ['content-type', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'cache-control', 'content-length']) {
    if (upstreamHeaders.get(k)) h[k] = upstreamHeaders.get(k);
  }
  return h;
}
async function proxiedFetch(target, headers) {
  return fetch(target, { headers: { 'User-Agent': BROWSER_UA, Accept: '*/*', ...headers } });
}
function resolveHost(target) {
  try { return new URL(target).hostname; } catch { return ''; }
}
async function genericProxy(req, url) {
  const target = url.searchParams.get('u');
  const origin = url.searchParams.get('o') || '';
  if (!target) return new Response('Missing u', { status: 400 });
  const u = new URL(target);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return new Response('Bad protocol', { status: 403 });
  const headers = {};
  if (origin) { headers['Origin'] = origin; headers['Referer'] = origin.endsWith('/') ? origin : origin + '/'; }
  const upstream = await proxiedFetch(target, headers);
  return sendProxiedResponse(req, upstream, target, (abs) => `${url.origin}/api/proxy?u=${encodeURIComponent(abs)}&o=${encodeURIComponent(origin)}`, '');
}
async function sendProxiedResponse(req, upstream, target, wrap, authQuery) {
  const headers = proxyOutHeaders(upstream.headers);
  const status = upstream.status;
  const ct = upstream.headers.get('content-type') || '';
  if (req.method === 'HEAD') {
    return new Response(null, { status, headers });
  }
  if (isPlaylist(target, ct)) {
    const text = await upstream.text();
    const body = BufferFromString(rewritePlaylist(text, target, wrap, authQuery));
    headers['Content-Type'] = 'application/vnd.apple.mpegurl';
    headers['Content-Length'] = String(body.byteLength);
    return new Response(body, { status, headers });
  }
  return new Response(upstream.body, { status, headers });
}
function BufferFromString(s) { const e = new TextEncoder(); return e.encode(s); }

// ─── Resolvers (ported) ───
async function resolvePeestream(tmdb, type, season, episode, title, year, imdbId) {
  const apiUrl = 'https://streamdata.vaplayer.ru/api.php?tmdb=' + encodeURIComponent(tmdb) +
    '&type=' + type + (type === 'tv' ? `&season=${season}&episode=${episode}` : '');
  const get = async () => {
    const r = await fetch(apiUrl, { headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' } });
    if (r.status !== 200) throw new Error('HTTP ' + r.status);
    return await r.json();
  };
  let data;
  try { data = await get(); } catch { data = await get(); }
  const streams = data && data.data && Array.isArray(data.data.stream_urls)
    ? data.data.stream_urls.filter(u => typeof u === 'string' && u.startsWith('http')) : [];
  if (!streams.length) {
    const fb = title ? await resolveAbibli(title, year, type, season, episode) : { success: false };
    if (fb.success) return fb;
    return { success: false, error: 'No stream found on PeeStream' };
  }
  return { success: true, streamUrl: streams[0], streamUrls: streams, title: data.data.title || '' };
}

function normalizeTitle(v) {
  return String(v || '').toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/\b(?:season|series)\s*\d+.*$/i, ' ').replace(/[^a-z0-9]+/g, '');
}
function pickAbibliItem(items, title, year, type) {
  const target = normalizeTitle(title);
  let best = null, bestScore = -Infinity;
  for (const item of items || []) {
    const href = item.href || '';
    if (type === 'tv' && !href.includes('/series/')) continue;
    if (type !== 'tv' && !href.includes('/movie/')) continue;
    const it = normalizeTitle(item.title);
    const hrefYear = (href.match(/-(\d{4})(?:\?|$)/) || [])[1] || '';
    let score = 0;
    if (it && it === target) score += 100;
    else if (it && (it.startsWith(target) || target.startsWith(it))) score += 60;
    else if (it && (it.includes(target) || target.includes(it))) score += 25;
    else score -= 40;
    if (year && hrefYear) score += hrefYear === String(year) ? 50 : -30;
    if (href.includes('?season=')) score -= 20;
    if (score > bestScore) { bestScore = score; best = item; }
  }
  return bestScore > 0 ? best : null;
}
function parseAbibliPlays(html) {
  const plays = [];
  const re = /streamPlayer\.play\(\s*'([^']+)'\s*,\s*JSON\.parse\(\s*'((?:[^'\\]|\\.)*)'\s*\)\s*\)/g;
  let m;
  while ((m = re.exec(html))) {
    const streamUrl = m[1].replace(/\\\//g, '/');
    let data = {};
    try { data = JSON.parse(m[2].replace(/\\u0022/gi, '"').replace(/\\u0027/gi, "'").replace(/\\\//g, '/')); } catch {}
    plays.push({ streamUrl, data });
  }
  return plays;
}
async function fetchAbibli(url, accept) {
  const r = await fetch(url, { headers: { 'User-Agent': BROWSER_UA, Accept: accept, 'Accept-Language': 'en-US,en;q=0.9', Referer: 'https://abibli.com/' } });
  return await r.text();
}
async function abibliSignedUrl(hour) {
  const cryptoClient = crypto.randomUUID().replace(/-/g, '');
  const signed = await fetch('https://s5v.lazyrocket.space/mQ7x2P', {
    method: 'POST',
    headers: {
      'User-Agent': BROWSER_UA,
      'Origin': ABIBLI_ORIGIN, 'Referer': ABIBLI_ORIGIN + '/',
      'Accept': 'application/json', 'Content-Type': 'application/json',
      'X-S5V-Client': cryptoClient
    },
    body: JSON.stringify({ video: hash, client: cryptoClient })
  });
  const j = await signed.json().catch(() => null);
  return j && j.playlist ? { playlistUrl: new URL(j.playlist, 'https://s5v.lazyrocket.space').href, client: cryptoClient } : null;
}
let s5vCrypto = null;
async function resolveAbibli(title, year, type, season, episode) {
  if (!title) return { success: false, error: 'Missing title' };
  const suggestRaw = await fetchAbibli('https://abibli.com/search/suggest?q=' + encodeURIComponent(title), 'application/json');
  let suggest; try { suggest = JSON.parse(suggestRaw); } catch { return { success: false, error: 'Suggest failed' }; }
  const picked = pickAbibliItem(suggest.items, title, year, type);
  if (!picked) return { success: false, error: 'Not on Abibli' };
  const detailUrl = picked.href.split('?')[0];
  const html = await fetchAbibli(detailUrl, 'text/html');
  const plays = parseAbibliPlays(html);
  let play = null;
  if (type === 'tv') {
    play = plays.find(p => Number(p.data.seasonNumber) === season && Number(p.data.episodeNumber) === episode);
    if (!play) {
      const seasonHtml = await fetchAbibli(`${detailUrl}?season=${season}`, 'text/html');
      const plays2 = parseAbibliPlays(seasonHtml);
      play = plays2.find(p => Number(p.data.seasonNumber) === season && Number(p.data.episodeNumber) === episode);
    }
  } else {
    play = plays.find(p => p.data.type === 'movie') || plays[0];
  }
  if (!play) return { success: false, error: 'No playable episode on Abibli' };
  const hashValue = (play.data.streamUrl || play.streamUrl || '').split('#')[1] || '';
  if (!/^[A-Za-z0-9]{6}$/.test(hashValue)) return { success: false, error: 'Abibli stream id invalid' };
  const cryptoClient = crypto.randomUUID().replace(/-/g, '');
  const signed = await fetch('https://s5v.lazyrocket.space/mQ7x2P', {
    method: 'POST',
    headers: {
      'User-Agent': BROWSER_UA,
      'Origin': ABIBLI_ORIGIN, 'Referer': ABIBLI_ORIGIN + '/',
      'Accept': 'application/json', 'Content-Type': 'application/json',
      'X-S5V-Client': cryptoClient
    },
    body: JSON.stringify({ video: hashValue, client: cryptoClient })
  });
  const j = await signed.json().catch(() => null);
  if (!j || !j.playlist) return { success: false, error: 'Abibli signing failed' };
  const playlistUrl = new URL(j.playlist, 'https://s5v.lazyrocket.space').href;
  pruneSessions();
  const token = crypto.randomUUID().replace(/-/g, '').slice(0, 24);
  abibliSessions.set(token, { playlistUrl, client: cryptoClient, createdAt: Date.now() });
  return { success: true, streamUrl: `${''}/api/abibli/${token}/master.m3u8`, title: play.data.title || title, _token: token };
}

// ─── Analyze ───
function resolveUrl(base, href) {
  if (href.startsWith('http://') || href.startsWith('https://')) return href;
  const idx = base.lastIndexOf('/');
  const dir = idx >= 0 ? base.substring(0, idx + 1) : base + '/';
  if (href.startsWith('/')) {
    try { const u = new URL(base); return `${u.protocol}//${u.host}${href}`; } catch { return dir + href.replace(/^\//, ''); }
  }
  return dir + href;
}
async function analyzeStream(url, quick) {
  const resp = await fetch(url, { headers: { 'User-Agent': BROWSER_UA, Accept: '*/*' } });
  if (!resp.ok) return { success: false, error: 'HTTP ' + resp.status };
  const body = await resp.text();
  const lines = body.split('\n');
  const isHls = body.includes('#EXTM3U') || body.includes('#EXT-X-STREAM-INF') || body.includes('#EXTINF');
  if (!isHls) {
    return { success: true, type: 'direct', qualities: [{ url, label: 'Direct', estimatedBytes: 0, estimatedSize: 'Unknown' }] };
  }
  if (body.includes('#EXT-X-STREAM-INF:')) {
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes('#EXT-X-STREAM-INF:')) continue;
      const bw = parseInt((lines[i].match(/BANDWIDTH=(\d+)/i) || [])[1] || '0', 10);
      const resolution = (lines[i].match(/RESOLUTION=(\d+x\d+)/i) || [])[1] || '';
      const next = (lines[i + 1] || '').trim();
      if (next && !next.startsWith('#')) {
        const height = (resolution.split('x')[1] || '').replace(/\D/g, '');
        const label = height ? height + 'p' : (bw > 8000000 ? '4K' : bw > 3000000 ? '1080p' : bw > 1500000 ? '720p' : bw > 700000 ? '480p' : bw > 300000 ? '360p' : '240p');
        variants.push({ url: resolveUrl(url, next), bandwidth: bw, resolution, label });
      }
    }
    if (/#EXT-X-MEDIA:[^\n]*TYPE=AUDIO/i.test(body) && variants.length) {
      const best = variants.slice().sort((a, b) => b.bandwidth - a.bandwidth)[0];
      return { success: true, type: 'hls_variant', qualities: [{ url, label: best.label, bandwidth: best.bandwidth, resolution: best.resolution, estimatedSize: 'Unknown' }] };
    }
    return { success: true, type: 'hls_variant', qualities: variants.map(v => ({ ...v, estimatedSize: 'Unknown' })).sort((a, b) => b.bandwidth - a.bandwidth) };
  }
  return { success: true, type: 'hls_single', qualities: [{ url, label: 'Auto', estimatedSize: 'Unknown' }] };
}

// ─── Download (concatenated stream) ───
async function concatDownload(playlistUrl) {
  const fetchText = async (u) => {
    const r = await fetch(u, { headers: { 'User-Agent': BROWSER_UA, Accept: 'text/plain,*/*' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  };
  function parseVariants(body, baseUrl) {
    const lines = body.split('\n'); const vs = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes('#EXT-X-STREAM-INF:')) continue;
      const bw = parseInt((lines[i].match(/BANDWIDTH=(\d+)/i) || [])[1] || '0', 10);
      const next = (lines[i + 1] || '').trim();
      if (next && !next.startsWith('#')) vs.push({ url: resolveUrl(baseUrl, next), bandwidth: bw });
    }
    return vs.sort((a, b) => b.bandwidth - a.bandwidth);
  }
  function parseAudio(body, baseUrl) {
    const lines = body.split('\n').filter(l => /#EXT-X-MEDIA:[^\n]*TYPE=AUDIO/i.test(l));
    if (!lines.length) return '';
    const pref = lines.find(l => /DEFAULT=YES/i.test(l)) || lines[0];
    const uri = (pref.match(/URI="([^"]+)"/i) || [])[1] || '';
    return uri ? resolveUrl(baseUrl, uri) : '';
  }
  function parseMedia(body, baseUrl) {
    const segments = []; let initUrl = '';
    for (const raw of body.split('\n')) {
      const line = raw.trim(); if (!line) continue;
      if (line.startsWith('#EXT-X-MAP:')) { const uri = (line.match(/URI="([^"]+)"/i) || [])[1] || ''; if (uri) initUrl = resolveUrl(baseUrl, uri); continue; }
      if (line.startsWith('#')) continue;
      segments.push(resolveUrl(baseUrl, line));
    }
    return { initUrl, segments };
  }
  let masterBody = '';
  let videoUrl = playlistUrl;
  let videoBody = await fetchText(playlistUrl);
  if (videoBody.includes('#EXT-X-STREAM-INF:')) {
    masterBody = videoBody;
    const best = parseVariants(videoBody, playlistUrl)[0];
    if (best) { videoUrl = best.url; videoBody = await fetchText(videoUrl); }
  }
  const video = parseMedia(videoBody, videoUrl);
  let audio = null;
  const audioUrl = masterBody ? parseAudio(masterBody, playlistUrl) : '';
  if (audioUrl) {
    const audioBody = await fetchText(audioUrl);
    const parsedAudio = parseMedia(audioBody, audioUrl);
    if (parsedAudio.segments.length) audio = parsedAudio;
  }
  if (!video.segments.length) throw new Error('No video segments found');
  const parts = [];
  if (video.initUrl) parts.push(video.initUrl);
  parts.push(...video.segments);
  const out = [];
  let size = 0;
  for (const u of parts) {
    const r = await fetch(u, { headers: { 'User-Agent': BROWSER_UA, Accept: '*/*' } });
    if (!r.ok) throw new Error('Segment HTTP ' + r.status);
    const buf = new Uint8Array(await r.arrayBuffer());
    out.push(buf); size += buf.length;
  }
  const merged = new Uint8Array(size);
  let off = 0;
  for (const b of out) { merged.set(b, off); off += b.length; }
  return { buffer: merged, isFmp4: !!video.initUrl };
}

// ─── Subtitles ───
function rankSubs(list) {
  const rank = (l) => { const s = String(l || '').toLowerCase();
    if (s.startsWith('english')) return 0; if (s.startsWith('arabic')) return 1; if (s.startsWith('hindi')) return 2; return 3; };
  return (list || []).filter(s => s && s.url).sort((a, b) => rank(a.label) - rank(b.label) || String(a.label).localeCompare(String(b.label)));
}
async function fetchSubtitles(tmdb, imdb, type, season, episode) {
  const results = [];
  if (tmdb) {
    const vdrkUrl = 'https://sub.vdrk.site/v1/' + (type === 'tv' ? `tv/${encodeURIComponent(tmdb)}/${season || 1}/${episode || 1}` : `movie/${encodeURIComponent(tmdb)}`);
    try {
      const r = await fetch(vdrkUrl, { headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' } });
      if (r.ok) {
        const raw = await r.json().catch(() => []);
        if (Array.isArray(raw)) for (const item of raw) {
          if (item && typeof item.file === 'string' && item.file.startsWith('http')) {
            results.push({ label: item.label || 'Unknown', url: item.file, ext: 'vtt', source: 'VDRK' });
          }
        }
      }
    } catch {}
  }
  if (imdb) {
    try {
      const r = await fetch('https://natsuki.hls.lol/subs?imdbId=' + encodeURIComponent(imdb), {
        headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json', Origin: 'https://cinecat.eu', Referer: 'https://cinecat.eu/' }
      });
      if (r.ok) {
        const raw = await r.json().catch(() => null);
        const subs = raw && Array.isArray(raw.subtitles) ? raw.subtitles : [];
        for (const item of subs) {
          if (item && typeof item.url === 'string' && item.url.startsWith('http')) {
            results.push({ label: item.language || 'Unknown', url: item.url, ext: 'srt', source: 'Natsuki' });
          }
        }
      }
    } catch {}
  }
  return { success: results.length > 0, subtitles: rankSubs(results).slice(0, 60) };
}

// ─── Health ───
async function healthCheck() {
  const targets = [
    ['PeeStream', 'https://streamdata.vaplayer.ru/api.php?tmdb=550&type=movie'],
    ['Abibli', 'https://abibli.com/search/suggest?q=Av'],
    ['StreameX', 'https://play.xpass.top/']
  ];
  const out = {};
  await Promise.all(targets.map(async ([k, u]) => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch(u, { headers: { 'User-Agent': BROWSER_UA, Accept: '*/*' }, signal: ctrl.signal });
      clearTimeout(t);
      out[k] = r.status < 500 ? 'ok' : 'err';
    } catch { out[k] = 'err'; }
  }));
  return out;
}

// ─── Router ───
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
      } });
    }
    const origin = request.headers.get('Origin') || '';
    const cors = origin && origin.startsWith('http') ? { 'Access-Control-Allow-Origin': '*' } : {};

    try {
      if (path === '/api/health') return json(await healthCheck());

      if (path === '/api/resolve/peestream') {
        const q = url.searchParams;
        const data = await resolvePeestream(
          q.get('tmdb') || '', q.get('type') === 'tv' ? 'tv' : 'movie',
          parseInt(q.get('season') || '1', 10), parseInt(q.get('episode') || '1', 10),
          q.get('title') || '', q.get('year') || '', q.get('imdb') || ''
        );
        return json(data);
      }
      if (path === '/api/resolve/abibli') {
        const q = url.searchParams;
        const data = await resolveAbibli(
          q.get('title') || '', q.get('year') || '',
          q.get('type') === 'tv' ? 'tv' : 'movie',
          parseInt(q.get('season') || '1', 10), parseInt(q.get('episode') || '1', 10)
        );
        if (data.success && data._token) {
          data.streamUrl = url.origin + '/api/abibli/' + data._token + '/master.m3u8';
          delete data._token;
        }
        return json(data);
      }
      if (path.startsWith('/api/abibli/')) {
        const m = path.match(/^\/api\/abibli\/([a-z0-9-]+)\/(master(?:\.m3u8)?|stream)$/i);
        if (!m) return new Response('Not found', { status: 404 });
        const sess = abibliSessions.get(m[1]);
        if (!sess) return new Response('Expired', { status: 410 });
        let target;
        if (m[2].toLowerCase().startsWith('master')) target = sess.playlistUrl;
        else target = url.searchParams.get('u');
        if (!target) return new Response('Missing u', { status: 400 });
        if (resolveHost(target) !== ABIBLI_STREAM_HOST) return new Response('Host not allowed', { status: 403 });
        const upstream = await proxiedFetch(target, {
          'Origin': ABIBLI_ORIGIN, 'Referer': ABIBLI_ORIGIN + '/', 'X-S5V-Client': sess.client
        });
        let authQuery = '';
        try { authQuery = new URL(sess.playlistUrl).searchParams.toString(); } catch {}
        return sendProxiedResponse(request, upstream, target, (abs) => `${url.origin}/api/abibli/${m[1]}/stream?u=${encodeURIComponent(abs)}`, authQuery);
      }
      if (path === '/api/proxy') {
        return await genericProxy(request, url);
      }
      if (path === '/api/analyze') {
        const target = url.searchParams.get('url');
        if (!target) return json({ success: false, error: 'No URL' });
        return json(await analyzeStream(target, url.searchParams.get('quick') === '1'));
      }
      if (path === '/api/subs') {
        const q = url.searchParams;
        return json(await fetchSubtitles(
          q.get('tmdb') || '', q.get('imdb') || '',
          q.get('type') === 'tv' ? 'tv' : 'movie',
          parseInt(q.get('season') || '1', 10), parseInt(q.get('episode') || '1', 10)
        ));
      }
      if (path === '/api/subtext') {
        const target = url.searchParams.get('url');
        if (!target) return json({ success: false, error: 'No URL' });
        const r = await fetch(target, { headers: { 'User-Agent': BROWSER_UA, Accept: 'text/vtt,text/plain,*/*' } });
        if (!r.ok) return json({ success: false, error: 'HTTP ' + r.status });
        return json({ success: true, text: await r.text() });
      }
      if (path === '/api/download' && request.method === 'GET') {
        const target = url.searchParams.get('url');
        if (!target) return new Response('Missing url', { status: 400 });
        const { buffer } = await concatDownload(target);
        return new Response(buffer, { headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(buffer.byteLength),
          'Content-Disposition': 'attachment; filename="download.bin"',
          'Access-Control-Allow-Origin': '*'
        } });
      }
      if (path === '/api/scrape' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const input = body.url || '';
        const domainBlocked = /animex\.one|anikototv\.to|kawaii-anime\.com/i.test(input);
        if (domainBlocked) return json({ success: false, error: 'Anime browser sources are not supported in the web edition (use TMDB search instead)' });
        if (body.mode === 'detail') {
          const data = await scrapeStreamexDetail(input);
          return json({ ...data, success: true });
        }
        const searchQuery = (body.config && body.config.searchQuery) || '';
        const section = (body.config && body.config.section) || 'movie';
        const items = await scrapeTMDBListing(searchQuery, section, 'https://streamex.sh');
        return json({ success: true, items, url: input });
      }

      return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
    } catch (e) {
      return json({ success: false, error: e.message || String(e) }, 200);
    }
  }
};
