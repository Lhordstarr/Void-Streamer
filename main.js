const { app, BrowserWindow, ipcMain, shell, session, dialog } = require('electron');
const path = require('path');
const http = require('http');

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

// Tiny local HTTP server to serve downloaded media files with proper MIME types
function startLocalMediaServer() {
  const downloadsDir = path.join(app.getPath('downloads'), 'Void Streamer');
  const server = http.createServer((req, res) => {
    const filePath = path.join(downloadsDir, decodeURIComponent(req.url.slice(1)));
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
    minWidth: 900,
    minHeight: 600,
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

  // Preconnect to critical domains
  const preconnectDomains = ['https://api.themoviedb.org', 'https://streamex.sh', 'https://image.tmdb.org'];
  preconnectDomains.forEach(url => {
    ses.resolveHost(url).catch(() => {});
  });

  createWindow();
  startLocalMediaServer();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

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

ipcMain.handle('play-local-file', async (event, filePath) => {
  if (filePath && typeof filePath === 'string' && localMediaPort > 0) {
    const downloadsDir = path.join(app.getPath('downloads'), 'Void Streamer');
    // Compute relative path from downloads dir, then build local server URL
    const relPath = path.relative(downloadsDir, filePath);
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
      cleanup();
      resolve(result);
      return true;
    };

    const timeout = setTimeout(() => {
      tryResolve({ success: false, error: 'Timed out waiting for stream URL' });
    }, 20000);

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

  async function resolvePlaylist(url) {
    const resp = await getAxios().get(url, { headers: BROWSER_HEADERS, timeout: 15000 });
    const body = typeof resp.data === 'string' ? resp.data : resp.data.toString();
    // Follow variant playlist to highest bandwidth
    if (body.includes('#EXT-X-STREAM-INF:')) {
      const lines = body.split('\n');
      let bestUrl = '', bestBw = 0;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('#EXT-X-STREAM-INF:')) {
          const bw = parseInt(lines[i].match(/BANDWIDTH=(\d+)/i)?.[1] || '0', 10);
          const next = lines[i + 1]?.trim();
          if (next && !next.startsWith('#')) {
            const resolved = resolveUrl(url, next);
            if (bw > bestBw) { bestBw = bw; bestUrl = resolved; }
          }
        }
      }
      if (bestUrl) return resolvePlaylist(bestUrl);
    }
    return { playlist: body, baseUrl: url };
  }

  const { playlist } = await resolvePlaylist(playlistUrl);
  const lines = playlist.split('\n');
  const segments = [];

  for (const line of lines) {
    const t = line.trim();
    if (t && !t.startsWith('#') && /\.(ts|m4s|mp4|m4v|aac)(\?|$)/i.test(t)) {
      segments.push(resolveUrl(playlistUrl, t));
    }
  }
  // Fallback: pick lines that look like URL paths (contain / or start with http)
  if (!segments.length) {
    for (const line of lines) {
      const t = line.trim();
      if (t && !t.startsWith('#') && !t.startsWith('<') && (t.includes('/') || t.startsWith('http'))) {
        segments.push(resolveUrl(playlistUrl, t));
      }
    }
  }

  if (!segments.length) throw new Error('No video segments found in HLS playlist');

  let bytesReceived = 0;
  let bytesTotal = 0;
  const startedAt = Date.now();
  let lastSpeedSample = 0;

  try {
    const head = await getAxios().head(segments[0], { headers: BROWSER_HEADERS, timeout: 8000 });
    const segSize = parseInt(head.headers['content-length'] || '0', 10);
    if (segSize > 0) bytesTotal = segSize * segments.length;
  } catch {}

  const writer = getFs().createWriteStream(outputPath);

  for (let i = 0; i < segments.length; i++) {
    try {
      const segResp = await getAxios()({
        url: segments[i],
        responseType: 'stream',
        timeout: 60000,
        headers: BROWSER_HEADERS
      });
      const segLen = parseInt(segResp.headers['content-length'] || '0', 10);
      if (!bytesTotal && segLen > 0) bytesTotal = segLen * segments.length;

      await new Promise((resolve, reject) => {
        segResp.data.on('data', (chunk) => {
          bytesReceived += chunk.length;
          const now = Date.now();
          if (now - lastSpeedSample >= 400) {
            const elapsed = (now - startedAt) / 1000;
            const speed = elapsed > 0 ? Math.round(bytesReceived / elapsed) : 0;
            lastSpeedSample = now;
            const pct = bytesTotal > 0
              ? Math.min(99, Math.round((bytesReceived / bytesTotal) * 100))
              : Math.min(99, Math.round((i / segments.length) * 99));
            send('download-progress', { percent: pct, received: bytesReceived, total: bytesTotal || (segLen * segments.length), speed });
          }
        });
        segResp.data.pipe(writer, { end: false });
        segResp.data.on('end', resolve);
        segResp.data.on('error', reject);
      });
    } catch (segErr) {
    }
  }

  writer.end();
  return outputPath;
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
              let label = resolution || (bw > 5000000 ? '4K' : bw > 3000000 ? '1080p' : bw > 1500000 ? '720p' : bw > 700000 ? '480p' : bw > 300000 ? '360p' : '240p');
              variants.push({ url: resolved, bandwidth: bw, resolution, label });
            }
          }
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
      // Save HLS as .ts first, then remux to .mp4 via FFmpeg WASM
      const tsPath = filePath.replace(/\.mp4$/, '.ts');
      await downloadHls(url, tsPath, downloadId, image);
      // Remux .ts to .mp4
      const mp4Path = filePath;
      await remuxTsToMp4Renderer(tsPath, mp4Path, downloadId);
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
ipcMain.handle('cache-video', async (event, { url, title }) => {
  if (!url) return { success: false, error: 'No URL' };
  const isHls = url.includes('.m3u8') || (url.includes('.txt') && !url.includes('.srt') && !url.includes('.vtt'));
  if (isHls) return { success: false, error: 'HLS not cacheable as single file' };

  const cacheDir = path.join(app.getPath('userData'), 'cache', 'videos');
  if (!getFs().existsSync(cacheDir)) getFs().mkdirSync(cacheDir, { recursive: true });

  const urlExt = path.extname(url.split('?')[0].split('#')[0]) || '.mp4';
  const safeName = (title || 'video').replace(/[<>:"/\\|?*]/g, '_') + urlExt;
  const filePath = path.join(cacheDir, safeName);

  if (getFs().existsSync(filePath)) {
    try { getFs().unlinkSync(filePath); } catch {}
  }

  try {
    const response = await getAxios()({
      url, responseType: 'stream', timeout: 120000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
    });

    const total = parseInt(response.headers['content-length'] || '0', 10);
    let received = 0;
    const writer = getFs().createWriteStream(filePath);

    return new Promise((resolve, reject) => {
      response.data.on('data', (chunk) => {
        received += chunk.length;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('cache-progress', {
            received, total, percent: total ? Math.round((received / total) * 100) : 0
          });
        }
      });
      response.data.pipe(writer);
      writer.on('finish', () => resolve({ success: true, path: filePath }));
      writer.on('error', (err) => {
        try { getFs().unlinkSync(filePath); } catch {}
        reject(err);
      });
      response.data.on('error', () => {
        try { getFs().unlinkSync(filePath); } catch {}
        reject(new Error('Stream error'));
      });
    });
  } catch (e) {
    try { getFs().unlinkSync(filePath); } catch {}
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
      resolved = true; cleanup(); resolve(result);
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

          const iframe = document.querySelector('iframe[src*="embed"], iframe[src*="player"], iframe[src*="vid"]');
          if (iframe && iframe.src && iframe.src.startsWith('http')) return iframe.src;

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

    win.webContents.on('did-finish-load', async () => {
      // Poll for video instead of blind waits
      const earlyUrl = await pollForVideo(5000);
      if (earlyUrl && !resolved) {
        if (earlyUrl.includes('iframe') || earlyUrl.includes('embed') || earlyUrl.includes('vid')) {
          try { win.loadURL(earlyUrl); } catch {}
        } else {
          clearTimeout(timeout); tryResolve({ success: true, streamUrl: earlyUrl }); return;
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
          if (afterClickUrl.includes('iframe') || afterClickUrl.includes('embed') || afterClickUrl.includes('vid')) {
            try { win.loadURL(afterClickUrl); } catch {}
            // Poll again after navigating to embed
            const embedUrl = await pollForVideo(10000);
            if (embedUrl && !resolved && !embedUrl.includes('iframe')) {
              clearTimeout(timeout); tryResolve({ success: true, streamUrl: embedUrl });
            }
          } else {
            clearTimeout(timeout); tryResolve({ success: true, streamUrl: afterClickUrl });
          }
        }
      }

      // Final poll attempt
      if (!resolved) {
        const finalUrl = await pollForVideo(10000);
        if (finalUrl && !resolved && !finalUrl.includes('iframe')) {
          clearTimeout(timeout); tryResolve({ success: true, streamUrl: finalUrl });
        }
      }

      if (!resolved) {
        clearTimeout(timeout);
        tryResolve({ success: false, error: 'No video URL found on anime source page' });
      }
    });

    win.webContents.on('did-fail-load', (e, code, desc) => {
      tryResolve({ success: false, error: `Page failed to load: ${desc}` });
      clearTimeout(timeout);
    });

    win.webContents.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    win.loadURL(targetUrl);
  });
});



// Remux .ts to .mp4 using FFmpeg WASM in renderer (shared by IPC and download handler)
async function remuxTsToMp4Renderer(tsPath, mp4Path, downloadId) {
  const send = (type, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(type, { downloadId, ...data });
  };
  send('download-progress', { percent: 0, received: 0, total: 0, speed: 0, paused: false, status: 'Remuxing to MP4...' });
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
