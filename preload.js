const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  scrapeUrl:          (url, config) => ipcRenderer.invoke('scrape-url',            { url, config }),
  scrapeDetail:       (url, config) => ipcRenderer.invoke('scrape-detail',         { url, config }),
  scrapeMoviboxStream:(url)         => ipcRenderer.invoke('scrape-movibox-stream',  { url }),
  resolveAbibliStream:(url)         => ipcRenderer.invoke('resolve-abibli-stream', { url }),
  resolvePeestreamStream:(url)      => ipcRenderer.invoke('resolve-peestream-stream', { url }),
  scrapeSpa:          (url, jsCode) => ipcRenderer.invoke('scrape-spa',            { url, jsCode }),
  scrapeKawaiiVideo:  (url)         => ipcRenderer.invoke('scrape-kawaii-anime-video', { url }),
  scrapeAnimeSourceVideo: (url, lang) => ipcRenderer.invoke('scrape-anime-source-video', { url, lang }),
  startDownload:      (url, title, quality, image) => ipcRenderer.invoke('start-download', { url, title, quality, image }),
  pauseDownload:      (downloadId) => ipcRenderer.invoke('download-pause', { downloadId }),
  resumeDownload:     (downloadId) => ipcRenderer.invoke('download-resume', { downloadId }),
  cancelDownload:     (downloadId) => ipcRenderer.invoke('download-cancel', { downloadId }),
  analyzeStream:      (url, quick)   => ipcRenderer.invoke('analyze-stream', { url, quick }),
  readFile:           (filePath)    => ipcRenderer.invoke('read-file', { filePath }),
  writeFile:          (filePath, data) => ipcRenderer.invoke('write-file', { filePath, data }),
  readFileBinary:     (filePath)    => ipcRenderer.invoke('read-file-binary', { filePath }),
  writeFileBinary:    (filePath, data) => ipcRenderer.invoke('write-file-binary', { filePath, data }),
  remuxTsToMp4:       (tsPath, mp4Path, downloadId) => ipcRenderer.invoke('remux-ts-to-mp4', { tsPath, mp4Path, downloadId }),
  onDownloadStarted:  (cb) => ipcRenderer.on('download-started',  (e, d) => cb(d)),
  onDownloadProgress: (cb) => ipcRenderer.on('download-progress', (e, d) => cb(d)),
  onDownloadDone:     (cb) => ipcRenderer.on('download-done',     (e, d) => cb(d)),
  cacheVideo:          (url, title, cacheId) => ipcRenderer.invoke('cache-video', { url, title, cacheId }),
  listCache:           ()             => ipcRenderer.invoke('list-cache'),
  saveCache:           (cachePath)    => ipcRenderer.invoke('save-cache', { cachePath }),
  deleteCache:         (cachePath)    => ipcRenderer.invoke('delete-cache', { cachePath }),
  listActiveCaches:    ()             => ipcRenderer.invoke('list-active-caches'),
  cancelCache:         (cacheId)      => ipcRenderer.invoke('cancel-cache', { cacheId }),
  onCacheStarted:      (cb)           => { const fn = (e, d) => cb(d); ipcRenderer.on('cache-started', fn); return () => ipcRenderer.removeListener('cache-started', fn); },
  onCacheProgress:     (cb)           => { const fn = (e, d) => cb(d); ipcRenderer.on('cache-progress', fn); return () => ipcRenderer.removeListener('cache-progress', fn); },
  onCacheDone:         (cb)           => { const fn = (e, d) => cb(d); ipcRenderer.on('cache-done', fn); return () => ipcRenderer.removeListener('cache-done', fn); },
  removeDownloadListeners: () => {
    ipcRenderer.removeAllListeners('download-started');
    ipcRenderer.removeAllListeners('download-progress');
    ipcRenderer.removeAllListeners('download-done');
  },
  openExternal:       (url)         => ipcRenderer.send('open-external', url),
  playLocalFile:      (path)        => ipcRenderer.invoke('play-local-file', path),
  pickSubtitleFile:   ()            => ipcRenderer.invoke('pick-subtitle-file'),
  fetchSubtitles:     (opts)        => ipcRenderer.invoke('fetch-subtitles', opts),
  fetchSubtitleText:  (url)         => ipcRenderer.invoke('fetch-subtitle-text', { url }),
  getProviderHealth:  ()            => ipcRenderer.invoke('get-provider-health'),
  onProviderHealth:   (cb)          => { const fn = (e, d) => cb(d); ipcRenderer.on('provider-health', fn); return () => ipcRenderer.removeListener('provider-health', fn); }
});

