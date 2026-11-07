const { app, BrowserWindow, ipcMain, shell, session, dialog } = require('electron');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

// Lazy-loaded modules — loaded on first use, not at startup
let _fs, _axios, _scraper;
function getFs()     { return _fs     || (_fs     = require('fs')); }
function getAxios()  { return _axios  || (_axios  = require('axios')); }
function getScraper(){ return _scraper || (_scraper = require('./scraper')); }

const BROWSER_HEADERS = { 'User-Agent': 'Mozilla/5.0' };

// Enable GPU acceleration for smoother rendering
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('ignore-gpu-blocklist');

let mainWindow;
let downloadIdCounter = 0;
let localMediaPort = 0;
const activeDownloads = new Map(); // downloadId -> { stream, writer, paused, filePath, received, total }
const activeCaches = new Map();    // cacheId -> { url, title, filename, filePath, controller, stream, received, total, percent }

function getCacheDir() {
  const dir = path.join(app.getPath('userData'), 'cache', 'videos');
  if (!getFs().existsSync(dir)) getFs().mkdirSync(dir, { recursive: true });
  return dir;
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}
const MIME_TYPES = {
  '.ts':  'video/mp2t',
  '.mp4': 'video/mp4',
  '.m4s': 'video/mp4',
  '.webm':'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.m3u8':'application/vnd.apple.mpegurl',
  '.txt': 'text/plain'
};

// ─── Stream proxy ────────────────────────────────────────────────────────────
// The renderer runs from file://, so remote HLS servers that require an
// Origin/Referer header (or that return non-CORS responses) cannot be played
// directly. These routes fetch playlists/segments with the right headers and
// rewrite every URI back through the local server.
const abibliSessions = new Map(); // token -> { playlistUrl, client, origin, createdAt }
const ABIBLI_ORIGIN = 'https://rov.funnyotter.xyz';
const ABIBLI_STREAM_HOST = 's5v.lazyrocket.space';

function getLocalProxyBase() {
  return `http://127.0.0.1:${localMediaPort || 0}`;
}

function pruneAbibliSessions() {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [token, s] of abibliSessions) {
    if (!s || s.createdAt < cutoff) abibliSessions.delete(token);
  }
}

// Rewrite every playlist URI (media lines, EXT-X-MEDIA, EXT-X-MAP, EXT-X-KEY)
// through `wrap()`. `authQuery` is propagated from the playlist URL to every
// child, which is how the S5V player keeps signed URLs valid.
function rewritePlaylist(body, baseUrl, wrap, authQuery) {
  const proxyUri = (raw) => {
    if (!raw) return raw;
    if (raw.startsWith('data:') || raw.startsWith('blob:')) return raw;
    let abs;
    try { abs = new URL(raw, baseUrl); } catch { return raw; }
    if (authQuery) {
      const src = new URLSearchParams(authQuery);
      for (const [k, v] of src) abs.searchParams.set(k, v);
    }
    return wrap(abs.href);
  };

  return body.split(/\r?\n/).map((line) => {
    if (!line.trim()) return line;
    if (line.trimStart().startsWith('#')) {
      return line.replace(/URI="([^"]+)"/g, (m, uri) => `URI="${proxyUri(uri)}"`);
    }
    return proxyUri(line.trim());
  }).join('\n');
}

function isPlaylistResponse(targetUrl, contentType) {
  let pathname = '';
  try { pathname = new URL(targetUrl).pathname.toLowerCase(); } catch {}
  if (pathname.endsWith('.m3u8') || pathname.endsWith('.txt')) return true;
  if ((contentType || '').toLowerCase().includes('mpegurl')) return true;
  return false;
}

// Streamed fetch: never buffer whole files (direct MP4s can be gigabytes).
async function fetchProxiedStream(target, extraHeaders, req) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': '*/*',
    ...extraHeaders
  };
  if (req.headers.range) headers['Range'] = req.headers.range;
  const method = req.method === 'HEAD' ? 'head' : 'get';
  const resp = await getAxios()({
    url: target,
    method,
    responseType: 'stream',
    timeout: 30000,
    headers,
    validateStatus: () => true,
    maxRedirects: 5
  });
  return resp;
}

function proxyCommonHeaders(upstream) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Type'
  };
  for (const key of ['content-type', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'cache-control']) {
    if (upstream.headers[key]) headers[key] = upstream.headers[key];
  }
  return headers;
}

// Forward an upstream stream to the client. Playlists are small (masters and
// variants): they get buffered, rewritten and sent whole. Binary media
// streams through byte-by-byte so playback/seeking can start immediately.
async function sendProxyStream(req, res, upstream, target, wrap, authQuery) {
  const status = upstream.status || 502;
  const contentType = upstream.headers['content-type'] || '';
  const headers = proxyCommonHeaders(upstream);

  if (req.method === 'HEAD') {
    if (upstream.headers['content-length']) headers['Content-Length'] = upstream.headers['content-length'];
    res.writeHead(status, headers);
    res.end();
    try { if (upstream.data && upstream.data.destroy) upstream.data.destroy(); } catch {}
    return;
  }

  const stream = upstream.data;

  if (isPlaylistResponse(target, contentType)) {
    const chunks = [];
    await new Promise((resolve) => {
      if (!stream || typeof stream.on !== 'function') { resolve(); return; }
      stream.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      stream.on('end', resolve);
      stream.on('error', resolve);
    });
    const text = rewritePlaylist(Buffer.concat(chunks).toString('utf8'), target, wrap, authQuery);
    const body = Buffer.from(text, 'utf8');
    headers['Content-Type'] = 'application/vnd.apple.mpegurl';
    headers['Content-Length'] = body.length;
    res.writeHead(status, headers);
    res.end(body);
    return;
  }

  if (upstream.headers['content-length']) {
    headers['Content-Length'] = upstream.headers['content-length'];
  }
  res.writeHead(status, headers);
  if (stream && typeof stream.pipe === 'function') {
    stream.pipe(res);
    res.on('close', () => { try { stream.destroy(); } catch {} });
  } else {
    res.end();
  }
}

async function handleAbibliProxy(req, res, urlObj) {
  const m = urlObj.pathname.match(/^\/abibli\/([a-f0-9]+)\/(master(?:\.m3u8)?|stream)$/i);
  if (!m) { res.writeHead(404, { 'Access-Control-Allow-Origin': '*' }); res.end('Not found'); return; }

  const sessionInfo = abibliSessions.get(m[1]);
  if (!sessionInfo) { res.writeHead(410, { 'Access-Control-Allow-Origin': '*' }); res.end('Stream session expired'); return; }

  const target = m[2].toLowerCase().startsWith('master') ? sessionInfo.playlistUrl : urlObj.searchParams.get('u');
  if (!target) { res.writeHead(400, { 'Access-Control-Allow-Origin': '*' }); res.end('Missing stream URL'); return; }

  let parsed;
  try { parsed = new URL(target); } catch { res.writeHead(400); res.end('Bad URL'); return; }
  if (parsed.hostname !== ABIBLI_STREAM_HOST) {
    res.writeHead(403, { 'Access-Control-Allow-Origin': '*' }); res.end('Host not allowed'); return;
  }

  const wrap = (abs) => `${getLocalProxyBase()}/abibli/${m[1]}/stream?u=${encodeURIComponent(abs)}`;
  let authQuery = '';
  try { authQuery = new URL(sessionInfo.playlistUrl).searchParams.toString(); } catch {}

  try {
    const upstream = await fetchProxiedStream(target, {
      'Origin': ABIBLI_ORIGIN,
      'Referer': ABIBLI_ORIGIN + '/',
      'X-S5V-Client': sessionInfo.client
    }, req);
    await sendProxyStream(req, res, upstream, target, wrap, authQuery);
  } catch (e) {
    res.writeHead(502, { 'Access-Control-Allow-Origin': '*' }); res.end('Proxy error: ' + e.message);
  }
}

async function handleGenericHlsProxy(req, res, urlObj) {
  const target = urlObj.searchParams.get('u');
  const origin = urlObj.searchParams.get('o') || '';
  if (!target) { res.writeHead(400, { 'Access-Control-Allow-Origin': '*' }); res.end('Missing u'); return; }

  let parsed;
  try { parsed = new URL(target); } catch { res.writeHead(400); res.end('Bad URL'); return; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    res.writeHead(403, { 'Access-Control-Allow-Origin': '*' }); res.end('Protocol not allowed'); return;
  }

  const extra = {};
  if (origin) {
    extra['Origin'] = origin;
    extra['Referer'] = origin.endsWith('/') ? origin : origin + '/';
  }

  const wrap = (abs) => `${getLocalProxyBase()}/hls?u=${encodeURIComponent(abs)}&o=${encodeURIComponent(origin)}`;
  try {
    const upstream = await fetchProxiedStream(target, extra, req);
    await sendProxyStream(req, res, upstream, target, wrap, '');
  } catch (e) {
    res.writeHead(502, { 'Access-Control-Allow-Origin': '*' }); res.end('Proxy error: ' + e.message);
  }
}

// Tiny local HTTP server to serve downloaded media files with proper MIME types
function startLocalMediaServer() {
  const downloadsDir = path.join(app.getPath('downloads'), 'Void Streamer');
  const server = http.createServer((req, res) => {
    let urlObj;
    try { urlObj = new URL(req.url, 'http://127.0.0.1'); } catch { res.writeHead(400); res.end('Bad request'); return; }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS'
      });
      res.end();
      return;
    }

    if (urlObj.pathname.startsWith('/abibli/')) {
      handleAbibliProxy(req, res, urlObj);
      return;
    }
    if (urlObj.pathname === '/hls') {
      handleGenericHlsProxy(req, res, urlObj);
      return;
    }

    const filePath = path.join(downloadsDir, decodeURIComponent(urlObj.pathname.slice(1)));
    // Security: only serve files inside the downloads directory
    if (!filePath.startsWith(downloadsDir + path.sep) && filePath !== downloadsDir) {
      res.writeHead(403); res.end('Forbidden');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const stat = getFs().statSync(filePath, { throwIfNoEntry: false });
    if (!stat) {
      res.writeHead(404); res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*'
    });
    const stream = getFs().createReadStream(filePath);
    stream.pipe(res);
    stream.on('error', () => { res.writeHead(500); res.end('Error'); });
  });
  server.listen(0, '127.0.0.1', () => {
    localMediaPort = server.address().port;
    console.log('Local media server on port', localMediaPort);
  });
  return server;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 420,
    minHeight: 320,
    icon: path.join(__dirname, 'icon.png'),
    titleBarStyle: 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    },
    show: false,
    autoHideMenuBar: true
  });

  // Built-in Ad Blocker
  const AD_BLOCK_LIST = [
    '*://*.doubleclick.net/*',
    '*://*.googlesyndication.com/*',
    '*://*.google-analytics.com/*',
    '*://*.analytics.google.com/*',
    '*://*.popads.net/*',
    '*://*.popcash.net/*',
    '*://*.adsterra.com/*',
    '*://*.onclickads.net/*',
    '*://*.exoclick.com/*',
    '*://*.juicyads.com/*',
    '*://*.propellerads.com/*',
    '*://*.onclicktop.com/*',
    '*://*.ad-maven.com/*',
    '*://*.coinad.com/*',
    '*://*.a-ads.com/*',
    '*://*/*.js?*popunder*',
    '*://*/*popunder*.js*',
    '*://*/*adsterra*',
    '*://*/*exoclick*'
  ];

  session.defaultSession.webRequest.onBeforeRequest({ urls: AD_BLOCK_LIST }, (details, callback) => {
    // Silently cancel all matching ad network requests
    callback({ cancel: true });
  });

  mainWindow.loadFile('index.html');

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    console.log(`[RENDERER CONSOLE] ${message} (at ${sourceId}:${line})`);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

}

