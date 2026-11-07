const axios = require('axios');
const cheerio = require('cheerio');
const { URL } = require('url');

// Shared headers to bypass Cloudflare fingerprint mismatches
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0'
};

// ─── TMDB / StreameX constants ────────────────────────────────────────────
const TMDB_API_KEY = 'd9fa6f599339d23ed1f9c0070105b8dc';
const TMDB_BASE   = 'https://api.themoviedb.org/3';
const TMDB_IMG    = 'https://image.tmdb.org/t/p/w342';
const TMDB_IMG_HD = 'https://image.tmdb.org/t/p/w1280';

const TMDB_GENRES = {
  28:'Action',12:'Adventure',16:'Animation',35:'Comedy',80:'Crime',
  99:'Documentary',18:'Drama',10751:'Family',14:'Fantasy',36:'History',
  27:'Horror',10402:'Music',9648:'Mystery',10749:'Romance',878:'Sci-Fi',
  10770:'TV Movie',53:'Thriller',10752:'War',37:'Western',
  10759:'Action & Adventure',10762:'Kids',10763:'News',10764:'Reality',
  10765:'Sci-Fi & Fantasy',10766:'Soap',10767:'Talk',10768:'War & Politics'
};

const TMDB_LANG = 'en-US';

// TMDB-based source domains (listing/detail handled via TMDB API)
const TMDB_SOURCE_DOMAINS = ['streamex.sh', 'moviepire.org', 'www.rivestream.app', '7reels.cc', 'abibli.com', 'peestream.in'];

// Anime source domains (use AniList API for metadata)
const ANIME_SOURCE_DOMAINS = {
  'luna-stream.me': { listingUrl: 'https://luna-stream.me', watchPattern: 'https://luna-stream.me/anime/info/{id}' },
  'animex.one': { listingUrl: 'https://animex.one', watchPattern: 'https://animex.one/watch/{id}' },
  'anikototv.to': { listingUrl: 'https://anikototv.to/home', watchPattern: 'https://anikototv.to/watch/{slug}' }
};

function isAnimeSourceUrl(url) {
  return Object.keys(ANIME_SOURCE_DOMAINS).some(d => url.includes(d));
}

function isAnimeSourceListing(url) {
  return Object.keys(ANIME_SOURCE_DOMAINS).some(d => url.includes(d) && !url.includes('/watch/'));
}

function getTmdbSourceBase(url) {
  for (const d of TMDB_SOURCE_DOMAINS) {
    if (url.includes(d)) return `https://${d}`;
  }
  return 'https://streamex.sh';
}

// Stream embed sources (shared across all TMDB-based sources)
const STREAMSX_SOURCES = [
  { name: 'StreameX', embed: 'https://play.xpass.top/e' },
  { name: 'VidCore', embed: 'https://vidcore.net' },
  { name: 'VidFast', embed: 'https://vidfast.vc' },
];

// Source-specific embedded server providers (used when source domain matches)
const SOURCE_EMBED_PROVIDERS = {
  '7reels.cc': [
    { name: 'VidCore', embed: 'https://vidcore.net' },
    { name: 'VidFast', embed: 'https://vidfast.vc' },
  ],
};

// Abibli streams are resolved at play time from its search API rather than
// from a conventional embed URL. This pseudo-URL carries everything needed.
function buildAbibliStreamUrl(mediaType, title, year, tmdbId, season, episode) {
  const params = new URLSearchParams({
    type: mediaType,
    title: title || '',
    year: year || '',
    tmdb: tmdbId || ''
  });
  if (mediaType === 'tv') {
    params.set('season', season || 1);
    params.set('episode', episode || 1);
  }
  return `abibli://stream?${params.toString()}`;
}

// PeeStream streams are resolved at play time from its streamdata API.
// The API keys everything by TMDB id, so the pseudo-URL only needs the id.
function buildPeestreamStreamUrl(mediaType, tmdbId, season, episode, title, year, imdbId) {
  const params = new URLSearchParams({
    type: mediaType,
    tmdb: tmdbId || '',
    title: title || '',
    year: year || '',
    imdb: imdbId || ''
  });
  if (mediaType === 'tv') {
    params.set('season', season || 1);
    params.set('episode', episode || 1);
  }
  return `peestream://stream?${params.toString()}`;
}

function buildStreamexStreamUrl(embed, mediaType, tmdbId, season, episode) {
  if (mediaType === 'movie') return `${embed}/movie/${tmdbId}`;
  const s = season || 1;
  const e = episode || 1;
  return `${embed}/tv/${tmdbId}/${s}/${e}`;
}

function buildSourceWatchUrl(baseUrl, domain, mediaType, tmdbId, season, episode) {
  const name = domain.replace(/^www\./, '');
  if (name === 'rivestream.app') {
    if (mediaType === 'movie') return `${baseUrl}/watch?type=movie&id=${tmdbId}`;
    return `${baseUrl}/watch?type=tv&id=${tmdbId}&season=${season || 1}&episode=${episode || 1}`;
  }
  if (name === '7reels.cc') {
    if (mediaType === 'movie') return `${baseUrl}/${mediaType}/${tmdbId}/watch`;
    return `${baseUrl}/${mediaType}/${tmdbId}/watch?season=${season || 1}&ep=${episode || 1}`;
  }
  if (name === 'youflex.top') {
    if (mediaType === 'movie') return `${baseUrl}/watch?type=movie&id=${tmdbId}`;
    return `${baseUrl}/watch?type=tv&id=${tmdbId}${season ? `&season=${season}&episode=${episode || 1}` : ''}`;
  }
  if (name === 'screenscape.me') {
    if (mediaType === 'movie') return `${baseUrl}/embed?tmdb=${tmdbId}&type=movie`;
    return `${baseUrl}/embed?tmdb=${tmdbId}&type=tv&s=${season || 1}&e=${episode || 1}`;
  }
  return null;
}

/**
 * Call a TMDB API endpoint and return the parsed JSON.
 */
async function tmdbFetch(path, params = {}) {
  const qs = new URLSearchParams({ api_key: TMDB_API_KEY, language: TMDB_LANG, ...params });
  const url = `${TMDB_BASE}${path}?${qs.toString()}`;
  const res = await axios.get(url, { headers: BROWSER_HEADERS, timeout: 12000 });
  return res.data;
}

/**
 * Call the StreameX API proxy in place of TMDB.
 * Falls back to direct TMDB if StreameX is unreachable.
 */
