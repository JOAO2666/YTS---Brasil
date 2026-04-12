/**
 * YTSBR Pro — Scraper & Search Engine
 *
 * Responsible for discovering and extracting torrent streams from the
 * YTS Brasil website.  The pipeline works in four stages:
 *
 *   1. **Translate** — TMDB converts the English IMDb title to pt-BR.
 *   2. **Search**    — Parallel queries hit the YTSBR internal JSON API
 *                      in both pt-BR and global scopes.
 *   3. **Rank**      — Results are deduplicated, then sorted by language
 *                      (pt-BR first), year match, and slug length.
 *   4. **Extract**   — The chosen page is fetched and magnet/torrent
 *                      links are parsed from `data-downloads` JSON or
 *                      fallback `<a href="magnet:">` tags.
 *
 * @module scraper
 * @author JOAO2666
 * @license MIT
 */

'use strict';

const axios   = require('axios');
const cheerio = require('cheerio');
const Cache   = require('node-cache');

// ─── Constants ───────────────────────────────────────────────────────────────

const BASE_URL  = 'https://ytsbr.com';
const TMDB_KEY  = '8265bd1679663a7ea12ac168da84d2e8';   // public community key
const CINEMETA  = 'https://v3-cinemeta.strem.io/meta';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const HTTP = { headers: { 'User-Agent': USER_AGENT } };

/** In-memory cache shared across warm Vercel invocations. */
const cache = new Cache({ stdTTL: 7_200, checkperiod: 600 });

// ─── Timeouts (ms) ──────────────────────────────────────────────────────────
//
// Vercel hobby plan enforces a hard 10 s wall-clock limit.  Every network
// call must finish well within that budget.

const T_TMDB     = 3_000;
const T_SEARCH   = 4_000;
const T_CINEMETA = 3_500;
const T_PAGE     = 8_000;

// ─── Translation Layer ──────────────────────────────────────────────────────

/**
 * Resolve the Brazilian Portuguese title for a given IMDb ID via TMDB.
 *
 * @param   {string}  imdbId  IMDb identifier (e.g. "tt22022452")
 * @param   {string}  type    Stremio content type ("movie" | "series")
 * @returns {Promise<string|null>}
 */
async function translateTitle(imdbId, type) {
  const key = `tmdb_${imdbId}`;
  const hit = cache.get(key);
  if (hit) return hit;

  try {
    const url =
      `https://api.themoviedb.org/3/find/${imdbId}` +
      `?api_key=${TMDB_KEY}&language=pt-BR&external_source=imdb_id`;

    const { data } = await axios.get(url, { timeout: T_TMDB });
    const bucket = type === 'series' ? data.tv_results : data.movie_results;
    const title  = bucket?.[0]?.title || bucket?.[0]?.name || null;

    if (title) cache.set(key, title);
    return title;
  } catch {
    return null;
  }
}

// ─── YTSBR Search API ───────────────────────────────────────────────────────

/**
 * Query the YTSBR internal search endpoint.
 *
 * @param   {string} query  Search term
 * @param   {string} lang   "pt-br" | "global"
 * @returns {Promise<Array>}
 */