// Security: block navigation and new windows (except video streams and local server)
app.on('web-contents-created', (event, contents) => {
  contents.on('will-navigate', (event, url) => {
    // Allow local server and video stream URLs to navigate normally
    if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost') ||
        url.includes('.m3u8') || url.includes('.mp4') || url.includes('.ts') ||
        url.endsWith('.txt')) {
      return;
    }
    event.preventDefault();
    shell.openExternal(url);
  });
  contents.setWindowOpenHandler(({ url }) => {
    // Allow video stream URLs to open in the app
    if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost') ||
        url.includes('.m3u8') || url.includes('.mp4') || url.includes('.ts') ||
        url.endsWith('.txt')) {
      return { action: 'allow' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });
});

app.whenReady().then(() => {
  // Enable HTTP cache for faster subsequent loads
  const ses = session.defaultSession;
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    callback({ requestHeaders: { ...details.requestHeaders, 'Cache-Control': 'max-age=3600' } });
  });

  // Preconnect to critical domains (warm TLS so first plays feel instant)
  const preconnectDomains = [
    'https://api.themoviedb.org', 'https://streamex.sh', 'https://image.tmdb.org',
    'https://streamdata.vaplayer.ru', 'https://abibli.com', 'https://s5v.lazyrocket.space',
    'https://moon.goldenkite.top', 'https://vitostream.space', 'https://tok.1x2.space',
    'https://cache.vdrk.site', 'https://natsuki.hls.lol'
  ];
  preconnectDomains.forEach(url => {
    try { ses.resolveHost(url).catch(() => {}); } catch {}
  });

  // Startup provider health check (lightweight pings)
  runProviderHealthChecks();

  createWindow();
  startLocalMediaServer();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ─── Provider health checks ──────────────────────────────────────────────────
// Lightweight reachability pings, refreshed periodically. The renderer uses
// these to show a status dot next to each source chip.
const PROVIDER_HEALTH_TARGETS = [
  { key: 'StreameX', url: 'https://play.xpass.top/' },
  { key: 'Moviepire', url: 'https://moviepire.org/' },
  { key: 'RiveStream', url: 'https://www.rivestream.app/' },
  { key: '7REELS', url: 'https://7reels.cc/' },
  { key: 'Abibli', url: 'https://abibli.com/search/suggest?q=Av' },
  { key: 'PeeStream', url: 'https://streamdata.vaplayer.ru/api.php?tmdb=550&type=movie' },
  { key: 'KawaiiAnime', url: 'https://kawaii-anime.com/' },
  { key: 'AnimeX', url: 'https://animex.one/' },
  { key: 'Anikoto', url: 'https://anikototv.to/home' }
];
const providerHealth = {};
let healthRunning = false;

async function runProviderHealthChecks() {
  if (healthRunning) return;
  healthRunning = true;
  const { net } = require('electron');
  const ping = (t) => new Promise((resolve) => {
    let done = false;
    const finish = (status) => { if (!done) { done = true; providerHealth[t.key] = status; resolve(); } };
    try {
      const req = net.request({ method: 'GET', url: t.url });
      req.setHeader('User-Agent', ABIBLI_UA);
      const timer = setTimeout(() => { try { req.abort(); } catch {}; finish('err'); }, 10000);
      req.on('response', (resp) => { clearTimeout(timer); finish(resp.statusCode < 500 ? 'ok' : 'err'); });
      req.on('error', () => { clearTimeout(timer); finish('err'); });
      req.end();
    } catch { finish('err'); }
  });
  await Promise.all(PROVIDER_HEALTH_TARGETS.map(ping));
  healthRunning = false;
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('provider-health', { ...providerHealth });
  } catch {}
}

ipcMain.handle('get-provider-health', async () => {
  if (!Object.keys(providerHealth).length) runProviderHealthChecks();
  return { ...providerHealth };
});

setInterval(() => { runProviderHealthChecks(); }, 5 * 60 * 1000);

// IPC: Scrape listing page (latest or search results)
ipcMain.handle('scrape-url', async (event, { url, config }) => {
  try {
    return await getScraper().scrape(url, config);
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// IPC: Scrape detail page for download options
ipcMain.handle('scrape-detail', async (event, { url, config }) => {
  try {
    return await getScraper().scrapeDetail(url, config);
  } catch (error) {
    return { success: false, error: error.message, downloads: [] };
  }
});

// IPC: Open link in system default browser/app
ipcMain.on('open-external', (event, url) => {
  if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
    shell.openExternal(url);
  }
});

// ─── External subtitles (VDRK direct VTT + Natsuki SRT) ─────────────────────
// The video providers ship no embedded subtitles, so the player pulls them
// from public subtitle APIs keyed by TMDB/IMDb ids.
async function fetchSubsJson(url, extraHeaders) {
  const resp = await getAxios().get(url, {
    headers: {
      'User-Agent': ABIBLI_UA,
      'Accept': 'application/json',
      ...(extraHeaders || {})
    },
    timeout: 20000,
    validateStatus: () => true
  });
  return resp;
}

function orderSubtitleList(list) {
  const rank = (label) => {
    const l = String(label || '').toLowerCase();
    if (l.startsWith('english')) return 0;
    if (l.startsWith('arabic')) return 1;
    if (l.startsWith('hindi')) return 2;
    return 3;
  };
  return (list || [])
    .filter(s => s && s.url)
    .sort((a, b) => rank(a.label) - rank(b.label) || String(a.label).localeCompare(String(b.label)));
}

ipcMain.handle('fetch-subtitles', async (event, { tmdb, imdb, type, season, episode }) => {
  const results = [];
  try {
    const isTv = type === 'tv';
    const vdrkUrl = 'https://sub.vdrk.site/v1/' + (isTv
      ? `tv/${encodeURIComponent(tmdb || '')}/${season || 1}/${episode || 1}`
      : `movie/${encodeURIComponent(tmdb || '')}`);
    if (tmdb) {
      const resp = await fetchSubsJson(vdrkUrl);
      let raw = resp.data;
      if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch {} }
      if (resp.status === 200 && Array.isArray(raw)) {
        for (const item of raw) {
          if (item && typeof item.file === 'string' && item.file.startsWith('http')) {
            results.push({ label: item.label || 'Unknown', url: item.file, ext: 'vtt', source: 'VDRK' });
          }
        }
      }
    }

    if (imdb) {
      const natsukiHeaders = { 'Origin': 'https://cinecat.eu', 'Referer': 'https://cinecat.eu/' };
      const resp = await fetchSubsJson('https://natsuki.hls.lol/subs?imdbId=' + encodeURIComponent(imdb), natsukiHeaders);
      let raw = resp.data;
      if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch {} }
      const subs = raw && Array.isArray(raw.subtitles) ? raw.subtitles : [];
      for (const item of subs) {
        if (item && typeof item.url === 'string' && item.url.startsWith('http')) {
          results.push({ label: item.language || 'Unknown', url: item.url, ext: 'srt', source: 'Natsuki' });
        }
      }
    }
  } catch (e) {
    return { success: results.length > 0, subtitles: orderSubtitleList(results), error: e.message };
  }
  return { success: results.length > 0, subtitles: orderSubtitleList(results).slice(0, 60) };
});

ipcMain.handle('fetch-subtitle-text', async (event, { url }) => {
  try {
    const resp = await getAxios().get(url, {
      headers: { 'User-Agent': ABIBLI_UA, 'Accept': 'text/vtt,text/plain,*/*' },
      timeout: 20000,
      responseType: 'text',
      validateStatus: () => true
    });
    if (resp.status !== 200) return { success: false, error: 'HTTP ' + resp.status };
    return { success: true, text: String(resp.data || '') };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// IPC: Pick a subtitle file from disk (WebVTT) for the player's captions.
ipcMain.handle('pick-subtitle-file', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [
        { name: 'WebVTT subtitles', extensions: ['vtt'] },
        { name: 'All files', extensions: ['*'] }
      ]
    });
    if (result.canceled || !result.filePaths.length) {
      return { success: false, error: 'Cancelled' };
    }
    const filePath = result.filePaths[0];
    const text = getFs().readFileSync(filePath, 'utf8');
    return { success: true, name: path.basename(filePath), text };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('play-local-file', async (event, filePath) => {
  if (filePath && typeof filePath === 'string' && localMediaPort > 0) {
    const downloadsDir = path.join(app.getPath('downloads'), 'Void Streamer');
    // Cached files live in the app's cache dir; saved files live in Downloads.
    // The local media server only serves the downloads dir, so anything else
    // (i.e. the cache) has to be copied over there first.
    let target = filePath;
    const inDownloads = (() => {
      const rel = path.relative(downloadsDir, target);
      return !rel.startsWith('..') && !path.isAbsolute(rel);
    })();
    if (!inDownloads) {
      const cacheDir = getCacheDir();
      const rel = path.relative(cacheDir, target);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        return { success: false, error: 'Cannot play file' };
      }
      if (!getFs().existsSync(downloadsDir)) getFs().mkdirSync(downloadsDir, { recursive: true });
      target = path.join(downloadsDir, path.basename(target));
      try {
        if (!getFs().existsSync(target)) getFs().copyFileSync(filePath, target);
      } catch (e) {
        return { success: false, error: e.message };
      }
    }
    const relPath = path.relative(downloadsDir, target);
    if (!relPath.startsWith('..') && !path.isAbsolute(relPath)) {
      const url = `http://127.0.0.1:${localMediaPort}/${encodeURIComponent(relPath)}`;
      return { success: true, url };
    }
  }
  return { success: false, error: 'Cannot play file' };
});

// IPC: Scrape a SPA (React) page by loading it in a hidden browser window and executing JS to extract DOM data
ipcMain.handle('scrape-spa', async (event, { url, jsCode }) => {
  return new Promise((resolve) => {
    let resolved = false;

    const win = new BrowserWindow({
      width: 1280, height: 800, show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false }
    });

    const cleanup = () => { if (!win.isDestroyed()) win.destroy(); };
    const tryResolve = (result) => {
      if (resolved) return false;
      resolved = true; cleanup(); resolve(result);
      return true;
    };

    const timeout = setTimeout(() => {
      tryResolve({ success: false, error: 'Timed out waiting for SPA page to render', items: [] });
    }, 30000);

    // Wait for the SPA to finish loading, then run the extraction code in the page
    win.webContents.on('did-finish-load', async () => {
      if (resolved) return;

      try {
        const result = await win.webContents.executeJavaScript(jsCode);
        if (result !== null && result !== undefined) {
          tryResolve({ success: true, data: result });
          clearTimeout(timeout);
        } else {
          // Wait a bit more and retry
          await new Promise(r => setTimeout(r, 4000));
          if (resolved) return;
          const retry = await win.webContents.executeJavaScript(jsCode);
          if (retry !== null && retry !== undefined) {
            tryResolve({ success: true, data: retry });
          } else {
            tryResolve({ success: false, error: 'SPA page rendered but JS extraction returned no data', items: [] });
          }
        }
      } catch (e) {
        tryResolve({ success: false, error: `SPA extraction error: ${e.message}`, items: [] });
      }
      clearTimeout(timeout);
    });

    win.webContents.on('did-fail-load', (e, code, desc) => {
      tryResolve({ success: false, error: `Page failed to load: ${desc}`, items: [] });
      clearTimeout(timeout);
    });

    win.webContents.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    win.loadURL(url);
  });
});