async function streamexFetch(path, params = {}) {
  const qs = new URLSearchParams(params);
  const url = `https://streamex.sh/api/tmdb${path}?${qs.toString()}`;
  try {
    const res = await axios.get(url, { headers: BROWSER_HEADERS, timeout: 12000 });
    return res.data;
  } catch (e) {
    // Fallback to direct TMDB
    return tmdbFetch(path, params);
  }
}

/**
 * Scrape TMDB listing — generalized for any section (movie, tv).
 * Used by TMDB-based sources (StreameX, Moviepire, LunaStream).
 */
async function scrapeTMDBListing(searchQuery, section = 'movie', baseUrl = 'https://streamex.sh') {
  let results = [];

  if (searchQuery) {
    const data = await streamexFetch('/search/multi', { query: searchQuery, page: 1 });
    results = (data.results || []).filter(item => {
      if (section === 'movie') return item.media_type === 'movie';
      if (section === 'tv')   return item.media_type === 'tv';
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
        streamexFetch('/discover/tv',   { with_genres: 16, sort_by: 'popularity.desc', with_original_language: 'ja', page: 1 })
      ]);
      results = [
        ...(movieData.results || []).map(item => ({ ...item, media_type: 'movie' })),
        ...(tvData.results   || []).map(item => ({ ...item, media_type: 'tv' }))
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
    const image = posterPath ? `${TMDB_IMG}${posterPath}` : '';
    const backdrop = backdropPath ? `${TMDB_IMG_HD}${backdropPath}` : '';
    const quality = item.vote_average ? `★ ${item.vote_average.toFixed(1)}` : 'HD';
    const rating = item.vote_average ? item.vote_average.toFixed(1) : '';
    const description = item.overview || '';
    const isTv = type === 'tv';
    const seasons = isTv ? item.number_of_seasons : undefined;
    const genres = (item.genre_ids || []).slice(0, 3).map(id => TMDB_GENRES[id] || '').filter(Boolean);

    return {
      title,
      link: `${baseUrl}/${type}/${tmdbId}`,
      image,
      backdrop,
      year,
      quality,
      rating,
      description,
      tmdbId,
      mediaType: type,
      isTv,
      seasons,
      genres
    };
  });
}

/**
 * Scrape StreameX detail page — returns stream embed sources
 * for movies (multiple source options) or TV (episode picker).
 */
async function scrapeStreamexDetail(detailUrl) {
  const baseUrl = getTmdbSourceBase(detailUrl);
  const domainPattern = TMDB_SOURCE_DOMAINS.map(d => d.replace(/\./g, '\\.')).join('|');
  const match = detailUrl.match(new RegExp(`\\/(${domainPattern})\\/(movie|tv)\\/(\\d+)`, 'i'));
  if (!match) return { success: false, error: 'Invalid TMDB source URL', downloads: [], poster: '' };

  const mediaType = match[2];
  const tmdbId = match[3];

  const domain = match[1];
  const baseDomain = domain.replace(/^www\./, '');

  // Parallelize all three TMDB API calls
  const [dataRes, creditsRes, similarRes] = await Promise.all([
    streamexFetch(`/${mediaType}/${tmdbId}`).catch(() => ({})),
    streamexFetch(`/${mediaType}/${tmdbId}/credits`).catch(() => ({})),
    streamexFetch(`/${mediaType}/${tmdbId}/similar`).catch(() => ({})),
  ]);

  const data = dataRes;
  let poster = '', title = '', description = '', backdrop = '', rating = '', seasons = 0;
  let genres = [], cast = [], related = [];
  title = data.title || data.name || '';
  const year = (data.release_date || data.first_air_date || '').split('-')[0] || '';
  const imdbId = data.imdb_id || (data.external_ids && data.external_ids.imdb_id) || '';
  description = data.overview || '';
  if (data.poster_path) poster = `${TMDB_IMG}${data.poster_path}`;
  if (data.backdrop_path) backdrop = `${TMDB_IMG_HD}${data.backdrop_path}`;
  rating = data.vote_average ? data.vote_average.toFixed(1) : '';
  seasons = data.number_of_seasons || 0;
  genres = (data.genres || []).slice(0, 3).map(g => g.name).filter(Boolean);

  cast = (creditsRes.cast || []).slice(0, 12).map(c => ({
    name: c.name || '',
    image: c.profile_path ? `${TMDB_IMG}${c.profile_path}` : ''
  }));

  related = (similarRes.results || []).slice(0, 12).map(r => ({
    title: r.title || r.name || '',
    image: r.poster_path ? `${TMDB_IMG}${r.poster_path}` : '',
    year: (r.release_date || r.first_air_date || '').split('-')[0] || '',
    rating: r.vote_average ? r.vote_average.toFixed(1) : '',
    tmdbId: r.id || '',
    mediaType: mediaType,
    link: ''
  }));

  // Per-source watch URL: each source resolves to ITS OWN stream so the
  // quality ladder genuinely differs when you switch sources. For the named
  // catalogs, VidFast embeds carry the widest ladder (up to 4K/1080p).
  function srcUrl(mType, tmdbId, s, e) {
    if (baseDomain === 'abibli.com') {
      return buildAbibliStreamUrl(mType, title, year, tmdbId, s, e);
    }
    if (baseDomain === 'peestream.in') {
      return buildPeestreamStreamUrl(mType, tmdbId, s, e, title, year, imdbId);
    }
    return buildSourceWatchUrl(baseUrl, domain, mType, tmdbId, s, e)
      || buildStreamexStreamUrl('https://vidcore.net', mType, tmdbId, s, e);
  }

  if (mediaType === 'movie') {
    const downloads = [];

    // Source-specific primary stream option
    downloads.push({
      quality: `${baseDomain} · Stream`,
      size: 'Play on source site',
      seeds: '',
      torrentUrl: '',
      sourceUrl: srcUrl('movie', tmdbId),
      isMoviboxStream: true,
    });

    // Source-specific embed providers (e.g., 7reels.cc's known embed servers)
    const sourceEmbeds = SOURCE_EMBED_PROVIDERS[baseDomain] || [];
    sourceEmbeds.forEach(src => {
      if (src.embed) {
        downloads.push({
          quality: src.name,
          size: 'Stream',
          seeds: '',
          torrentUrl: '',
          sourceUrl: buildStreamexStreamUrl(src.embed, 'movie', tmdbId),
          isMoviboxStream: true,
        });
      }
    });

    // Generic embed providers as fallback
    STREAMSX_SOURCES.forEach(src => {
      downloads.push({
        quality: src.name,
        size: 'Stream',
        seeds: '',
        torrentUrl: '',
        sourceUrl: buildStreamexStreamUrl(src.embed, 'movie', tmdbId),
        isMoviboxStream: true,
      });
    });


    return { success: true, downloads, poster, title, description, isMovie: true, backdrop, rating, genres, cast, related };
  }

  // TV: fetch seasons/episodes grouped by season for GaiaFlix layout
  const episodesData = {};
  try {
    const tvData = await streamexFetch(`/tv/${tmdbId}`);
    const seasonsData = (tvData.seasons || []).filter(s => s.season_number > 0 && s.season_number != null).slice(0, 10);
    seasons = tvData.number_of_seasons || seasons;

    // Fetch all seasons in parallel
    const seasonResults = await Promise.all(
      seasonsData.map(s => streamexFetch(`/tv/${tmdbId}/season/${s.season_number}`).catch(() => ({ episodes: [] })))
    );

    seasonsData.forEach((s, i) => {
      const seasonKey = `Season ${s.season_number}`;
      episodesData[seasonKey] = (seasonResults[i].episodes || []).slice(0, 24).map(ep => ({
        number: ep.episode_number,
        title: ep.name || `Episode ${ep.episode_number}`,
        link: srcUrl('tv', tmdbId, s.season_number, ep.episode_number),
        thumbnail: ep.still_path ? `${TMDB_IMG}${ep.still_path}` : '',
      }));
    });
  } catch (e) {}

  return { success: true, poster, title, description, isMovie: false, backdrop, rating, genres, seasons, cast, related, episodesData };
}



