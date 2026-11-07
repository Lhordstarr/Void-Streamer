// Void Streamer (Web Edition) — window.api bridge
// Replaces the Electron preload bridge with fetch() calls to the Workers
// backend. Loaded BEFORE renderer.js. The renderer logic is unchanged.
(function () {
  'use strict';

  const listeners = {};
  let dlSeq = 0;
  const activeCaches = new Map(); // cacheId -> {controller}

  function on(event, cb) {
    (listeners[event] = listeners[event] || []).push(cb);
  }
  function emit(event, data) {
    (listeners[event] || []).forEach(cb => { try { cb(data); } catch {} });
  }
  function off(event, cb) {
    if (!cb) { listeners[event] = []; return; }
    listeners[event] = (listeners[event] || []).filter(f => f !== cb);
  }

  async function json(path, opts) {
    const r = await fetch(path, opts);
    const text = await r.text();
    try { return JSON.parse(text); } catch { return { success: false, error: text.slice(0, 200) || ('HTTP ' + r.status) }; }
  }

  async function resolvePseudo(url) {
    const pseudo = new URL(url);
    const tmdb = pseudo.searchParams.get('tmdb') || '';
    const imdb = pseudo.searchParams.get('imdb') || '';
    const type = pseudo.searchParams.get('type') === 'tv' ? 'tv' : 'movie';
    const season = parseInt(pseudo.searchParams.get('season') || '1', 10);
    const episode = parseInt(pseudo.searchParams.get('episode') || '1', 10);
    const title = pseudo.searchParams.get('title') || '';
    const year = pseudo.searchParams.get('year') || '';
    if (pseudo.protocol === 'peestream:') {
      const qs = new URLSearchParams({ tmdb, type, title, year, imdb });
      if (type === 'tv') { qs.set('season', season); qs.set('episode', episode); }
      return json('/api/resolve/peestream?' + qs.toString());
    }
    if (pseudo.protocol === 'abibli:') {
      const qs = new URLSearchParams({ title, year, type });
      if (type === 'tv') { qs.set('season', season); qs.set('episode', episode); }
      return json('/api/resolve/abibli?' + qs.toString());
    }
    return { success: false, error: 'Not a unified stream link' };
  }

  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 8000);
  }

  // ── Downloads (streams, remuxed in-browser with FFmpeg WASM) ──
  async function streamConcat(url, downloadId) {
    const resp = await fetch('/api/download?url=' + encodeURIComponent(url));
    if (!resp.ok || !resp.body) throw new Error('Download failed (HTTP ' + resp.status + ')');
    const total = parseInt(resp.headers.get('content-length') || '0', 10);
    const reader = resp.body.getReader();
    const chunks = [];
    let received = 0;
    const startedAt = Date.now();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      const elapsed = (Date.now() - startedAt) / 1000;
      const speed = elapsed > 0 ? Math.round(received / elapsed) : 0;
      const percent = total > 0 ? Math.min(99, Math.round((received / total) * 100)) : 0;
      emit('download-progress', { downloadId, percent, received, total, speed });
    }
    const buf = new Uint8Array(received);
    let off = 0;
    for (const c of chunks) { buf.set(c, off); off += c.length; }
    return buf;
  }

  async function startDownload(url, title, quality, image) {
    if (!url) return { success: false, error: 'No URL' };
    const id = 'dl_' + (++dlSeq);
    const safe = String(title || 'video').replace(/[<>:"/\\|?*]/g, '_');
    const ext = /\.m3u8/i.test(url) ? '.mp4' : '.mp4';
    const filename = `${safe} - ${quality || 'Auto'}${ext}`;
    emit('download-started', { downloadId: id, filename, url, image: image || '' });
    try {
      const data = await streamConcat(url, id);
      let blob = new Blob([data.buffer], { type: 'video/mp4' });
      // TS needs remuxing; fragmented MP4 is already playable
      const isFmp4 = data.length > 12 && data.slice(4, 8).toString() === 'ftyp';
      if (!isFmp4 && typeof window.remuxTsToMp4 === 'function') {
        try { blob = await window.remuxTsToMp4(data instanceof Uint8Array ? data : new Uint8Array(data)); } catch {}
      }
      blob = new Blob([blob.buffer], { type: 'video/mp4' });
      saveBlob(blob, filename);
      emit('download-done', { downloadId: id, state: 'completed', path: filename });
      return { success: true, path: filename };
    } catch (e) {
      emit('download-done', { downloadId: id, state: 'interrupted' });
      return { success: false, error: e.message };
    }
  }

  window.api = {
    scrapeUrl: (url, config) => json('/api/scrape', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'list', url, config: config || {} })
    }),
    scrapeDetail: (url, config) => json('/api/scrape', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'detail', url, config: config || {} })
    }),
    scrapeMoviboxStream: () => Promise.resolve({ success: false, error: 'Embed scraping not available in the web edition (needs a browser)' }),
    scrapeSpa: () => Promise.resolve({ success: false, error: 'Not available in the web edition' }),
    scrapeKawaiiVideo: () => Promise.resolve({ success: false, error: 'Not available in the web edition' }),
    scrapeAnimeSourceVideo: () => Promise.resolve({ success: false, error: 'Not available in the web edition' }),
    resolveAbibliStream: (url) => resolvePseudo(url),
    resolvePeestreamStream: (url) => resolvePseudo(url),
    fetchSubtitles: (opts) => {
      const qs = new URLSearchParams({
        tmdb: opts.tmdb || '', imdb: opts.imdb || '', type: opts.type || 'movie',
        season: opts.season || 1, episode: opts.episode || 1
      });
      return json('/api/subs?' + qs.toString());
    },
    fetchSubtitleText: (url) => json('/api/subtext?url=' + encodeURIComponent(url)),
    startDownload,
    pauseDownload: () => Promise.resolve({ success: false, error: 'Pause not supported in the web edition' }),
    resumeDownload: () => Promise.resolve({ success: false, error: 'Not supported in the web edition' }),
    cancelDownload: () => Promise.resolve({ success: true }),
    analyzeStream: (url, quick) => json('/api/analyze?quick=' + (quick ? '1' : '0') + '&url=' + encodeURIComponent(url)),
    readFile: () => Promise.resolve({ success: false, error: 'Not supported in the web edition' }),
    writeFile: () => Promise.resolve({ success: false, error: 'Not supported in the web edition' }),
    remuxTsToMp4: (tsPath) => Promise.resolve({ success: false, error: 'Path remux not available in the web edition' }),
    onDownloadStarted: (cb) => on('download-started', cb),
    onDownloadProgress: (cb) => on('download-progress', cb),
    onDownloadDone: (cb) => on('download-done', cb),
    cacheVideo: () => Promise.resolve({ success: false, error: 'Not available in the web edition' }),
    listCache: () => Promise.resolve([]),
    saveCache: () => Promise.resolve({ success: false }),
    deleteCache: () => Promise.resolve({ success: true }),
    listActiveCaches: () => Promise.resolve([]),
    cancelCache: () => Promise.resolve({ success: true }),
    onCacheStarted: (cb) => on('cache-started', cb),
    onCacheProgress: (cb) => on('cache-progress', cb),
    onCacheDone: (cb) => on('cache-done', cb),
    removeDownloadListeners: () => { listeners['download-started'] = []; listeners['download-progress'] = []; listeners['download-done'] = []; },
    openExternal: (url) => { if (url && /^https?:/.test(url)) window.open(url, '_blank', 'noopener'); },
    playLocalFile: () => Promise.resolve({ success: false, error: 'Local file playback not available in the web edition' }),
    pickSubtitleFile: async () => {
      try {
        const [handle] = await window.showOpenFilePicker({
          types: [{ description: 'WebVTT subtitles', accept: { 'text/vtt': ['.vtt'] } }]
        });
        const file = await handle.getFile();
        const text = await file.text();
        return { success: true, name: file.name, text };
      } catch (e) { return { success: false, error: e && e.name === 'AbortError' ? 'Cancelled' : (e && e.message) }; }
    },
    getProviderHealth: () => json('/api/health'),
    onProviderHealth: (cb) => on('provider-health', cb)
  };

  // Lightweight heartbeat for progress/health — mostly a stub in web mode.
  setInterval(() => emit('keepalive'), 5 * 60 * 1000);
})();