// IPC: Scrape MoviBox stream URL via hidden browser window
// This intercepts the actual video stream network request that JS triggers after page load
ipcMain.handle('scrape-movibox-stream', async (event, { url }) => {
  return new Promise((resolve) => {
    let resolved = false;

    const win = new BrowserWindow({
      width: 1280,
      height: 800,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    });

    const cleanup = () => {
      if (!win.isDestroyed()) win.destroy();
    };

    const tryResolve = (result) => {
      if (resolved) return false;
      resolved = true;
      // Capture the page origin BEFORE destroying the window.
      let pageOrigin = '';
      try { pageOrigin = new URL(win.getURL() || url).origin; } catch {}
      cleanup();
      // Provider CDNs (xpass, VidFast/VidCore, VidLink, ...) either lack
      // CORS headers or reject requests without a matching Origin/Referer,
      // so the file:// player cannot play their streams directly. Route
      // every remote stream through the local header-injecting proxy,
      // using the embed page's origin as the Origin/Referer.
      if (result && result.success && result.streamUrl && /^https?:\/\//.test(result.streamUrl) &&
          !result.streamUrl.startsWith('http://127.0.0.1') && !result.streamUrl.startsWith('http://localhost')) {
        const origin = pageOrigin || 'https://vidfast.vc';
        result.streamUrl = `${getLocalProxyBase()}/hls?u=${encodeURIComponent(result.streamUrl)}&o=${encodeURIComponent(origin)}`;
      }
      resolve(result);
      return true;
    };

    // These ad-heavy players can take a while to leak the real stream URL.
    const timeoutMs = url.includes('vidfast.vc') ? 60000 : 45000;
    const timeout = setTimeout(() => {
      tryResolve({ success: false, error: 'Timed out waiting for stream URL' });
    }, timeoutMs);

    // Helper: extract stream URL from the page (video element, Pinia, Nuxt, or player data)
    function extractStreamUrl() {
      if (win.isDestroyed()) return Promise.resolve(null);
      return win.webContents.executeJavaScript(`
        (function() {
          // Check video element
          const v = document.querySelector('video[src]');
          const src = v ? (v.src || v.getAttribute('src') || '') : '';
          if (src.startsWith('http') && !src.includes('youtube') && !src.includes('ytimg') && !src.includes('ytimg')) return src;

          // Check Pinia store
          if (window.__pinia) {
            try {
              const s = JSON.stringify(window.__pinia);
              const m = s.match(/(https?:\\/\\/[^"'\\s]+\\.(?:m3u8|mp4|txt))[^"'\\s]*/g);
              if (m) {
                const real = m.filter(u => !u.includes('/trailer/') && !u.includes('trailer'));
                return real.length > 0 ? real[0] : m[0];
              }
            } catch(e) {}
          }

          // Check Nuxt state
          if (window.__NUXT__) {
            try {
              const s = JSON.stringify(window.__NUXT__);
              const m = s.match(/(https?:\\/\\/[^"'\\s]+\\.(?:m3u8|mp4|txt))[^"'\\s]*/g);
              if (m) return m[0];
            } catch(e) {}
          }

          return null;
        })()
      `).catch(() => null);
    }

    // Poll for a stream URL every 500ms, up to maxMs
    function pollForStream(maxMs) {
      const interval = 500;
      let elapsed = 0;
      return new Promise((res) => {
        const check = async () => {
          if (resolved || elapsed >= maxMs) { res(null); return; }
          const url = await extractStreamUrl();
          if (url && !resolved) { res(url); return; }
          elapsed += interval;
          setTimeout(check, interval);
        };
        check();
      });
    }

    // Intercept all network requests to find video stream URLs
    win.webContents.session.webRequest.onBeforeRequest(
      { urls: ['*://*/*'] },
      (details, callback) => {
        const reqUrl = details.url;
        const isStream = (
          (reqUrl.includes('.m3u8') || reqUrl.includes('.mp4') || reqUrl.includes('.ts') || reqUrl.endsWith('.txt')) &&
          !reqUrl.includes('youtube') &&
          !reqUrl.includes('ytimg') &&
          !reqUrl.includes('googlevideo') &&
          (reqUrl.startsWith('http://') || reqUrl.startsWith('https://'))
        );

        if (isStream) {
          if (tryResolve({ success: true, streamUrl: reqUrl })) {
            clearTimeout(timeout);
            callback({ cancel: false });
            return;
          }
        }
        callback({ cancel: false });
      }
    );

    // Track play button clicks to avoid looping
    let playClicked = false;

    // Handle navigation-to-player: poll for video instead of blind wait
    win.webContents.on('did-navigate', async () => {
      if (resolved) return;
      const url = await pollForStream(5000);
      if (url && !resolved) tryResolve({ success: true, streamUrl: url });
    });

    win.webContents.on('did-finish-load', async () => {
      // Poll instead of blind 7s wait — checks every 500ms, resolves as soon as found
      const earlyUrl = await pollForStream(3000);
      if (earlyUrl && !resolved) { clearTimeout(timeout); tryResolve({ success: true, streamUrl: earlyUrl }); return; }

      if (resolved) return;

      // ---- PHASE 1b: Extract stream URL from JWPlayer data object (play.xpass.top, etc.) ----
      try {
        const jwpUrl = await win.webContents.executeJavaScript(`
          (async function() {
            try {
              const scripts = document.querySelectorAll('script');
              for (const s of scripts) {
                const text = s.textContent || '';
                if (text.includes('playlist') && (text.includes('/mvid/') || text.includes('playlist.json'))) {
                  const pd = text.match(/"playlist":"([^"]+)"/);
                  if (!pd) continue;
                  const base = window.location.origin;
                  const playlistUrl = pd[1].startsWith('http') ? pd[1] : base + pd[1];
                  const resp = await fetch(playlistUrl);
                  const data = await resp.json();
                  const file = data.playlist && data.playlist[0] && data.playlist[0].sources && data.playlist[0].sources[0] && data.playlist[0].sources[0].file;
                  if (file && file.startsWith('http')) return file;
                }
              }
            } catch(e) {}
            return null;
          })()
        `);
        if (jwpUrl && tryResolve({ success: true, streamUrl: jwpUrl })) { clearTimeout(timeout); return; }
      } catch (e) {
        console.error('[scrape-movibox-stream] JWPlayer extract error:', e.message);
      }

      // ---- PHASE 2: Click play/lookup buttons to trigger the real video load ----
      if (!resolved && !playClicked) {
        playClicked = true;
        try {
          await win.webContents.executeJavaScript(`
            (async function() {
              const wait = ms => new Promise(r => setTimeout(r, ms));
              const candidates = [];
              document.querySelectorAll('button, a, [role="button"], [onclick], .cursor-pointer').forEach(el => {
                const text = (el.textContent || '').trim().toLowerCase();
                const html = el.innerHTML.toLowerCase();
                const cls = (el.className || '').toLowerCase();
                const aria = (el.getAttribute('aria-label') || '').toLowerCase();
                const href = (el.getAttribute('href') || '').toLowerCase();
                let score = 0;
                if (text.includes('watch') || text.includes('play') || text.includes('regarder')) score += 10;
                if (text.includes('now') || text.includes('online') || text.includes('film')) score += 5;
                if (aria.includes('watch') || aria.includes('play')) score += 10;
                if (cls.includes('play') || cls.includes('watch')) score += 8;
                if (html.includes('▶') || html.includes('play') || html.includes('►')) score += 6;
                if (href.includes('/play/') || href.includes('/video/')) score += 12;
                if (score > 0) candidates.push({ el, score, text: text.substring(0, 30) });
              });
              candidates.sort((a, b) => b.score - a.score);
              for (const c of candidates.slice(0, 5)) {
                c.el.click();
                await wait(2000);
              }
            })()
          `);
        } catch (e) {
          console.error('[scrape-movibox-stream] click play error:', e.message);
        }

        // Poll for video after click instead of blind 8s wait
        const afterClickUrl = await pollForStream(5000);
        if (afterClickUrl && !resolved) { clearTimeout(timeout); tryResolve({ success: true, streamUrl: afterClickUrl }); return; }

        // ---- PHASE 3: Try source tab clicks as fallback ----
        if (!resolved) {
          try {
            await win.webContents.executeJavaScript(`
              (async function() {
                const wait = ms => new Promise(r => setTimeout(r, ms));
                const tabs = document.querySelectorAll('.type-item, [class*="type-tab"], [class*="source-tab"]');
                for (const tab of tabs) {
                  tab.click();
                  await wait(2000);
                  const v = document.querySelector('video[src]');
                  if (v && v.src && v.src.startsWith('http') && !v.src.includes('youtube')) return v.src;
                }
                return null;
              })()
            `);
            const finalUrl = await extractStreamUrl();
            if (finalUrl && tryResolve({ success: true, streamUrl: finalUrl })) { clearTimeout(timeout); return; }
          } catch (e) {}
        }
      }

      if (!resolved) {
        clearTimeout(timeout);
        tryResolve({ success: false, error: 'No stream URL found. The movie may require login or a different player.' });
      }
    });

    win.webContents.on('did-fail-load', (e, code, desc) => {
      if (tryResolve({ success: false, error: `Page failed to load: ${desc}` })) {
        clearTimeout(timeout);
      }
    });

    win.webContents.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    win.loadURL(url);
  });
});