/** Clean up whitespace from text */
function cleanText(str) {
  if (!str) return '';
  return str.replace(/\s+/g, ' ').trim();
}

/** Resolve a (possibly relative) URL against a base URL */
function resolveUrl(relativeUrl, base) {
  if (!relativeUrl) return '';
  if (relativeUrl.startsWith('magnet:')) return relativeUrl;
  try {
    return new URL(relativeUrl, base).href;
  } catch {
    return relativeUrl;
  }
}

/** Parse Nuxt 3 __NUXT_DATA__ payload for movie-box.co listing pages */
function parseMovieBoxCoListing(html) {
  const $ = cheerio.load(html);
  const nuxtText = $('#__NUXT_DATA__').text();
  if (!nuxtText) return [];

  let data;
  try { data = JSON.parse(nuxtText); } catch (e) {
    console.error('[scraper] Error parsing __NUXT_DATA__:', e.message);
    return [];
  }

  const resolve = (val) => {
    if (typeof val === 'number' && val >= 0 && val < data.length) return data[val];
    return val;
  };

  const results = [];
  const seen = new Set();

  data.forEach((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return;
    if (!('detailPath' in item) || !('title' in item)) return;

    const detailPath = resolve(item.detailPath);
    const title = resolve(item.title);
    if (!detailPath || typeof detailPath !== 'string') return;
    if (!title || typeof title !== 'string' || title.length < 1) return;
    if (seen.has(detailPath)) return;
    seen.add(detailPath);

    // Poster image
    let imageUrl = '';
    const coverKey = 'cover' in item ? 'cover' : ('image' in item ? 'image' : null);
    if (coverKey) {
      const coverObj = resolve(item[coverKey]);
      if (coverObj && typeof coverObj === 'object') {
        const urlVal = resolve(coverObj.url);
        if (typeof urlVal === 'string') imageUrl = urlVal;
      }
    }

    const genre     = resolve(item.genre);
    const releaseDate = resolve(item.releaseDate);
    const imdb      = resolve(item.imdbRatingValue);
    const corner    = resolve(item.corner);
    const subjectType = resolve(item.subjectType); // 1=movie 2=series

    const year    = releaseDate && typeof releaseDate === 'string' ? releaseDate.split('-')[0] : '';
    const quality = imdb ? `★ ${imdb}` : (corner && typeof corner === 'string' ? corner : 'HD');
    const description = genre && typeof genre === 'string' ? `Genre: ${genre}` : '';

    results.push({
      title,
      link: `https://movie-box.co/detail/${detailPath}`,
      image: imageUrl,
      year,
      quality,
      description,
      genre: typeof genre === 'string' ? genre : '',
      subjectType,
    });
  });

  return results;
}

/** Parse CinemaCity RSS feed for listing data */
function parseCinemaCityRSS(xml) {
  const results = [];
  const $ = cheerio.load(xml, { xmlMode: true });
  $('item').each((i, item) => {
    if (i >= 40) return false;

    const el = $(item);
    const title = el.find('title').text().trim();
    const link = el.find('link').text().trim() || el.find('guid').text().trim();
    const desc = el.find('description').text().trim();
    const genre = el.find('genre').text().trim();
    const year = el.find('year').text().trim();
    const quality = el.find('quality').text().trim();
    const lang = el.find('audioLanguage').text().trim();

    if (!title || !link) return;

    results.push({
      title,
      link,
      image: '',
      year,
      quality,
      description: desc,
      genre,
      language: lang
    });
  });
  return results;
}