async function search(query, lang = 'pt-br') {
  if (!query || query.length < 2) return [];
  try {
    const url = `${BASE_URL}/ajax/search_v2.php?q=${encodeURIComponent(query)}&lang=${lang}`;
    const { data } = await axios.get(url, {
      headers: { ...HTTP.headers, Referer: BASE_URL },
      timeout: T_SEARCH,
    });
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/**
 * Build the full page URL from a search result object.
 *
 * @param   {object} match  A single YTSBR search result
 * @returns {string}        Absolute URL to the content page
 */
function pageUrl(match) {
  const prefix = { en: '/en', es: '/es' }[match.l] || '';
  let tp = match.tp;
  if (match.l === 'en') {
    tp = { filme: 'movie', serie: 'tvshow' }[tp] || tp;
  }
  return `${BASE_URL}${prefix}/${tp}/${match.s}/`;
}

/**
 * Run a multi-query parallel search and return the single best result.
 *
 * Generates several query variants (full title, short title, Brazilian
 * title) and fires all of them simultaneously in both pt-BR and global
 * scopes.  Results are ranked so that pt-BR pages (which contain real
 * magnet links) always surface first.
 *
 * @param   {string}      enTitle   English title from Cinemeta
 * @param   {string|null} brTitle   Portuguese title from TMDB
 * @param   {string}      year      Release year
 * @returns {Promise<object|null>}  Best search result or null
 */
async function findBestMatch(enTitle, brTitle, year) {
  // Build unique query list
  const raw = [brTitle, enTitle];
  const shortEn = enTitle?.split(':')[0].trim();
  if (shortEn && shortEn !== enTitle) raw.push(shortEn);
  if (brTitle) {
    const shortBr = brTitle.split(':')[0].trim();
    if (shortBr !== brTitle) raw.push(shortBr);
  }
  const queries = [...new Set(raw.filter(Boolean))];

  // Fire all searches in parallel
  const promises = queries.flatMap(q => [search(q, 'pt-br'), search(q, 'global')]);
  const batches  = await Promise.all(promises);
  let pool = batches.flat();

  if (pool.length === 0) return null;

  // Deduplicate
  const seen = new Set();
  pool = pool.filter(r => {
    const k = `${r.l}:${r.s}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // Rank: pt-BR → year match → shorter slug
  pool.sort((a, b) => {
    const langCmp = (a.l === 'pt-br' ? 0 : 1) - (b.l === 'pt-br' ? 0 : 1);
    if (langCmp) return langCmp;
    const yearCmp = (a.y == year ? 0 : 1) - (b.y == year ? 0 : 1);
    if (yearCmp) return yearCmp;
    return a.s.length - b.s.length;
  });

  const best = pool[0];
  console.log(`[search] ✓ "${best.t}" (${best.l}) → /${best.tp}/${best.s}/`);
  return best;
}

// ─── Stream Extraction ──────────────────────────────────────────────────────

/**
 * Parse torrent streams from a loaded Cheerio document.
 *
 * Supports two page formats:
 *   - Modern: `[data-downloads]` JSON attribute (magnet or .torrent URL)
 *   - Legacy: Raw `<a href="magnet:…">` links (older pages, anime)
 *
 * @param   {CheerioAPI} $         Loaded Cheerio document
 * @param   {number|null} episode  Target episode number (series only)
 * @returns {Array<object>}        Stremio-compatible stream objects
 */
function extractStreams($, episode) {
  const streams = [];

  // ── Modern: data-downloads JSON ──
  $('[data-downloads]').each((_i, el) => {
    try {
      const raw  = $(el).attr('data-downloads');
      if (!raw) return;

      const items   = JSON.parse(raw);
      const ctx     = $(el).closest('li, tr, div, section').text();
      const isPack  = /pack|completa|temporada|todos/i.test(ctx);
      const epMatch = ctx.match(/(?:E|Ep\.?\s*|Epis[óo]dio\s*)(\d+)/i);

      // Episode filtering (series only)
      if (episode && !isPack) {
        if (!epMatch || parseInt(epMatch[1], 10) !== episode) return;
      }

      for (const item of items) {
        const magnet = item.magnet || '';
        const label  = [
          isPack ? '📦 PACK' : null,
          item.audio || null,
          item.size  || null,
        ].filter(Boolean).join(' · ');

        // Magnet hash (preferred)
        const hash = magnet.match(/btih:([a-fA-F0-9]{32,})/i);
        if (hash) {
          streams.push({
            name: `YTSBR ${item.quality || 'HD'}`,
            description: label,
            infoHash: hash[1],
          });
          continue;
        }

        // Direct .torrent URL (EN pages)
        if (magnet.startsWith('http')) {
          streams.push({
            name: `YTSBR ${item.quality || 'HD'}`,
            description: label,
            url: magnet,
          });
        }
      }
    } catch { /* malformed JSON — skip silently */ }
  });

  // ── Legacy: bare magnet anchors ──
  if (streams.length === 0) {
    $('a[href^="magnet:"]').each((_i, el) => {
      const href = $(el).attr('href');
      const hash = href.match(/btih:([a-fA-F0-9]{32,})/i);
      if (hash) {
        streams.push({
          name: 'YTSBR Torrent',
          description: $(el).closest('li, tr, p, div').text().trim().slice(0, 80),
          infoHash: hash[1],
        });
      }
    });
  }

  return streams;
}

// ─── Public Handlers ────────────────────────────────────────────────────────

/**
 * Fetch the "trending" catalog for a given content type.
 *
 * @param   {string} type  "movie" | "series"
 * @returns {Promise<Array<object>>}
 */
async function getCatalog(type) {
  const key = `cat_${type}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const url = type === 'movie'
    ? `${BASE_URL}/filmes-torrent/`
    : `${BASE_URL}/series-torrent/`;

  try {
    const { data: html } = await axios.get(url, { ...HTTP, timeout: 6_000 });
    const $ = cheerio.load(html);
    const metas = [];
    const seen  = new Set();

    $('a').each((_i, el) => {
      const href = $(el).attr('href');
      const img  = $(el).find('img').attr('src') || $(el).find('img').attr('data-src');

      if (href && (href.includes('/filme/') || href.includes('/serie/')) && img) {
        const id = href.replace(/^\//, '').replace(/\/$/, '');
        if (seen.has(id)) return;
        seen.add(id);

        metas.push({
          id,
          type,
          name:   $(el).find('img').attr('alt') || 'Torrent',
          poster: img.startsWith('http') ? img : `${BASE_URL}${img}`,
        });
      }
    });

    cache.set(key, metas);
    return metas;
  } catch {
    return [];
  }
}

/**
 * Fetch metadata for a single item.
 *
 * @param   {string} type  "movie" | "series"
 * @param   {string} slug  YTSBR slug path
 * @returns {Promise<object|null>}
 */
async function getMeta(type, slug) {
  try {
    const { data: html } = await axios.get(`${BASE_URL}/${slug}/`, { ...HTTP, timeout: 5_000 });
    const $ = cheerio.load(html);
    const poster = $('meta[property="og:image"]').attr('content') || '';

    return {
      id:          slug,
      type,
      name:        $('meta[property="og:title"]').attr('content') || $('h1').text().trim(),
      description: $('meta[property="og:description"]').attr('content') || '',
      poster:      poster.startsWith('http') ? poster : `${BASE_URL}${poster}`,
    };
  } catch {
    return null;
  }
}

/**
 * Resolve torrent streams for a given Stremio content ID.
 *
 * Orchestrates the full pipeline:
 *   Cinemeta (title) + TMDB (translation)  →  YTSBR search  →  page fetch  →  extraction
 *
 * @param   {string} type  "movie" | "series"
 * @param   {string} id    IMDb ID, optionally suffixed with ":season:episode"
 * @returns {Promise<Array<object>>}
 */
async function getStreams(type, id) {
  const key = `str_${id}`;
  const hit = cache.get(key);
  if (hit) return hit;

  try {
    let targetUrl = `${BASE_URL}/${id}/`;
    let episode   = null;

    if (id.startsWith('tt')) {
      const [imdbId, season, ep] = id.split(':');
      if (ep) episode = parseInt(ep, 10);

      // Step 1 — Metadata + Translation (parallel)
      const cinemetaType = type === 'movie' ? 'movie' : 'series';
      const [cinemetaRes, brTitle] = await Promise.all([
        axios.get(`${CINEMETA}/${cinemetaType}/${imdbId}.json`, { timeout: T_CINEMETA }).catch(() => null),
        translateTitle(imdbId, type),
      ]);

      const meta    = cinemetaRes?.data?.meta;
      const enTitle = meta?.name || null;
      const year    = meta?.year || meta?.releaseInfo?.slice(0, 4) || '';

      if (!enTitle && !brTitle) {
        console.log(`[scraper] ✗ no title data for ${imdbId}`);
        return [];
      }

      console.log(`[scraper] "${enTitle}" → "${brTitle}" (${year})`);

      // Step 2 — Search YTSBR
      const match = await findBestMatch(enTitle || brTitle, brTitle, year);
      if (!match) {
        console.log(`[scraper] ✗ no YTSBR results for ${imdbId}`);
        return [];
      }

      // Step 3 — Build page URL
      targetUrl = (type === 'series' && season)
        ? `${BASE_URL}/${season}-temporada/${match.s}/`
        : pageUrl(match);
    }

    // Step 4 — Fetch & extract
    console.log(`[scraper] ↓ ${targetUrl}`);
    const { data: html } = await axios.get(targetUrl, { ...HTTP, timeout: T_PAGE });
    const $ = cheerio.load(html);
    const streams = extractStreams($, episode);

    console.log(`[scraper] ✓ ${streams.length} stream(s)`);
    if (streams.length > 0) cache.set(key, streams);
    return streams;
  } catch (err) {
    console.error(`[scraper] ✗ ${err.message}`);
    return [];
  }
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = { getCatalog, getMeta, getStreams };