// ─── Abibli stream resolver ──────────────────────────────────────────────────
const ABIBLI_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function abibliNormalizeTitle(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(?:season|series)\s*\d+.*$/i, ' ')
    .replace(/[^a-z0-9]+/g, '');
}

function pickAbibliItem(items, title, year, type) {
  const target = abibliNormalizeTitle(title);
  let best = null;
  let bestScore = -Infinity;

  for (const item of items || []) {
    const href = item.href || '';
    if (type === 'tv' && !href.includes('/series/')) continue;
    if (type !== 'tv' && !href.includes('/movie/')) continue;

    const itemTitle = abibliNormalizeTitle(item.title);
    const hrefYear = (href.match(/-(\d{4})(?:\?|$)/) || [])[1] || '';
    let score = 0;

    if (itemTitle && itemTitle === target) score += 100;
    else if (itemTitle && (itemTitle.startsWith(target) || target.startsWith(itemTitle))) score += 60;
    else if (itemTitle && (itemTitle.includes(target) || target.includes(itemTitle))) score += 25;
    else score -= 40;

    if (year && hrefYear) score += hrefYear === String(year) ? 50 : -30;
    if (href.includes('?season=')) score -= 20; // prefer the canonical title result

    if (score > bestScore) { bestScore = score; best = item; }
  }

  return bestScore > 0 ? best : null;
}