/** Scrape a movie-box.co detail page — extracts direct video URL + episodes */
async function scrapeMovieBoxCoDetail(detailUrl) {
  const response = await axios.get(detailUrl, { headers: BROWSER_HEADERS, timeout: 20000 });
  const $ = cheerio.load(response.data);

  let videoUrl = '', poster = '', title = '', description = '';
  let episodes = [], isMovie = true, subjectType = 1, sourceName = '', uploadBy = '';
  let subjectId = '', seasons = [], resolutionsList = [];

  // 1. JSON-LD (fastest path — always present in SSR HTML)
  $('script[type="application/ld+json"]').each((i, el) => {
    try {
      const ld = JSON.parse($(el).text());
      if (ld['@type'] === 'VideoObject') {
        if (ld.contentUrl && !videoUrl) videoUrl = ld.contentUrl;
        if (ld.name && !title)          title       = ld.name;
        if (ld.description && !description) description = ld.description;
        if (ld.thumbnailUrl && ld.thumbnailUrl[0] && !poster) poster = ld.thumbnailUrl[0];
      }
    } catch (e) {}
  });

  // 2. Nuxt data for metadata + seasons + video fallback
  const nuxtText = $('#__NUXT_DATA__').text();
  if (nuxtText) {
    try {
      const data = JSON.parse(nuxtText);

      const resolve = (val) => {
        if (typeof val === 'number' && val >= 0 && val < data.length) return data[val];
        return val;
      };

      const deepResolve = (val, depth = 0) => {
        if (depth > 5) return val;
        if (typeof val === 'number' && val >= 0 && val < data.length) {
          return deepResolve(data[val], depth + 1);
        }
        return val;
      };

      const extractUrl = (obj) => {
        if (!obj || typeof obj !== 'object') return '';
        const urlVal = resolve(obj.url);
        if (typeof urlVal === 'string') {
          if (urlVal.startsWith('http://') || urlVal.startsWith('https://')) return urlVal;
          if (urlVal.startsWith('//')) return 'https:' + urlVal;
        }
        return '';
      };

      // Find subject + resource objects in Nuxt data
      data.forEach((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return;

        // Extract subject metadata
        if ('subjectType' in item && 'title' in item) {
          const st = resolve(item.subjectType);
          if (st === 1 || st === 2) {
            subjectType = st;
            if (!title) title = resolve(item.title) || title;
            if (!description) description = resolve(item.description) || description;
            subjectId = resolve(item.subjectId) || '';
            if (!poster && 'cover' in item) {
              const co = resolve(item.cover);
              if (co && typeof co === 'object') {
                const u = resolve(co.url);
                if (typeof u === 'string' && u.startsWith('http')) poster = u;
              }
            }
            // Capture seasons/resolutions from the resource
            // (not on the subject itself — we find seasons separately below)
          }
        }

        // Extract seasons + source from the resource object
        if ('seasons' in item && 'source' in item) {
          sourceName = resolve(item.source) || '';
          uploadBy = resolve(item.uploadBy) || '';
          const seasonsRaw = resolve(item.seasons);
          if (Array.isArray(seasonsRaw)) {
            isMovie = false;
            seasonsRaw.forEach((sIdx) => {
              const season = resolve(sIdx);
              if (!season || typeof season !== 'object') return;
              const seNum = resolve(season.se) || 1;
              const maxEp = resolve(season.maxEp) || 0;
              const resArr = resolve(season.resolutions);
              if (Array.isArray(resArr)) {
                const seasonResolutions = [];
                resArr.forEach((rIdx) => {
                  const res = resolve(rIdx);
                  if (res && typeof res === 'object') {
                    const epNum = resolve(res.epNum) || 1;
                    const resolution = resolve(res.resolution) || 0;
                    seasonResolutions.push({ season: seNum, epNum, resolution, maxEp });
                  }
                });
                seasons.push({ season: seNum, maxEp, resolutions: seasonResolutions });
                resolutionsList.push(...seasonResolutions);
              }
            });
          }
        }

        // Extract videoAddress fallback (trailer or standalone)
        if (!videoUrl && 'videoAddress' in item) {
          const va = deepResolve(item.videoAddress);
          if (va && typeof va === 'object') {
            const u = extractUrl(va);
            if (u) videoUrl = u;
          }
        }
      });

      // Poster fallback from any cover object
      if (!poster) {
        data.forEach((item) => {
          if (!item || typeof item !== 'object' || poster) return;
          if ('cover' in item) {
            const co = resolve(item.cover);
            if (co && typeof co === 'object') {
              const u = resolve(co.url);
              if (typeof u === 'string' && u.startsWith('http')) poster = u;
            }
          }
        });
      }

      // Final URL fallback: scan strings for video extensions
      if (!videoUrl) {
        data.forEach((item) => {
          if (videoUrl) return;
          if (typeof item === 'string' && (item.startsWith('http://') || item.startsWith('https://'))) {
            if (item.includes('.mp4') || item.includes('.m3u8') || item.includes('.ts')) {
              videoUrl = item;
            }
          }
        });
      }
    } catch (e) {
      console.error('[scraper] Error parsing movie-box.co Nuxt detail:', e.message);
    }
  }

  // Build downloads array
  const downloads = [];

  if (!isMovie && seasons.length > 0) {
    // Series: build episode list from resolution data
    // Actual video URLs are loaded dynamically — we pass source metadata for scanning
    const seriesEpisodes = [];
    resolutionsList.forEach((r) => {
      const key = `${r.season}-${r.epNum}`;
      // Deduplicate by keeping highest resolution
      const existing = seriesEpisodes.find(e => e.season === r.season && e.epNum === r.epNum);
      if (!existing || r.resolution > existing.resolution) {
        if (!existing) {
          seriesEpisodes.push({
            season: r.season,
            epNum: r.epNum,
            url: '',
            resolution: r.resolution,
            maxEp: r.maxEp
          });
        } else {
          existing.resolution = r.resolution;
        }
      }
    });
    seriesEpisodes.sort((a, b) => a.season - b.season || a.epNum - b.epNum);
    episodes = seriesEpisodes;

    downloads.push({
      quality: `${episodes.length} Episodes Available`,
      size: 'Click an episode to scan for stream',
      seeds: '',
      torrentUrl: '',
      isSeriesEpisodes: true,
      episodes,
      sourceUrl: detailUrl,
      sourceName,
      uploadBy,
      subjectId,
    });
  } else if (videoUrl) {
    // Movie with direct video URL
    downloads.push({
      quality: '▶ Watch Now',
      size: 'Direct Stream',
      seeds: '',
      torrentUrl: '',
      isDirectStream: true,
    });
  }

  return { success: true, downloads, poster, title, description, isMovie, episodes };
}


/**
 * Scrape a listing page (latest movies or search results).
 * Returns an array of movie objects.
 */
async function scrape(urlTemplate, config) {
  try {
    const {
      searchQuery,
      containerSelector,
      titleSelector,
      linkSelector,
      descSelector,
      imageSelector,
      yearSelector,
      qualitySelector,
      baseUrl
    } = config;

    // Build target URL
    let targetUrl = urlTemplate;
    if (searchQuery) {
      targetUrl = urlTemplate.replace(/{query}/g, encodeURIComponent(searchQuery));
    }

    // ── TMDB-based sources (StreameX, Moviepire, LunaStream) ────
    if (TMDB_SOURCE_DOMAINS.some(d => targetUrl.includes(d))) {
      const section = config.section || 'movie';
      const baseUrl = getTmdbSourceBase(targetUrl);
      const items = await scrapeTMDBListing(searchQuery, section, baseUrl);
      return { success: true, items, url: targetUrl };
    }

    // ── KawaiiAnime source ─────────────────────────────────────
    if (isKawaiiAnimeUrl(targetUrl)) {
      const section = config.section || 'anime';
      const items = await scrapeKawaiiAnimeListing(searchQuery, section);
      return { success: true, items, url: targetUrl };
    }

    // ── Generic Anime Sources (luna-stream.me, animex.one, anilight.live) ──────
    if (isAnimeSourceUrl(targetUrl)) {
      const domain = Object.keys(ANIME_SOURCE_DOMAINS).find(d => targetUrl.includes(d));

      // All anime source pages are SPAs — always use AniList API for listings
      if (searchQuery || isAnimeSourceListing(targetUrl)) {
        const items = await scrapeKawaiiAnimeListing(searchQuery || '', 'anime');
        return {
          success: true,
          items: items.map(it => {
            const anilistId = it.link.match(/\/anime\/(\d+)/)?.[1] || '';
            const d = domain || 'luna-stream.me';
            const dConfig = ANIME_SOURCE_DOMAINS[d];
            const link = anilistId && dConfig
              ? dConfig.watchPattern.replace('{id}', anilistId).replace('{slug}', anilistId)
              : it.link.replace('kawaii-anime.com', d);
            return { ...it, link, sourceName: d || 'anime' };
          }),
          url: targetUrl
        };
      }
    }

    const response = await axios.get(targetUrl, {
      headers: BROWSER_HEADERS,
      timeout: 15000
    });

    if (targetUrl.includes('movie-box.co')) {
      const items = parseMovieBoxCoListing(response.data);
      return { success: true, items, url: targetUrl };
    }

    if (targetUrl.includes('cinemacity.cc')) {
      if (targetUrl.endsWith('.xml')) {
        const items = parseCinemaCityRSS(response.data);
        return { success: true, items, url: targetUrl };
      }
      // For non-RSS cinemacity pages, fall through to standard parsing
    }

    const $ = cheerio.load(response.data);
    const results = [];
    const effectiveBase = baseUrl || targetUrl;

    $(containerSelector).each((index, element) => {
      if (index >= 40) return false; // limit results

      const el = $(element);

      // --- Title ---
      let title = '';
      if (titleSelector) {
        title = cleanText(el.find(titleSelector).first().text());
      }
      if (!title) title = cleanText(el.find('h1,h2,h3,h4,a').first().text());
      if (!title) return; // skip items with no title

      // --- Detail page link ---
      let link = '';
      if (linkSelector) {
        link = el.find(linkSelector).first().attr('href') || '';
      }
      if (!link) link = el.find('a').first().attr('href') || '';
      link = resolveUrl(link, effectiveBase);

      // --- Image / Poster ---
      let image = '';
      if (imageSelector) {
        const imgEl = el.find(imageSelector).first();
        const srcAttr = imgEl.attr('src') || '';
        image = (srcAttr.startsWith('data:') ? '' : srcAttr) || imgEl.attr('data-src') || imgEl.attr('data-original') || imgEl.attr('src') || '';
      }
      if (!image) {
        const anyImg = el.find('img').first();
        const srcAttr = anyImg.attr('src') || '';
        image = (srcAttr.startsWith('data:') ? '' : srcAttr) || anyImg.attr('data-src') || anyImg.attr('data-original') || anyImg.attr('src') || '';
      }
      image = resolveUrl(image, effectiveBase);

      // --- Year ---
      let year = '';
      if (yearSelector) {
        year = cleanText(el.find(yearSelector).first().text());
      }

      // --- Quality ---
      let quality = '';
      if (qualitySelector) {
        quality = cleanText(el.find(qualitySelector).first().text());
      }

      // --- Description/snippet ---
      let description = '';
      if (descSelector) {
        description = cleanText(el.find(descSelector).first().text());
      }

      results.push({ title, link, image, year, quality, description });
    });

    return { success: true, items: results, url: targetUrl };

  } catch (error) {
    console.error('[scraper] Error scraping listing page:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Scrape a movie detail page to extract download options.
 * Returns an array of download options: { quality, size, seeds, torrentUrl }
 */
async function getPoster(detailUrl, config) {
  try {
    const { baseUrl } = config;
    const response = await axios.get(detailUrl, { headers: BROWSER_HEADERS, timeout: 15000 });
    const $ = cheerio.load(response.data);
    // Find image element likely to be poster: class contains 'coverpic' or 'poster' or large image
    const img = $('img').filter((i, el) => {
      const cls = $(el).attr('class') || '';
      const src = $(el).attr('src') || $(el).attr('data-src') || '';
      if (!src) return false;
      const lowerCls = cls.toLowerCase();
      return lowerCls.includes('coverpic') || lowerCls.includes('poster') || lowerCls.includes('cover') || src.includes('cover') || src.includes('poster');
    }).first();
    const src = img.attr('src') || img.attr('data-src') || '';
    return resolveUrl(src, baseUrl || detailUrl);
  } catch (e) {
    console.error('getPoster error', e.message);
    return '';
  }
}

  // Extend scrapeDetail to also return poster
  async function scrapeDetail(detailUrl, config) {
    try {
      const {
        downloadContainerSelector,
        downloadQualitySelector,
        downloadSizeSelector,
        downloadSeedsSelector,
        downloadTorrentSelector,
        baseUrl
      } = config;

      const effectiveBase = baseUrl || detailUrl;

      // ── TMDB-based sources: return streaming embed sources / episode picker ────
      if (TMDB_SOURCE_DOMAINS.some(d => detailUrl.includes(d))) {
        return await scrapeStreamexDetail(detailUrl);
      }

      // ── KawaiiAnime: return episodes and stream options ──────────────────
      if (isKawaiiAnimeUrl(detailUrl)) {
        return await scrapeKawaiiAnimeDetail(detailUrl);
      }

      // ── Generic Anime Sources: return episodes and stream options ──────────
      if (isAnimeSourceUrl(detailUrl)) {
        return await scrapeAnimeSourceDetail(detailUrl);
      }

      // ── movie-box.co: skip axios body parsing, use dedicated detail scraper
      if (detailUrl.includes('movie-box.co')) {
        return await scrapeMovieBoxCoDetail(detailUrl);
      }

      const response = await axios.get(detailUrl, {

        headers: BROWSER_HEADERS,
        timeout: 15000
      });

      if (detailUrl.includes('cinemacity.cc')) {
        // CinemaCity has direct .mp4 links behind Cloudflare
        // Return a stream-scan entry resolved via hidden Electron window
        const downloads = [{
          quality: '🎬 Stream / Download',
          size: 'Click to check availability',
          seeds: '',
          torrentUrl: '',
          isMoviboxStream: true,
          sourceUrl: detailUrl
        }];
        let poster = '';
        try {
          const resp = await axios.get(detailUrl, { headers: BROWSER_HEADERS, timeout: 8000 });
          // Check if Cloudflare let us through — if so, parse poster
          const $c = cheerio.load(resp.data);
          const img = $c('img').filter((i, el) => {
            const cls = $c(el).attr('class') || '';
            return cls.includes('poster') || cls.includes('cover');
          }).first();
          poster = img.attr('src') || img.attr('data-src') || '';
          poster = resolveUrl(poster, detailUrl);
        } catch (e) {
          // Cloudflare blocked — poster will be missing, stream scan still works
        }
        return { success: true, downloads, poster };
      }

      if (detailUrl.includes('movibox.net')) {
        const cheerio = require('cheerio');
        const $ = cheerio.load(response.data);
        const nuxtDataText = $('#__NUXT_DATA__').text();
        const downloads = [];
        let poster = '';

        if (nuxtDataText) {
          try {
            const data = JSON.parse(nuxtDataText);
            const resolve = (val) => {
              if (typeof val === 'number' && val >= 0 && val < data.length) {
                return data[val];
              }
              return val;
            };

            // Extract poster image from Nuxt data
            data.forEach((item) => {
              if (item && typeof item === 'object' && 'cover' in item) {
                const coverObj = resolve(item.cover);
                if (coverObj && coverObj.url) {
                  poster = resolve(coverObj.url);
                }
              }
            });

            // Extract movie title for display
            let movieTitle = 'Stream Movie';
            data.forEach((item) => {
              if (item && typeof item === 'object' && 'title' in item) {
                const t = resolve(item.title);
                if (typeof t === 'string' && t.length > 2) movieTitle = t;
              }
            });

          } catch (e) {
            console.error('[scraper] Error parsing detail Nuxt data:', e.message);
          }
        }

        // Return a special stream-scan entry — the actual stream URL is
        // resolved at click-time via a hidden Electron BrowserWindow
        downloads.push({
          quality: '🎬 Stream Movie',
          size: 'Click to scan for stream',
          seeds: '',
          torrentUrl: '',
          isMoviboxStream: true,
          sourceUrl: detailUrl
        });

        return { success: true, downloads, poster };
      }

      const $ = cheerio.load(response.data);
      const downloads = [];

      if (downloadContainerSelector) {
        // Multiple quality options (e.g., YTS modal-torrent divs)
        $(downloadContainerSelector).each((i, el) => {
          const container = $(el);

          const quality = downloadQualitySelector
            ? cleanText(container.find(downloadQualitySelector).first().text())
            : `Option ${i + 1}`;

          const size = downloadSizeSelector
            ? cleanText(container.find(downloadSizeSelector).first().text())
            : '';

          const seeds = downloadSeedsSelector
            ? cleanText(container.find(downloadSeedsSelector).first().text())
            : '';

          let torrentUrl = '';
          if (downloadTorrentSelector) {
            const tEl = container.find(downloadTorrentSelector).first();
            torrentUrl = tEl.attr('href') || tEl.attr('data-link') || tEl.attr('data-url') || '';
            torrentUrl = resolveUrl(torrentUrl, effectiveBase);
          }

          if (torrentUrl) {
            downloads.push({ quality, size, seeds, torrentUrl });
          }
        });
      }

      // Fallback: look for any torrent links on the whole page
      if (downloads.length === 0) {
        // Torrent file links
        if (downloadTorrentSelector) {
          $(downloadTorrentSelector).each((i, el) => {
            if (i >= 5) return false;
            const torrentUrl = resolveUrl($(el).attr('href'), effectiveBase);
            if (torrentUrl) {
              downloads.push({ quality: `Download ${i + 1}`, size: '', seeds: '', torrentUrl });
            }
          });
        }
      }

      // Retrieve poster image
      const poster = await getPoster(detailUrl, { baseUrl: baseUrl });

      // Detect episode links for TV shows from any source
      const episodesData = {};
      const epRegex = /(?:s(?:eason)?[\s._-]*(\d+)[\s._-]*)?(?:e(?:p(?:isode)?)?[\s._-]*(\d+))/i;
      const seenEps = new Set();

      // Look for links that contain episode patterns
      $('a[href]').each((i, el) => {
        const href = $(el).attr('href') || '';
        const text = cleanText($(el).text()) || '';
        const combined = href + ' ' + text;
        const match = combined.match(epRegex);
        if (match) {
          const seasonNum = match[1] ? parseInt(match[1]) : 1;
          const epNum = match[2] ? parseInt(match[2]) : 0;
          if (epNum === 0) return;
          const epKey = `${seasonNum}-${epNum}`;
          if (seenEps.has(epKey)) return;
          seenEps.add(epKey);

          const seasonKey = `Season ${seasonNum}`;
          if (!episodesData[seasonKey]) episodesData[seasonKey] = [];
          episodesData[seasonKey].push({
            number: epNum,
            title: text.replace(/^episode\s*\d+\s*[-:]\s*/i, '') || `Episode ${epNum}`,
            link: resolveUrl(href, effectiveBase),
          });
        }
      });

      // Sort episodes within each season
      Object.keys(episodesData).forEach(key => {
        episodesData[key].sort((a, b) => a.number - b.number);
      });

      const hasEpisodes = Object.keys(episodesData).length > 0;

      return {
        success: true,
        downloads,
        poster,
        ...(hasEpisodes ? { episodesData, isTv: false } : {})
      };
    } catch (error) {
      console.error('[scraper] Error scraping detail page:', error.message);
      return { success: false, error: error.message, downloads: [], poster: '' };
    }
  }

  // ─── KawaiiAnime scraping functions ──────────────────────────────────────
  const KAWAII_ANIME_DOMAIN = 'kawaii-anime.com';

  function isKawaiiAnimeUrl(url) {
    return url.includes(KAWAII_ANIME_DOMAIN);
  }

  /**
   * Scrape kawaii-anime.com browse/latest page for anime listings.
   * Uses the AniList GraphQL API for metadata since the site is a Next.js SPA.
   */
  async function scrapeKawaiiAnimeListing(searchQuery, section = 'anime') {
    try {
      if (searchQuery) {
        // Use AniList search
        const query = `
          query ($search: String, $type: MediaType) {
            Page(page: 1, perPage: 40) {
              media(search: $search, type: $type, sort: SEARCH_MATCH) {
                id
                title { romaji english }
                coverImage { extraLarge large }
                format
                status
                episodes
                averageScore
                description(asHtml: false)
                startDate { year }
              }
            }
          }
        `;
        const variables = { search: searchQuery, type: 'ANIME' };
        const res = await axios.post('https://graphql.anilist.co', { query, variables }, { timeout: 10000 });
        const media = res.data?.data?.Page?.media || [];
        return media.map(item => ({
          title: item.title.english || item.title.romaji || 'Unknown',
          link: `https://${KAWAII_ANIME_DOMAIN}/anime/${item.id}`,
          image: item.coverImage?.extraLarge || item.coverImage?.large || '',
          year: item.startDate?.year?.toString() || '',
          quality: item.averageScore ? `★ ${(item.averageScore / 10).toFixed(1)}` : 'Anime',
          description: (item.description || '').replace(/<[^>]*>/g, '').substring(0, 300),
          _kawaiiId: item.id,
          mediaType: 'tv',
          sourceName: 'KawaiiAnime'
        }));
      }

      // For browse/latest, use AniList popular anime as fallback
      const query = `
        query {
          Page(page: 1, perPage: 40) {
            media(type: ANIME, sort: POPULARITY_DESC) {
              id
              title { romaji english }
              coverImage { large }
              format
              status
              episodes
              averageScore
              description(asHtml: false)
              startDate { year }
            }
          }
        }
      `;
      const res = await axios.post('https://graphql.anilist.co', { query }, { timeout: 10000 });
      const media = res.data?.data?.Page?.media || [];
      return media.map(item => ({
        title: item.title.english || item.title.romaji || 'Unknown',
        link: `https://${KAWAII_ANIME_DOMAIN}/anime/${item.id}`,
        image: item.coverImage?.large || '',
        year: item.startDate?.year?.toString() || '',
        quality: item.averageScore ? `★ ${(item.averageScore / 10).toFixed(1)}` : 'Anime',
        description: (item.description || '').replace(/<[^>]*>/g, '').substring(0, 300),
        _kawaiiId: item.id,
        mediaType: 'tv',
        sourceName: 'KawaiiAnime'
      }));
    } catch (error) {
      console.error('[scraper] KawaiiAnime listing error:', error.message);
      return [];
    }
  }

  /**
   * Scrape kawaii-anime.com detail page for episodes and metadata.
   * Returns episodes list - actual episode data will be fetched via IPC for SPA rendering.
   */
  async function scrapeKawaiiAnimeDetail(detailUrl) {
    try {
      const idMatch = detailUrl.match(/\/anime\/(\d+)/);
      if (!idMatch) return { success: false, error: 'Invalid KawaiiAnime URL', downloads: [], poster: '' };

      const anilistId = idMatch[1];

      // Fetch metadata from AniList
      let title = '', description = '', poster = '', episodeCount = 0, bannerImage = '', mediaStatus = '';
      let episodesFromAnilist = [], nextAiringEp = null;
      let related = [];
      try {
        const query = `
          query ($id: Int) {
            Media(id: $id, type: ANIME) {
              title { romaji english }
              description(asHtml: false)
              coverImage { large extraLarge }
              bannerImage
              episodes
              format
              status
              nextAiringEpisode { episode airingAt }
              streamingEpisodes { title thumbnail site }
              recommendations(perPage: 10) {
                nodes {
                  mediaRecommendation {
                    id
                    title { romaji english }
                    coverImage { large }
                  }
                }
              }
            }
          }
        `;
        const res = await axios.post('https://graphql.anilist.co', { query, variables: { id: parseInt(anilistId) } }, { timeout: 10000 });
        const media = res.data?.data?.Media;
        if (media) {
          title = media.title.english || media.title.romaji || '';
          description = (media.description || '').replace(/<[^>]*>/g, '').substring(0, 500);
          poster = media.coverImage?.extraLarge || media.coverImage?.large || '';
          bannerImage = media.bannerImage || '';
          episodeCount = media.episodes || 0;
          mediaStatus = media.status || '';
          if (media.streamingEpisodes && media.streamingEpisodes.length) {
            episodesFromAnilist = media.streamingEpisodes;
          }
          if (media.nextAiringEpisode) nextAiringEp = media.nextAiringEpisode;
          if (media.recommendations?.nodes) {
            related = media.recommendations.nodes
              .map(n => n.mediaRecommendation)
              .filter(Boolean)
              .map(rec => ({
                title: rec.title.english || rec.title.romaji || '',
                image: rec.coverImage?.large || '',
                link: `https://${KAWAII_ANIME_DOMAIN}/anime/${rec.id}`
              }))
              .filter(rec => rec.title);
          }
        }
      } catch (e) {}

      // Generate episode links (will be resolved to actual video URLs via IPC)
      let episodes = [];
      // If AniList has no episode count, try nextAiringEpisode or default to 12 for airing/finished shows
      const effectiveEpCount = episodeCount > 0 ? episodeCount : (nextAiringEp?.episode || (mediaStatus === 'RELEASING' || mediaStatus === 'FINISHED' ? 12 : 0));
      if (effectiveEpCount > 0) {
        for (let i = 1; i <= Math.min(effectiveEpCount, 50); i++) {
          const alEp = episodesFromAnilist[i - 1];
          episodes.push({
            season: 1,
            epNum: i,
            url: `https://${KAWAII_ANIME_DOMAIN}/watch/${anilistId}?num=${i}`,
            name: alEp?.title || `Episode ${i}`,
            thumbnail: alEp?.thumbnail || ''
          });
        }
      }

      if (episodes.length > 0) {
        const downloads = [{
          quality: `${episodes.length} Episodes Available`,
          size: 'Click an episode to play',
          seeds: '',
          torrentUrl: '',
          isSeriesEpisodes: true,
          episodes,
          sourceUrl: detailUrl,
          _isKawaiiAnime: true
        }];
        const episodesData = { 'Season 1': episodes.map(ep => ({ number: ep.epNum, title: ep.name, link: ep.url, thumbnail: ep.thumbnail })) };
        return { success: true, downloads, poster, title, description, isMovie: false, seasons: 1, episodesData, episodes, related, isAnimeSource: true };
      }

      // Movie format from AniList
      const downloads = [{
        quality: '▶ Watch Anime',
        size: 'Stream on KawaiiAnime',
        seeds: '',
        torrentUrl: '',
        isMoviboxStream: true,
        sourceUrl: `https://${KAWAII_ANIME_DOMAIN}/watch/${anilistId}?num=1`,
        _isKawaiiAnime: true
      }];

      return { success: true, downloads, poster, title, description, isMovie: true, related, isAnimeSource: true };
    } catch (error) {
      console.error('[scraper] KawaiiAnime detail error:', error.message);
      return { success: false, error: error.message, downloads: [], poster: '' };
    }
  }

  // ─── Generic Anime Source Detail (luna-stream.me, animex.one, anilight.live) ──────

  async function scrapeAnimeSourceDetail(detailUrl) {
    try {
      const domain = Object.keys(ANIME_SOURCE_DOMAINS).find(d => detailUrl.includes(d));
      if (!domain) return { success: false, error: 'Unknown anime source domain' };

      // Extract AniList ID from URL — handle formats like /anime/{id}, /anime/info/{id}, /watch/{id}
      const pathPart = detailUrl.split('?')[0];
      const idMatch = pathPart.match(/(\d+)$/);
      if (!idMatch) {
        // Fallback: try to scrape HTML for non-AniList URLs
        const res = await axios.get(detailUrl, { headers: BROWSER_HEADERS, timeout: 15000 });
        const $ = cheerio.load(res.data);
        const title = $('h1, .title, .anime-title, [class*="title"]').first().text().trim() || 'Unknown';
        const poster = $('img[src*="poster"], img[src*="cover"], .poster img, .cover img').first().attr('src') || '';
        const episodeLinks = $('a[href*="episode"], a[href*="/watch/"], .episode a');
        const episodes = [];
        episodeLinks.each((i, el) => {
          const href = $(el).attr('href');
          const epTitle = $(el).text().trim() || `Episode ${i + 1}`;
          const fullUrl = href.startsWith('http') ? href : `https://${domain}${href}`;
          episodes.push({ number: i + 1, title: epTitle, url: fullUrl });
        });
        if (episodes.length) {
          const episodesData = { 'Season 1': episodes.map(ep => ({ number: ep.number, title: ep.title, link: ep.url })) };
          return { success: true, title, poster, downloads: [{ quality: `${episodes.length} Episodes`, size: 'Click an episode to play', isSeriesEpisodes: true, episodes: episodes.map(ep => ({ epNum: ep.number, url: ep.url, name: ep.title })), sourceUrl: detailUrl }], isMovie: false, seasons: 1, episodesData, isAnimeSource: true, related: [], _animeSourceDetailUrl: detailUrl };
        }
        return { success: false, error: 'No episodes found', downloads: [], poster: '' };
      }

      const anilistId = idMatch[1];
      const domainConfig = ANIME_SOURCE_DOMAINS[domain];
      let title = '', description = '', poster = '', episodeCount = 0, bannerImage = '', mediaStatus = '';
      let episodesFromAnilist = [], nextAiringEp = null;
      let related = [];
      try {
        const query = `
          query ($id: Int) {
            Media(id: $id, type: ANIME) {
              title { romaji english }
              description(asHtml: false)
              coverImage { large extraLarge }
              bannerImage
              episodes
              format
              status
              nextAiringEpisode { episode airingAt }
              streamingEpisodes { title thumbnail site }
              recommendations(perPage: 10) {
                nodes {
                  mediaRecommendation {
                    id
                    title { romaji english }
                    coverImage { large }
                  }
                }
              }
            }
          }
        `;
        const res = await axios.post('https://graphql.anilist.co', { query, variables: { id: parseInt(anilistId) } }, { timeout: 10000 });
        const media = res.data?.data?.Media;
        if (media) {
          title = media.title.english || media.title.romaji || '';
          description = (media.description || '').replace(/<[^>]*>/g, '').substring(0, 500);
          poster = media.coverImage?.extraLarge || media.coverImage?.large || '';
          bannerImage = media.bannerImage || '';
          episodeCount = media.episodes || 0;
          mediaStatus = media.status || '';
          if (media.streamingEpisodes && media.streamingEpisodes.length) {
            episodesFromAnilist = media.streamingEpisodes;
          }
          if (media.nextAiringEpisode) nextAiringEp = media.nextAiringEpisode;
          if (media.recommendations?.nodes) {
            related = media.recommendations.nodes
              .map(n => n.mediaRecommendation)
              .filter(Boolean)
              .map(rec => ({
                title: rec.title.english || rec.title.romaji || '',
                image: rec.coverImage?.large || '',
                link: domainConfig.watchPattern.replace('{id}', String(rec.id)).replace('{slug}', String(rec.id))
              }))
              .filter(rec => rec.title);
          }
        }
      } catch (e) {}

      let episodes = [];
      // If AniList has no episode count, try nextAiringEpisode or default to 12 for airing/finished shows
      const effectiveEpCount = episodeCount > 0 ? episodeCount : (nextAiringEp?.episode || (mediaStatus === 'RELEASING' || mediaStatus === 'FINISHED' ? 12 : 0));
      if (effectiveEpCount > 0) {
        for (let i = 1; i <= Math.min(effectiveEpCount, 50); i++) {
          const alEp = episodesFromAnilist[i - 1];
          let epUrl;
          if (domain === 'anilight.live') {
            epUrl = `${domainConfig.watchPattern.replace('{id}', anilistId)}?ep=${i}&server=near&lang=sub`;
          } else if (domain === 'anikototv.to') {
            epUrl = `${domainConfig.watchPattern.replace('{slug}', anilistId)}?ep=${i}`;
          } else {
            epUrl = `${domainConfig.watchPattern.replace('{id}', anilistId)}?num=${i}`;
          }
          episodes.push({
            season: 1,
            epNum: i,
            url: epUrl,
            name: alEp?.title || `Episode ${i}`,
            thumbnail: alEp?.thumbnail || ''
          });
        }
      }

      if (episodes.length > 0) {
        const downloads = [{
          quality: `${episodes.length} Episodes Available`,
          size: 'Click an episode to play',
          seeds: '',
          torrentUrl: '',
          isSeriesEpisodes: true,
          episodes,
          sourceUrl: detailUrl,
          _isAnimeSource: true
        }];
        const episodesData = { 'Season 1': episodes.map(ep => ({ number: ep.epNum, title: ep.name, link: ep.url, thumbnail: ep.thumbnail })) };
        return { success: true, downloads, poster, title, description, isMovie: false, seasons: 1, episodesData, episodes, related, isAnimeSource: true, _animeSourceDetailUrl: detailUrl };
      }

      const downloads = [{
        quality: '▶ Watch Anime',
        size: `Stream on ${domain}`,
        seeds: '',
        torrentUrl: '',
        isMoviboxStream: true,
        sourceUrl: domainConfig.watchPattern.replace('{id}', anilistId).replace('{slug}', anilistId) + '?num=1',
        _isAnimeSource: true
      }];

      return {
        success: true, title, description, poster, downloads, related,
        isMovie: true,
        isAnimeSource: true,
        _animeSourceDetailUrl: detailUrl
      };
    } catch (error) {
      console.error('[scraper] Anime source detail error:', error.message);
      return { success: false, error: error.message, downloads: [], poster: '' };
    }
  }



  module.exports = { scrape, scrapeDetail, getPoster, scrapeKawaiiAnimeListing, scrapeKawaiiAnimeDetail, isKawaiiAnimeUrl, scrapeAnimeSourceDetail, isAnimeSourceUrl, isAnimeSourceListing };