function parseAbibliPlays(html) {
  const plays = [];
  const re = /streamPlayer\.play\(\s*'([^']+)'\s*,\s*JSON\.parse\(\s*'((?:[^'\\]|\\.)*)'\s*\)\s*\)/g;
  let match;
  while ((match = re.exec(html))) {
    const streamUrl = match[1].replace(/\\\//g, '/');
    let data = {};
    try {
      const decoded = match[2]
        .replace(/\\u0022/gi, '"')
        .replace(/\\u0027/gi, "'")
        .replace(/\\\//g, '/');
      data = JSON.parse(decoded);
    } catch {}
    plays.push({ streamUrl, data });
  }

  if (!plays.length) {
    const fallback = /streamPlayer\.play\(\s*'([^']+)'/g;
    while ((match = fallback.exec(html))) {
      plays.push({ streamUrl: match[1].replace(/\\\//g, '/'), data: {} });
    }
  }
  return plays;
}

async function abibliFetch(url, accept) {
  const resp = await getAxios().get(url, {
    headers: {
      'User-Agent': ABIBLI_UA,
      'Accept': accept,
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://abibli.com/'
    },
    timeout: 20000
  });
  return resp.data;
}

// Core Abibli resolution shared by the Abibli IPC and PeeStream's fallback.
async function resolveAbibliByQuery(title, year, type, season, episode) {
  if (!title) return { success: false, error: 'Missing title for Abibli lookup' };
  try {

    const suggest = await abibliFetch(
      'https://abibli.com/search/suggest?q=' + encodeURIComponent(title),
      'application/json'
    );
    const items = Array.isArray(suggest && suggest.items) ? suggest.items : [];
    const picked = pickAbibliItem(items, title, year, type);
    if (!picked) {
      return { success: false, error: `"${title}" is not available on Abibli` };
    }

    const detailUrl = picked.href.split('?')[0];
    let html = await abibliFetch(detailUrl, 'text/html');
    let plays = parseAbibliPlays(String(html));
    let play = null;

    if (type === 'tv') {
      play = plays.find(p =>
        Number(p.data.seasonNumber) === season && Number(p.data.episodeNumber) === episode
      );
      if (!play) {
        const seasonHtml = await abibliFetch(`${detailUrl}?season=${season}`, 'text/html');
        plays = parseAbibliPlays(String(seasonHtml));
        play = plays.find(p =>
          Number(p.data.seasonNumber) === season && Number(p.data.episodeNumber) === episode
        );
      }
    } else {
      play = plays.find(p => p.data.type === 'movie') || plays[0];
    }

    if (!play) {
      return {
        success: false,
        error: type === 'tv'
          ? `Abibli does not have S${season}E${episode} of "${title}" yet`
          : `No playable stream found for "${title}" on Abibli`
      };
    }

    const hash = (play.data.streamUrl || play.streamUrl || '').split('#')[1] || '';
    if (!/^[A-Za-z0-9]{6}$/.test(hash)) {
      return { success: false, error: 'Abibli returned an invalid stream id' };
    }

    const client = crypto.randomBytes(16).toString('hex');
    const signed = await getAxios().post('https://s5v.lazyrocket.space/mQ7x2P', {
      video: hash,
      client
    }, {
      headers: {
        'User-Agent': ABIBLI_UA,
        'Origin': ABIBLI_ORIGIN,
        'Referer': ABIBLI_ORIGIN + '/',
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'X-S5V-Client': client
      },
      timeout: 20000
    });

    const playlist = signed.data && signed.data.playlist;
    if (!playlist) return { success: false, error: 'Abibli stream server did not return a playlist' };

    const playlistUrl = new URL(playlist, 'https://s5v.lazyrocket.space').href;
    pruneAbibliSessions();
    const token = crypto.randomBytes(12).toString('hex');
    abibliSessions.set(token, {
      playlistUrl,
      client,
      origin: ABIBLI_ORIGIN,
      createdAt: Date.now()
    });

    return {
      success: true,
      streamUrl: `${getLocalProxyBase()}/abibli/${token}/master.m3u8`,
      title: play.data.title || title
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

ipcMain.handle('resolve-abibli-stream', async (event, { url }) => {
  const pseudo = new URL(url);
  return resolveAbibliByQuery(
    pseudo.searchParams.get('title') || '',
    pseudo.searchParams.get('year') || '',
    pseudo.searchParams.get('type') === 'tv' ? 'tv' : 'movie',
    parseInt(pseudo.searchParams.get('season') || '1', 10),
    parseInt(pseudo.searchParams.get('episode') || '1', 10)
  );
});

// ─── PeeStream stream resolver ───────────────────────────────────────────────
// PeeStream (P-Stream fork + vidapi backend) exposes a JSON API keyed by TMDB
// id that returns direct master.m3u8 URLs with permissive CORS headers
// (Accessory-Allow-Origin: *), so they can be played without the local proxy.
ipcMain.handle('resolve-peestream-stream', async (event, { url }) => {
  try {
    const pseudo = new URL(url);
    const tmdb = String(pseudo.searchParams.get('tmdb') || '').trim();
    const type = pseudo.searchParams.get('type') === 'tv' ? 'tv' : 'movie';
    const season = parseInt(pseudo.searchParams.get('season') || '1', 10);
    const episode = parseInt(pseudo.searchParams.get('episode') || '1', 10);

    if (!/^\d+$/.test(tmdb)) {
      return { success: false, error: 'Missing TMDB id for PeeStream lookup' };
    }

    const apiUrl = 'https://streamdata.vaplayer.ru/api.php?tmdb=' + encodeURIComponent(tmdb) +
      '&type=' + type + (type === 'tv' ? `&season=${season}&episode=${episode}` : '');

    // The API host occasionally stalls; retry once on network trouble / 5xx.
    let resp = null;
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        resp = await getAxios().get(apiUrl, {
          headers: {
            'User-Agent': ABIBLI_UA,
            'Accept': 'application/json'
          },
          timeout: 20000,
          validateStatus: () => true
        });
        if (resp.status < 500) break;
      } catch (e) {
        lastErr = e;
        resp = null;
      }
      if (attempt === 0) await new Promise(r => setTimeout(r, 1200));
    }
    const fallbackTitle = pseudo.searchParams.get('title') || '';
    const fallbackYear = pseudo.searchParams.get('year') || '';

    // Helper: last-ditch Abibli attempt with the same title/year/episode.
    const tryAbibliFallback = async (peestreamError) => {
      if (!fallbackTitle) return { success: false, error: peestreamError };
      const fb = await resolveAbibliByQuery(fallbackTitle, fallbackYear, type, season, episode)
        .catch(() => ({ success: false }));
      if (fb.success) return fb;
      return { success: false, error: peestreamError };
    };

    if (!resp) return tryAbibliFallback(lastErr ? lastErr.message : 'PeeStream API unreachable');

    if (resp.status !== 200) {
      return tryAbibliFallback(
        type === 'tv'
          ? `PeeStream does not have S${season}E${episode} yet`
          : 'This title is not available on PeeStream'
      );
    }

    let data = resp.data;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch { return tryAbibliFallback('Invalid response from PeeStream API'); }
    }

    const streams = data && data.data && Array.isArray(data.data.stream_urls)
      ? data.data.stream_urls.filter(u => typeof u === 'string' && u.startsWith('http'))
      : [];

    if (!streams.length) {
      return tryAbibliFallback(
        type === 'tv'
          ? `PeeStream does not have S${season}E${episode} yet`
          : 'No playable stream found on PeeStream'
      );
    }

    return {
      success: true,
      streamUrl: streams[0],
      streamUrls: streams,
      title: data.data.title || ''
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ── HLS (.m3u8) download helpers ────────────────────────────────────────────
function resolveUrl(base, href) {
  if (href.startsWith('http://') || href.startsWith('https://')) return href;
  const idx = base.lastIndexOf('/');
  const dir = idx >= 0 ? base.substring(0, idx + 1) : base + '/';
  if (href.startsWith('/')) {
    try {
      const u = new URL(base);
      return `${u.protocol}//${u.host}${href}`;
    } catch { return dir + href.replace(/^\//, ''); }
  }
  return dir + href;
}

async function downloadHls(playlistUrl, outputPath, downloadId, image) {
  const send = (type, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(type, { downloadId, ...data });
  };

  async function fetchText(url) {
    const resp = await getAxios().get(url, { headers: BROWSER_HEADERS, timeout: 20000, responseType: 'text' });
    return typeof resp.data === 'string' ? resp.data : resp.data.toString();
  }

  function parseVariants(body, baseUrl) {
    const lines = body.split('\n');
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes('#EXT-X-STREAM-INF:')) continue;
      const bw = parseInt(lines[i].match(/BANDWIDTH=(\d+)/i)?.[1] || '0', 10);
      const resolution = lines[i].match(/RESOLUTION=(\d+x\d+)/i)?.[1] || '';
      const next = lines[i + 1]?.trim();
      if (next && !next.startsWith('#')) {
        variants.push({ url: resolveUrl(baseUrl, next), bandwidth: bw, resolution });
      }
    }
    return variants.sort((a, b) => b.bandwidth - a.bandwidth);
  }

  function parseAudioRendition(body, baseUrl) {
    const audioLines = body.split('\n').filter(l => /#EXT-X-MEDIA:[^\n]*TYPE=AUDIO/i.test(l));
    if (!audioLines.length) return '';
    const preferred = audioLines.find(l => /DEFAULT=YES/i.test(l)) || audioLines[0];
    const uri = preferred.match(/URI="([^"]+)"/i)?.[1] || '';
    return uri ? resolveUrl(baseUrl, uri) : '';
  }

  function parseMediaPlaylist(body, baseUrl) {
    const segments = [];
    let initUrl = '';
    for (const raw of body.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('#EXT-X-MAP:')) {
        const uri = line.match(/URI="([^"]+)"/i)?.[1] || '';
        if (uri) initUrl = resolveUrl(baseUrl, uri);
        continue;
      }
      if (line.startsWith('#')) continue;
      // Accept every media URI: segments may use .ts, .m4s, .mp4, .aac,
      // or arbitrary extensions such as Abibli's .woff2 fMP4 segments.
      segments.push(resolveUrl(baseUrl, line));
    }
    return { initUrl, segments };
  }

  const passedBody = await fetchText(playlistUrl);
  let masterBody = '';
  let masterBase = '';
  let videoUrl = playlistUrl;
  let videoBody = passedBody;

  if (passedBody.includes('#EXT-X-STREAM-INF:')) {
    masterBody = passedBody;
    masterBase = playlistUrl;
    const best = parseVariants(masterBody, masterBase)[0];
    if (best) {
      videoUrl = best.url;
      videoBody = await fetchText(videoUrl);
    }
  } else {
    // If this is an Abibli proxy media playlist, fetch its master so the
    // separate audio rendition can be downloaded too.
    const proxyMatch = playlistUrl.match(/^(http:\/\/127\.0\.0\.1:\d+)\/abibli\/([a-f0-9]+)\//i);
    if (proxyMatch) {
      masterBase = `${proxyMatch[1]}/abibli/${proxyMatch[2]}/master.m3u8`;
      try { masterBody = await fetchText(masterBase); } catch {}
    }
  }

  const video = parseMediaPlaylist(videoBody, videoUrl);
  const audioUrl = masterBody ? parseAudioRendition(masterBody, masterBase) : '';
  let audio = null;

  if (!video.segments.length) throw new Error('No video segments found in HLS playlist');

  if (audioUrl) {
    const audioBody = await fetchText(audioUrl);
    audio = { ...parseMediaPlaylist(audioBody, audioUrl), url: audioUrl };
    if (!audio.segments.length) audio = null;
  }

  const totalUnits = video.segments.length + (video.initUrl ? 1 : 0) +
                     (audio ? audio.segments.length + (audio.initUrl ? 1 : 0) : 0);
  let doneUnits = 0;
  let bytesReceived = 0;
  const startedAt = Date.now();
  let lastSpeedSample = 0;
  let bytesTotal = 0;

  async function writeRemote(url, targetWriter) {
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const resp = await getAxios()({
          url,
          responseType: 'stream',
          timeout: 60000,
          headers: BROWSER_HEADERS
        });
        const len = parseInt(resp.headers['content-length'] || '0', 10);
        if (len > 0) bytesTotal += len;
        await new Promise((resolve, reject) => {
          resp.data.on('data', (chunk) => {
            bytesReceived += chunk.length;
            const now = Date.now();
            if (now - lastSpeedSample >= 400) {
              const elapsed = (now - startedAt) / 1000;
              const speed = elapsed > 0 ? Math.round(bytesReceived / elapsed) : 0;
              lastSpeedSample = now;
              const pct = totalUnits > 0 ? Math.min(99, Math.round((doneUnits / totalUnits) * 99)) : 0;
              send('download-progress', { percent: pct, received: bytesReceived, total: bytesTotal, speed });
            }
          });
          resp.data.pipe(targetWriter, { end: false });
          resp.data.on('end', resolve);
          resp.data.on('error', reject);
        });
        return;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  }

  async function writePlaylist(parsed, targetWriter) {
    if (parsed.initUrl) {
      await writeRemote(parsed.initUrl, targetWriter);
      doneUnits++;
    }
    for (const segment of parsed.segments) {
      await writeRemote(segment, targetWriter);
      doneUnits++;
      const pct = totalUnits > 0 ? Math.min(99, Math.round((doneUnits / totalUnits) * 99)) : 0;
      send('download-progress', { percent: pct, received: bytesReceived, total: bytesTotal, speed: 0 });
    }
    await new Promise((resolve, reject) => targetWriter.end(err => err ? reject(err) : resolve()));
  }

  // Subtitle sidecar: if the master offers a subtitles rendition, fetch it
  // and save it next to the video (same base name, .vtt extension).
  async function downloadSubtitles(masterBodyText, masterBaseUrl, outPath) {
    try {
      const lines = masterBodyText.split('\n').filter(l => /#EXT-X-MEDIA:[^\n]*TYPE=SUBTITLES/i.test(l));
      if (!lines.length) return '';
      const preferred = lines.find(l => /DEFAULT=YES/i.test(l)) || lines[0];
      const uri = preferred.match(/URI="([^"]+)"/i)?.[1] || '';
      if (!uri) return '';
      const subsUrl = resolveUrl(masterBaseUrl, uri);
      const text = await fetchText(subsUrl);
      if (!text || !text.startsWith('WEBVTT')) return '';
      const subsPath = outPath.replace(/(\.[^.]+)?$/, '.vtt');
      getFs().writeFileSync(subsPath, text, 'utf8');
      return subsPath;
    } catch {
      return '';
    }
  }

  const writer = getFs().createWriteStream(outputPath);
  try {
    await writePlaylist(video, writer);
    let audioPath = '';
    if (audio) {
      audioPath = outputPath.replace(/(\.[^.]+)?$/, '.audio.mp4');
      await writePlaylist(audio, getFs().createWriteStream(audioPath));
    }
    let subtitlesPath = '';
    if (masterBody) {
      subtitlesPath = await downloadSubtitles(masterBody, masterBase, outputPath);
    }
    return {
      path: outputPath,
      audioPath,
      subtitlesPath,
      isFmp4: !!video.initUrl,
      segmentCount: video.segments.length
    };
  } catch (e) {
    try { writer.destroy(); } catch {}
    throw e;
  }
}

function formatBytes(bytes) {
  if (bytes <= 0) return 'Unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let b = bytes;
  while (b >= 1024 && i < units.length - 1) { b /= 1024; i++; }
  return b.toFixed(1) + ' ' + units[i];
}

// IPC: Analyze a stream URL for quality options and estimated size
ipcMain.handle('analyze-stream', async (event, { url, quick }) => {
  if (!url) return { success: false, error: 'No URL provided' };

  const isM3u8 = url.includes('.m3u8');
  const isTxt = url.includes('.txt') || url.includes('.ts') || url.includes('.m4s');

  try {
    if (isM3u8 || isTxt) {
      const resp = await getAxios().get(url, { headers: BROWSER_HEADERS, timeout: 15000 });
      const body = typeof resp.data === 'string' ? resp.data : resp.data.toString();
      const lines = body.split('\n');

      // Check if it's actually an HLS playlist
      const isHls = body.includes('#EXTM3U') || body.includes('#EXT-X-STREAM-INF') || body.includes('#EXTINF');

      if (!isHls) {
        // It's a .txt but not HLS — treat as direct download, try HEAD for size
        try {
          const head = await getAxios().head(url, { headers: BROWSER_HEADERS, timeout: 15000 });
          const size = parseInt(head.headers['content-length'] || '0', 10);
          return { success: true, type: 'direct', qualities: [{ url, label: 'Direct', estimatedBytes: size, estimatedSize: size > 0 ? formatBytes(size) : 'Unknown' }] };
        } catch {
          return { success: true, type: 'direct', qualities: [{ url, label: 'Direct', estimatedBytes: 0, estimatedSize: 'Unknown' }] };
        }
      }

      // Check if variant playlist
      if (body.includes('#EXT-X-STREAM-INF:')) {
        const variants = [];
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes('#EXT-X-STREAM-INF:')) {
            const bw = parseInt(lines[i].match(/BANDWIDTH=(\d+)/i)?.[1] || '0', 10);
            const resolution = (lines[i].match(/RESOLUTION=(\d+x\d+)/i)?.[1] || '');
            const next = lines[i + 1]?.trim();
            if (next && !next.startsWith('#')) {
              const resolved = resolveUrl(url, next);
              // Clean label: height + "p" (e.g. RESOLUTION=1920x1080 -> "1080p")
              const height = (resolution.split('x')[1] || '').replace(/\D/g, '');
              const label = height
                ? height + 'p'
                : (bw > 8000000 ? '4K' : bw > 3000000 ? '1080p' : bw > 1500000 ? '720p' : bw > 700000 ? '480p' : bw > 300000 ? '360p' : '240p');
              variants.push({ url: resolved, bandwidth: bw, resolution, label });
            }
          }
        }
        // A master with a separate audio rendition must be played as a whole:
        // a variant media playlist alone would have no audio track.
        if (/#EXT-X-MEDIA:[^\n]*TYPE=AUDIO/i.test(body) && variants.length) {
          const best = variants.slice().sort((a, b) => b.bandwidth - a.bandwidth)[0];
          return {
            success: true,
            type: 'hls_variant',
            qualities: [{
              url,
              label: best.label,
              bandwidth: best.bandwidth,
              resolution: best.resolution,
              estimatedSize: 'Unknown'
            }]
          };
        }
        // Quick mode: skip size estimation, just return labels
        if (quick) {
          return { success: true, type: 'hls_variant', qualities: variants.map(v => ({ ...v, estimatedSize: 'Unknown' })).sort((a, b) => b.bandwidth - a.bandwidth) };
        }
        // Estimate sizes by fetching first segment of each variant
        const withSizes = await Promise.all(variants.map(async (v) => {
          try {
            const plResp = await getAxios().get(v.url, { headers: BROWSER_HEADERS, timeout: 10000 });
            const plBody = typeof plResp.data === 'string' ? plResp.data : plResp.data.toString();
            const segs = plBody.split('\n').filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('<'));
            const firstSeg = segs.find(s => /\.(ts|m4s|mp4)(\?|$)/i.test(s));
            if (firstSeg) {
              const segUrl = resolveUrl(v.url, firstSeg);
              const head = await getAxios().head(segUrl, { headers: BROWSER_HEADERS, timeout: 8000 });
              const segSize = parseInt(head.headers['content-length'] || '0', 10);
              if (segSize > 0) {
                v.estimatedBytes = segSize * segs.length;
                v.estimatedSize = formatBytes(v.estimatedBytes);
                return v;
              }
            }
          } catch {}
          v.estimatedBytes = 0;
          v.estimatedSize = 'Unknown';
          return v;
        }));
        return { success: true, type: 'hls_variant', qualities: withSizes.sort((a, b) => b.bandwidth - a.bandwidth) };
      }

      // Single quality HLS - estimate from segments
      if (quick) {
        return { success: true, type: 'hls_single', qualities: [{ url, label: 'Auto', estimatedSize: 'Unknown' }] };
      }
      const segs = lines.filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('<'));
      let estimatedBytes = 0;
      try {
        const firstSeg = segs.find(s => /\.(ts|m4s|mp4)(\?|$)/i.test(s));
        if (firstSeg) {
          const segUrl = resolveUrl(url, firstSeg);
          const head = await getAxios().head(segUrl, { headers: BROWSER_HEADERS, timeout: 8000 });
          const segSize = parseInt(head.headers['content-length'] || '0', 10);
          if (segSize > 0) estimatedBytes = segSize * segs.length;
        }
      } catch {}
      return { success: true, type: 'hls_single', qualities: [{ url, label: 'Auto', estimatedBytes, estimatedSize: estimatedBytes > 0 ? formatBytes(estimatedBytes) : 'Unknown' }] };
    }

    // MP4 or other direct media: HEAD for content-length
    try {
      const head = await getAxios().head(url, { headers: BROWSER_HEADERS, timeout: 15000 });
      const size = parseInt(head.headers['content-length'] || '0', 10);
      return { success: true, type: 'direct', qualities: [{ url, label: 'Direct', estimatedBytes: size, estimatedSize: size > 0 ? formatBytes(size) : 'Unknown' }] };
    } catch {
      return { success: true, type: 'direct', qualities: [{ url, label: 'Direct', estimatedBytes: 0, estimatedSize: 'Unknown' }] };
    }
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// IPC: Start downloading a video file via axios streaming (MP4) or HLS downloader (.m3u8 / .txt playlists)
ipcMain.handle('start-download', async (event, { url, title, quality, image }) => {
  if (!url) return { success: false, error: 'No URL provided' };

  const isM3u8 = url.includes('.m3u8');
  const isTxt = url.includes('.txt');
  // For .txt URLs, we need to detect if it's actually an HLS playlist by inspecting content
  let isHls = isM3u8;
  let hlsDetectedByContent = false;

  if (isTxt && !isM3u8) {
    try {
      const probe = await getAxios().get(url, { headers: BROWSER_HEADERS, timeout: 8000, responseType: 'text', maxRedirects: 3 });
      const body = typeof probe.data === 'string' ? probe.data : probe.data.toString();
      if (body.includes('#EXTM3U') || body.includes('#EXTINF')) {
        isHls = true;
        hlsDetectedByContent = true;
      }
    } catch {
      // If we can't probe, treat as non-HLS
    }
  }

  const ext = isHls ? '.mp4' : '.mp4';
  const defaultName = (title || 'video').replace(/[<>:"/\\|?*]/g, '_') + ext;
  const downloadsDir = path.join(app.getPath('downloads'), 'Void Streamer');
  if (!getFs().existsSync(downloadsDir)) getFs().mkdirSync(downloadsDir, { recursive: true });
  let filePath = path.join(downloadsDir, defaultName);
  if (getFs().existsSync(filePath)) {
    const base = defaultName.replace(/\.[^.]+$/, '');
    let counter = 1;
    while (getFs().existsSync(filePath)) {
      filePath = path.join(downloadsDir, `${base} (${counter})${ext}`);
      counter++;
    }
  }

  const downloadId = `dl_${++downloadIdCounter}`;

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('download-started', { downloadId, filename: path.basename(filePath), url, image });
  }

  try {
    if (isHls) {
      const mp4Path = filePath;
      const partPath = filePath.replace(/\.mp4$/, '.download.mp4');
      const result = await downloadHls(url, partPath, downloadId, image);

      if (result.audioPath) {
        // Separate video/audio renditions (Abibli) — mux them with FFmpeg WASM.
        await muxFmp4Renderer(partPath, result.audioPath, mp4Path, downloadId);
      } else if (result.isFmp4) {
        // Fragmented MP4 segments are already a valid MP4 after concatenation.
        try { if (getFs().existsSync(mp4Path)) getFs().unlinkSync(mp4Path); } catch {}
        getFs().renameSync(partPath, mp4Path);
      } else {
        // Classic TS segments: remux to MP4.
        const tsPath = filePath.replace(/\.mp4$/, '.ts');
        try { if (getFs().existsSync(tsPath)) getFs().unlinkSync(tsPath); } catch {}
        getFs().renameSync(partPath, tsPath);
        await remuxTsToMp4Renderer(tsPath, mp4Path, downloadId);
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('download-done', { downloadId, state: 'completed', path: mp4Path });
      }
      return { success: true, path: mp4Path };
    }

    // Direct MP4 / binary stream via axios
    const response = await getAxios()({
      url,
      responseType: 'stream',
      timeout: 120000,
      headers: BROWSER_HEADERS
    });

    const total = parseInt(response.headers['content-length'] || '0', 10);
    let received = 0;
    const writer = getFs().createWriteStream(filePath);
    const startedAt = Date.now();
    let lastSample = 0;

    // Track this download for pause/resume/cancel
    const dlState = { stream: response.data, writer, paused: false, filePath, received: 0, total };
    activeDownloads.set(downloadId, dlState);

    response.data.on('data', (chunk) => {
      if (dlState.paused) return; // skip writes when paused
      received += chunk.length;
      dlState.received = received;
      const now = Date.now();
      let speed;
      if (now - lastSample >= 400) {
        const elapsed = (now - startedAt) / 1000;
        speed = elapsed > 0 ? Math.round(received / elapsed) : 0;
        lastSample = now;
      }
      const percent = total > 0 ? Math.round((received / total) * 100) : 0;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('download-progress', { downloadId, percent, received, total, speed, paused: dlState.paused });
      }
    });

    response.data.pipe(writer);

    return new Promise((resolve) => {
      writer.on('finish', async () => {
        activeDownloads.delete(downloadId);
        // If the URL was .ts, remux to .mp4 via FFmpeg WASM
        const urlLower = (url || '').toLowerCase();
        if (urlLower.endsWith('.ts') && !urlLower.includes('.srt') && !urlLower.includes('.vtt')) {
          const mp4Path = filePath.replace(/\.ts$/, '.mp4');
          try {
            const remuxResult = await remuxTsToMp4Renderer(filePath, mp4Path, downloadId);
            if (remuxResult && remuxResult.success) {
              filePath = mp4Path;
            }
          } catch {}
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('download-done', { downloadId, state: 'completed', path: filePath });
        }
        resolve({ success: true, path: filePath });
      });
      writer.on('error', (err) => {
        activeDownloads.delete(downloadId);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('download-done', { downloadId, state: 'interrupted', path: filePath });
        }
        resolve({ success: false, error: err.message });
      });
    });
  } catch (e) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('download-done', { downloadId, state: 'interrupted' });
    }
    return { success: false, error: e.message };
  }
});

// IPC: Pause a download
ipcMain.handle('download-pause', async (event, { downloadId }) => {
  const dl = activeDownloads.get(downloadId);
  if (!dl) return { success: false, error: 'Download not found' };
  dl.paused = true;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('download-progress', { downloadId, percent: 0, received: dl.received, total: dl.total, speed: 0, paused: true });
  }
  return { success: true };
});

// IPC: Resume a download
ipcMain.handle('download-resume', async (event, { downloadId }) => {
  const dl = activeDownloads.get(downloadId);
  if (!dl) return { success: false, error: 'Download not found' };
  dl.paused = false;
  return { success: true };
});

// IPC: Cancel a download
ipcMain.handle('download-cancel', async (event, { downloadId }) => {
  const dl = activeDownloads.get(downloadId);
  if (!dl) return { success: false, error: 'Download not found' };
  // Destroy the stream and close the writer
  try {
    if (dl.stream && dl.stream.destroy) dl.stream.destroy();
    if (dl.writer) dl.writer.end();
  } catch {}
  // Delete the partial file
  try {
    if (dl.filePath && getFs().existsSync(dl.filePath)) getFs().unlinkSync(dl.filePath);
  } catch {}
  activeDownloads.delete(downloadId);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('download-done', { downloadId, state: 'cancelled' });
  }
  return { success: true };
});

// IPC: Cache a video to temp for smoother playback
ipcMain.handle('cache-video', async (event, { url, title, cacheId }) => {
  if (!url) return { success: false, error: 'No URL' };
  const isHls = url.includes('.m3u8') || (url.includes('.txt') && !url.includes('.srt') && !url.includes('.vtt'));
  if (isHls) return { success: false, error: 'HLS not cacheable as single file' };

  const cacheDir = getCacheDir();

  const urlExt = path.extname(url.split('?')[0].split('#')[0]) || '.mp4';
  const safeName = (title || 'video').replace(/[<>:"/\\|?*]/g, '_') + urlExt;
  const filePath = path.join(cacheDir, safeName);

  if (getFs().existsSync(filePath)) {
    try { getFs().unlinkSync(filePath); } catch {}
  }

  const id = cacheId || `cache_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const controller = new AbortController();
  const job = {
    cacheId: id, url, title: title || '', filename: safeName, filePath,
    controller, stream: null, received: 0, total: 0, percent: 0, cancelled: false
  };
  activeCaches.set(id, job);
  sendToRenderer('cache-started', { cacheId: id, title: job.title, filename: safeName });

  const finish = (result) => {
    activeCaches.delete(id);
    sendToRenderer('cache-done', { cacheId: id, ...result });
    return result;
  };

  try {
    const response = await getAxios()({
      url, responseType: 'stream', timeout: 120000, signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
    });

    job.total = parseInt(response.headers['content-length'] || '0', 10);
    job.received = 0;
    const writer = getFs().createWriteStream(filePath);
    job.stream = response.data;

    return await new Promise((resolve) => {
      const abort = (reason) => {
        try { response.data.destroy(); } catch {}
        try { writer.destroy(); } catch {}
        try { if (getFs().existsSync(filePath)) getFs().unlinkSync(filePath); } catch {}
        resolve(finish({ success: false, error: reason, cancelled: !!job.cancelled }));
      };

      response.data.on('data', (chunk) => {
        job.received += chunk.length;
        job.percent = job.total ? Math.round((job.received / job.total) * 100) : 0;
        sendToRenderer('cache-progress', {
          cacheId: id, received: job.received, total: job.total, percent: job.percent
        });
      });
      response.data.pipe(writer);
      writer.on('finish', () => resolve(finish({ success: true, path: filePath })));
      writer.on('error', (err) => abort(err.message || 'Write error'));
      response.data.on('error', (err) => abort(err.message || 'Stream error'));
      controller.signal.addEventListener('abort', () => abort('Cache cancelled'));
    });
  } catch (e) {
    try { if (getFs().existsSync(filePath)) getFs().unlinkSync(filePath); } catch {}
    return finish({
      success: false,
      error: job.cancelled ? 'Cache cancelled' : (e.message || 'Cache failed')
    });
  }
});

// IPC: List files currently sitting in the cache directory
ipcMain.handle('list-cache', async () => {
  try {
    const cacheDir = getCacheDir();
    const items = getFs().readdirSync(cacheDir)
      .filter(name => !name.startsWith('.'))
      .map(name => {
        const full = path.join(cacheDir, name);
        const stat = getFs().statSync(full, { throwIfNoEntry: false });
        if (!stat || !stat.isFile()) return null;
        return { name, path: full, size: stat.size, modified: stat.mtimeMs };
      })
      .filter(Boolean)
      .sort((a, b) => b.modified - a.modified);
    return { success: true, items };
  } catch (e) {
    return { success: false, error: e.message, items: [] };
  }
});

// IPC: List in-flight cache jobs so the UI can restore progress after a reload
ipcMain.handle('list-active-caches', async () => {
  const caches = [];
  for (const job of activeCaches.values()) {
    caches.push({
      cacheId: job.cacheId, title: job.title, filename: job.filename,
      received: job.received, total: job.total, percent: job.percent
    });
  }
  return { success: true, caches };
});

// IPC: Cancel an in-flight cache job
ipcMain.handle('cancel-cache', async (event, { cacheId }) => {
  const job = activeCaches.get(cacheId);
  if (!job) return { success: false, error: 'No such cache job' };
  job.cancelled = true;
  try { job.controller.abort(); } catch {}
  return { success: true };
});

// IPC: Copy a cached file into Downloads/Void Streamer so it persists
ipcMain.handle('save-cache', async (event, { cachePath }) => {
  try {
    if (!cachePath || typeof cachePath !== 'string') return { success: false, error: 'Invalid path' };
    // Security: only allow saving files that live in the cache directory
    const cacheDir = getCacheDir();
    if (path.dirname(path.resolve(cachePath)) !== cacheDir) {
      return { success: false, error: 'File is not in the cache directory' };
    }
    if (!getFs().existsSync(cachePath)) return { success: false, error: 'Cached file no longer exists' };

    const downloadsDir = path.join(app.getPath('downloads'), 'Void Streamer');
    if (!getFs().existsSync(downloadsDir)) getFs().mkdirSync(downloadsDir, { recursive: true });

    const filename = path.basename(cachePath);
    let dest = path.join(downloadsDir, filename);
    let n = 1;
    while (getFs().existsSync(dest)) {
      const ext = path.extname(filename);
      dest = path.join(downloadsDir, `${path.basename(filename, ext)} (${n++})${ext}`);
    }
    getFs().copyFileSync(cachePath, dest);
    return { success: true, path: dest, filename: path.basename(dest) };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// IPC: Delete a cached file
ipcMain.handle('delete-cache', async (event, { cachePath }) => {
  try {
    if (!cachePath || typeof cachePath !== 'string') return { success: false, error: 'Invalid path' };
    // Security: only allow deleting files that live in the cache directory
    const cacheDir = getCacheDir();
    if (path.dirname(path.resolve(cachePath)) !== cacheDir) {
      return { success: false, error: 'File is not in the cache directory' };
    }
    if (getFs().existsSync(cachePath)) getFs().unlinkSync(cachePath);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// IPC: Read a text file from the app's data directory (config/state files)
ipcMain.handle('read-file', async (event, { filePath }) => {
  try {
    if (!filePath || typeof filePath !== 'string') return { success: false, error: 'Invalid path' };
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(app.getPath('userData') + path.sep)) {
      return { success: false, error: 'Path outside app data directory' };
    }
    return { success: true, data: getFs().readFileSync(resolved, 'utf8') };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// IPC: Write a text file into the app's data directory
ipcMain.handle('write-file', async (event, { filePath, data }) => {
  try {
    if (!filePath || typeof filePath !== 'string') return { success: false, error: 'Invalid path' };
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(app.getPath('userData') + path.sep)) {
      return { success: false, error: 'Path outside app data directory' };
    }
    getFs().mkdirSync(path.dirname(resolved), { recursive: true });
    getFs().writeFileSync(resolved, data ?? '', 'utf8');
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});


// IPC: Scrape KawaiiAnime video URL from watch page
ipcMain.handle('scrape-kawaii-anime-video', async (event, { url }) => {
  return new Promise((resolve) => {
    let resolved = false;

    const win = new BrowserWindow({
      width: 1280,
      height: 800,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    });

    const cleanup = () => { if (!win.isDestroyed()) win.destroy(); };
    const tryResolve = (result) => {
      if (resolved) return false;
      resolved = true;
      cleanup();
      resolve(result);
      return true;
    };

    const timeout = setTimeout(() => {
      tryResolve({ success: false, error: 'Timed out waiting for KawaiiAnime video' });
    }, 30000);

    // Intercept network requests for video URLs
    win.webContents.session.webRequest.onBeforeRequest(
      { urls: ['*://*/*'] },
      (details, callback) => {
        const reqUrl = details.url;
        if (
          (reqUrl.includes('.mp4') || reqUrl.includes('.m3u8') || reqUrl.includes('video.kawaii-anime.com')) &&
          !reqUrl.includes('.js') && !reqUrl.includes('.css')
        ) {
          if (tryResolve({ success: true, streamUrl: reqUrl })) {
            clearTimeout(timeout);
          }
        }
        callback({ cancel: false });
      }
    );

    win.webContents.on('did-finish-load', async () => {
      await new Promise(r => setTimeout(r, 5000));
      if (resolved) return;

      try {
        const result = await win.webContents.executeJavaScript(`
          (function() {
            const video = document.querySelector('video');
            if (video) {
              if (video.src && video.src.startsWith('http')) return video.src;
              const source = video.querySelector('source');
              if (source && source.src && source.src.startsWith('http')) return source.src;
            }
            return null;
          })()
        `);
        if (result) {
          tryResolve({ success: true, streamUrl: result });
          clearTimeout(timeout);
        }
      } catch (e) {}

      if (!resolved) {
        await new Promise(r => setTimeout(r, 5000));
        if (resolved) return;
        tryResolve({ success: false, error: 'No video URL found on KawaiiAnime watch page' });
      }
      clearTimeout(timeout);
    });

    win.webContents.on('did-fail-load', (e, code, desc) => {
      tryResolve({ success: false, error: `Page failed to load: ${desc}` });
      clearTimeout(timeout);
    });

    win.webContents.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    win.loadURL(url);
  });
});

// ─── Anime Source Video Extraction (luna-stream.me, animex.one, anilight.live) ──────

ipcMain.handle('scrape-anime-source-video', async (event, { url, lang }) => {
  lang = lang || 'sub';
  let targetUrl = url;
  const lower = url.toLowerCase();
  if (lower.includes('anilight.live')) {
    targetUrl = url.replace(/lang=\w+/i, `lang=${lang}`);
  } else if (lower.includes('luna-stream.me') || lower.includes('animex.one') || lower.includes('anikototv.to') || lower.includes('kawaii-anime.com/watch')) {
    const sep = url.includes('?') ? '&' : '?';
    targetUrl = url + sep + `lang=${lang}`;
  }

  return new Promise((resolve) => {
    let resolved = false;

    const win = new BrowserWindow({
      width: 1280, height: 800, show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false }
    });

    const cleanup = () => { if (!win.isDestroyed()) win.destroy(); };
    const tryResolve = (result) => {
      if (resolved) return false;
      resolved = true;
      // Capture the page origin BEFORE destroying the window.
      let pageOrigin = '';
      try { pageOrigin = new URL(win.getURL() || url).origin; } catch {}
      cleanup();
      // Same treatment as embed providers: anime CDNs often lack CORS or
      // reject headerless requests, so proxy the stream with the page origin.
      if (result && result.success && result.streamUrl && /^https?:\/\//.test(result.streamUrl) &&
          !result.streamUrl.startsWith('http://127.0.0.1') && !result.streamUrl.startsWith('http://localhost')) {
        const origin = pageOrigin || 'https://vidfast.vc';
        result.streamUrl = `${getLocalProxyBase()}/hls?u=${encodeURIComponent(result.streamUrl)}&o=${encodeURIComponent(origin)}`;
      }
      resolve(result);
      return true;
    };

    const timeout = setTimeout(() => {
      tryResolve({ success: false, error: 'Timed out waiting for anime source video' });
    }, 45000);

    // Extract video URL from the page
    function extractVideoUrl() {
      if (win.isDestroyed()) return Promise.resolve(null);
      return win.webContents.executeJavaScript(`
        (function() {
          const v = document.querySelector('video[src]');
          const src = v ? (v.src || v.getAttribute('src') || '') : '';
          if (src.startsWith('http') && !src.includes('youtube') && !src.includes('ytimg')) return src;

          const source = document.querySelector('video source[src]');
          if (source && source.src && source.src.startsWith('http')) return source.src;

          // Player embeds (plyr.animex.one, etc.): follow the iframe.
          const frames = document.querySelectorAll('iframe[src]');
          for (const f of frames) {
            if (f.src && f.src.startsWith('http') && !/googleads|gstatic|doubleclick|facebook|twitter|share|adsby/i.test(f.src)) {
              return f.src;
            }
          }

          return null;
        })()
      `).catch(() => null);
    }

    // Poll for video URL every 500ms
    function pollForVideo(maxMs) {
      const interval = 500;
      let elapsed = 0;
      return new Promise((res) => {
        const check = async () => {
          if (resolved || elapsed >= maxMs) { res(null); return; }
          const url = await extractVideoUrl();
          if (url && !resolved) { res(url); return; }
          elapsed += interval;
          setTimeout(check, interval);
        };
        check();
      });
    }

    // Intercept network requests for video streams
    win.webContents.session.webRequest.onBeforeRequest(
      { urls: ['*://*/*'] },
      (details, callback) => {
        const reqUrl = details.url;
        const rl = reqUrl.toLowerCase();
        if (
          (rl.includes('.m3u8') || rl.includes('.mp4') || rl.includes('.ts') ||
           rl.endsWith('.txt') || rl.includes('.txt?') ||
           rl.includes('master.m3u8') || rl.includes('index.m3u8')) &&
          !rl.includes('.js') && !rl.includes('.css') && !rl.includes('.png') &&
          !rl.includes('.jpg') && !rl.includes('.woff') && !rl.includes('.svg') &&
          !rl.includes('youtube') && !rl.includes('ytimg')
        ) {
          if (tryResolve({ success: true, streamUrl: reqUrl })) {
            clearTimeout(timeout);
          }
        }
        callback({ cancel: false });
      }
    );

    let playClicked = false;

    // Embed URLs must be loaded directly (SPAs inject players into iframes);
    // anything else is treated as a playable stream URL.
    const isStreamLike = (u) => /\.m3u8|\.mp4|\.ts(?:\?|$)/i.test(u || '');

    win.webContents.on('did-finish-load', async () => {
      // Poll for video instead of blind waits
      const earlyUrl = await pollForVideo(8000);
      if (earlyUrl && !resolved) {
        if (isStreamLike(earlyUrl)) {
          clearTimeout(timeout); tryResolve({ success: true, streamUrl: earlyUrl }); return;
        } else {
          // Embed player: let the fresh did-finish-load run its own
          // play-click phases on the player page.
          playClicked = false;
          try { win.loadURL(earlyUrl); } catch {}
          return;
        }
      }

      if (resolved) return;

      // Click server/language buttons
      try {
        const subKeywords = ['sub', 'subtitles', 'subtitled', 'subbed'];
        const dubKeywords = ['dub', 'dubbed', 'english', 'english dub'];
        const keywords = lang === 'dub' ? dubKeywords : subKeywords;

        await win.webContents.executeJavaScript(`
          (function() {
            const keywords = ${JSON.stringify(keywords)};
            const servers = document.querySelectorAll('[class*="server"], [data-server], button[class*="option"], [class*="lang"], [class*="language"], [class*="tab"]');
            for (const btn of servers) {
              const text = btn.textContent.toLowerCase().trim();
              if (keywords.some(k => text === k || text.includes(k))) { btn.click(); return true; }
            }
            if (${lang === 'sub'}) {
              for (const btn of servers) {
                const text = btn.textContent.toLowerCase();
                if (text.includes('near') || text.includes('light') || text.includes('alpha')) { btn.click(); return true; }
              }
            }
            return false;
          })()
        `);
        await new Promise(r => setTimeout(r, 2000));
        if (resolved) return;
      } catch (e) {}

      // Click play buttons
      if (!playClicked) {
        playClicked = true;
        try {
          await win.webContents.executeJavaScript(`
            (function() {
              const btns = document.querySelectorAll('button[class*="play"], .play-btn, [class*="play"], a[class*="play"], [class*="watch"]');
              for (const btn of btns) {
                if (btn.offsetParent !== null && btn.offsetWidth > 0) { btn.click(); return true; }
              }
              return false;
            })()
          `);
        } catch (e) {}

        // Poll after play click
        const afterClickUrl = await pollForVideo(8000);
        if (afterClickUrl && !resolved) {
          if (isStreamLike(afterClickUrl)) {
            clearTimeout(timeout); tryResolve({ success: true, streamUrl: afterClickUrl });
          } else {
            playClicked = false;
            try { win.loadURL(afterClickUrl); } catch {}
            return;
          }
        }
      }

      // Final poll attempt
      if (!resolved) {
        const finalUrl = await pollForVideo(10000);
        if (finalUrl && !resolved) {
          if (isStreamLike(finalUrl)) {
            clearTimeout(timeout); tryResolve({ success: true, streamUrl: finalUrl });
          } else {
            playClicked = false;
            try { win.loadURL(finalUrl); } catch {}
            return;
          }
        }
      }

      if (!resolved) {
        clearTimeout(timeout);
        tryResolve({ success: false, error: 'No video URL found on anime source page' });
      }
    });

    win.webContents.on('did-fail-load', (e, code, desc) => {
      // ERR_ABORTED (-3) happens when we supersede a load with loadURL();
      // it is an expected part of iframe following, not a real failure.
      if (code !== -3) {
        tryResolve({ success: false, error: `Page failed to load: ${desc}` });
        clearTimeout(timeout);
      }
    });

    win.webContents.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    win.loadURL(targetUrl);
  });
});



// ─── System FFmpeg (preferred over FFmpeg WASM) ─────────────────────────────
// FFmpeg WASM remuxing reads the whole file into renderer memory over IPC,
// which OOM-crashes the app on larger downloads. When a system ffmpeg is
// available it handles rewrapping with a small memory footprint instead;
// the WASM path below remains as a fallback.
let _systemFfmpeg = null; // null = unchecked, false = missing, true = available
function hasSystemFfmpeg() {
  if (_systemFfmpeg !== null) return _systemFfmpeg;
  try {
    const { spawnSync } = require('child_process');
    const r = spawnSync('ffmpeg', ['-version'], { timeout: 5000, stdio: 'ignore' });
    _systemFfmpeg = (r.status === 0);
  } catch { _systemFfmpeg = false; }
  return _systemFfmpeg;
}

function runSystemFfmpeg(args, timeoutMs = 600000) {
  return new Promise((resolve) => {
    try {
      const { spawn } = require('child_process');
      const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      const killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
      child.stderr.on('data', (c) => { stderr += c; if (stderr.length > 20000) stderr = stderr.slice(-20000); });
      child.on('error', () => { clearTimeout(killTimer); resolve({ success: false, error: stderr.slice(-500) }); });
      child.on('close', (code) => {
        clearTimeout(killTimer);
        resolve({ success: code === 0, error: code === 0 ? '' : stderr.slice(-500) });
      });
    } catch (e) { resolve({ success: false, error: e.message }); }
  });
}

// Mux separate fragmented-MP4 video/audio tracks into a single MP4.
// Falls back to keeping the video track if FFmpeg WASM fails.
async function muxFmp4Renderer(videoPath, audioPath, mp4Path, downloadId) {
  const send = (type, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(type, { downloadId, ...data });
  };
  send('download-progress', { percent: 0, received: 0, total: 0, speed: 0, paused: false, status: 'Muxing audio and video...' });

  // Preferred: system ffmpeg (streaming, low memory).
  if (hasSystemFfmpeg()) {
    const res = await runSystemFfmpeg([
      '-y', '-fflags', '+genpts',
      '-i', videoPath,
      '-i', audioPath,
      '-map', '0:v:0', '-map', '1:a:0',
      '-c', 'copy', '-movflags', '+faststart',
      mp4Path
    ]);
    if (res.success) {
      try { if (getFs().existsSync(videoPath)) getFs().unlinkSync(videoPath); } catch {}
      try { if (getFs().existsSync(audioPath)) getFs().unlinkSync(audioPath); } catch {}
      return { success: true, path: mp4Path, muxed: true };
    }
    console.error('[mux] system ffmpeg failed, trying FFmpeg WASM:', res.error);
  }

  let muxed = false;
  try {
    const result = await mainWindow.webContents.executeJavaScript(`
      (async () => {
        try {
          const v = await window.api.readFile(${JSON.stringify(videoPath)});
          if (!v.success) return { success: false, error: v.error };
          const a = await window.api.readFile(${JSON.stringify(audioPath)});
          if (!a.success) return { success: false, error: a.error };
          const blob = await muxAvToMp4(new Uint8Array(v.data), new Uint8Array(a.data));
          const arr = await blob.arrayBuffer();
          const res = await window.api.writeFile(${JSON.stringify(mp4Path)}, Array.from(new Uint8Array(arr)));
          return res.success ? { success: true } : { success: false, error: res.error };
        } catch (e) {
          return { success: false, error: e.message };
        }
      })()
    `);
    muxed = !!(result && result.success);
  } catch (e) {
    muxed = false;
  }

  try { if (getFs().existsSync(audioPath)) getFs().unlinkSync(audioPath); } catch {}

  if (!muxed) {
    // Degraded fallback: deliver the video-only track rather than failing.
    try {
      if (getFs().existsSync(mp4Path)) getFs().unlinkSync(mp4Path);
      getFs().renameSync(videoPath, mp4Path);
    } catch {}
  } else {
    try { if (getFs().existsSync(videoPath)) getFs().unlinkSync(videoPath); } catch {}
  }
  return { success: true, path: mp4Path, muxed };
}

// Remux .ts to .mp4 using FFmpeg WASM in renderer (shared by IPC and download handler)
async function remuxTsToMp4Renderer(tsPath, mp4Path, downloadId) {
  const send = (type, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(type, { downloadId, ...data });
  };
  send('download-progress', { percent: 0, received: 0, total: 0, speed: 0, paused: false, status: 'Remuxing to MP4...' });

  // Preferred: system ffmpeg (streaming, low memory).
  if (hasSystemFfmpeg()) {
    const res = await runSystemFfmpeg([
      '-y', '-fflags', '+igndts',
      '-i', tsPath,
      '-c', 'copy', '-bsf:a', 'aac_adtstoasc',
      mp4Path
    ]);
    if (res.success) {
      try { if (getFs().existsSync(tsPath)) getFs().unlinkSync(tsPath); } catch {}
      return { success: true, path: mp4Path };
    }
    console.error('[remux] system ffmpeg failed, trying FFmpeg WASM:', res.error);
  }

  try {
    const result = await mainWindow.webContents.executeJavaScript(`
      (async () => {
        try {
          const readRes = await window.api.readFile(${JSON.stringify(tsPath)});
          if (!readRes.success) return { success: false, error: readRes.error };
          const tsData = new Uint8Array(readRes.data);
          const blob = await remuxTsToMp4(tsData);
          const arr = await blob.arrayBuffer();
          const writeRes = await window.api.writeFile(${JSON.stringify(mp4Path)}, Array.from(new Uint8Array(arr)));
          if (!writeRes.success) return { success: false, error: writeRes.error };
          return { success: true, path: ${JSON.stringify(mp4Path)} };
        } catch (e) {
          return { success: false, error: e.message };
        }
      })()
    `);
    if (result.success) {
      try { getFs().unlinkSync(tsPath); } catch {}
      return { success: true, path: mp4Path };
    }
  } catch {}
  // Fallback: just rename
  try { getFs().renameSync(tsPath, mp4Path); } catch {}
  return { success: true, path: mp4Path };
}

// IPC: Remux .ts to .mp4 using FFmpeg WASM in renderer
ipcMain.handle('remux-ts-to-mp4', async (event, { tsPath, mp4Path, downloadId }) => {
  return remuxTsToMp4Renderer(tsPath, mp4Path, downloadId);
});
