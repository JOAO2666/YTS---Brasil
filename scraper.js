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
 * Check if a torrent covers a specific episode.
 *
 * Handles single episodes (S04E07), multi-episode packs (S04E01-02-03),
 * and episode ranges (S04E01-E08).
 *
 * @param   {string}  filename  Torrent filename or magnet DN
 * @param   {number}  episode   Target episode number
 * @returns {boolean}
 */
function torrentCoversEpisode(filename, episode) {
  if (!filename || !episode) return false;
  const upper = filename.toUpperCase();

  // Match "S04E07" pattern — single episode
  const singleEps = upper.match(/[SE]\d+E(\d+)/g);
  if (singleEps) {
    for (const m of singleEps) {
      const epNum = parseInt(m.match(/E(\d+)/)[1], 10);
      if (epNum === episode) return true;
    }
  }

  // Match "S04E01-02-03" pattern — dash-separated multi-episode
  const multiDash = upper.match(/E(\d+(?:-\d+)+)/);
  if (multiDash) {
    const nums = multiDash[1].split('-').map(n => parseInt(n, 10));
    if (nums.includes(episode)) return true;
    // Could also be a range: E01-08 meaning episodes 1 through 8
    if (nums.length === 2 && episode >= nums[0] && episode <= nums[1]) return true;
  }

  // Match "E01-E08" or "E01.a.E08" range pattern
  const rangeMatch = upper.match(/E(\d+)\s*(?:-|\.?A\.?)\s*E(\d+)/);
  if (rangeMatch) {
    const start = parseInt(rangeMatch[1], 10);
    const end   = parseInt(rangeMatch[2], 10);
    if (episode >= start && episode <= end) return true;
  }

  return false;
}

/**
 * Determine if a data-downloads element represents a pack/semipack.
 *
 * Checks the surrounding text context AND the CSS class of the element
 * for pack indicators.
 *
 * @param   {CheerioAPI} $    Cheerio instance
 * @param   {Element}    el   The data-downloads element
 * @param   {string}     ctx  Text context around the element
 * @returns {boolean}
 */
function isPack($, el, ctx) {
  // Text-based detection
  if (/pack|completa|temporada|todos/i.test(ctx)) return true;

  // CSS class-based detection (YTSBR uses "semipack-bracket")
  const cls = $(el).attr('class') || '';
  const parentCls = $(el).parent().attr('class') || '';
  if (/pack|semi/i.test(cls) || /pack|semi/i.test(parentCls)) return true;

  return false;
}

/**
 * Parse torrent streams from a loaded Cheerio document.
 *
 * Supports two page formats:
 *   - Modern: `[data-downloads]` JSON attribute (magnet or .torrent URL)
 *   - Legacy: Raw `<a href="magnet:…">` links (older pages, anime)
 *
 * Episode matching strategy (when `episode` is set):
 *   1. Exact match: torrent filename contains the target episode number
 *   2. Pack/semipack: torrent covers a range that includes the episode
 *   3. Fallback: if no exact match found, include all packs/semipacks
 *
 * @param   {CheerioAPI}  $         Loaded Cheerio document
 * @param   {number|null} episode   Target episode number (series only)
 * @returns {Array<object>}         Stremio-compatible stream objects
 */
function extractStreams($, episode) {
  const exactStreams = [];
  const packStreams  = [];

  // ── Modern: data-downloads JSON ──
  $('[data-downloads]').each((_i, el) => {
    try {
      const raw = $(el).attr('data-downloads');
      if (!raw) return;

      const items = JSON.parse(raw);
      if (items.length === 0) return;

      const ctx      = $(el).closest('li, tr, div, section').text();
      const packFlag = isPack($, el, ctx);

      for (const item of items) {
        const magnet   = item.magnet || '';
        const hash     = magnet.match(/btih:([a-fA-F0-9]{32,})/i);
        const dnMatch  = magnet.match(/dn=([^&]+)/i);
        const filename = dnMatch ? decodeURIComponent(dnMatch[1]) : '';

        // Determine if this specific torrent is a pack by checking filename
        const fileIsPack = packFlag
          || /pack|completa|temporada/i.test(filename)
          || /E\d+-\d+/i.test(filename)               // S04E01-03
          || /E\d+\.?a\.?E\d+/i.test(filename);       // E01aE08

        // Build label
        const label = [
          fileIsPack ? '📦 PACK' : null,
          item.audio || null,
          item.size  || null,
        ].filter(Boolean).join(' · ');

        // Build stream object
        let stream = null;
        if (hash) {
          stream = { name: `YTSBR ${item.quality || 'HD'}`, description: label, infoHash: hash[1] };
        } else if (magnet.startsWith('http')) {
          stream = { name: `YTSBR ${item.quality || 'HD'}`, description: label, url: magnet };
        }
        if (!stream) continue;

        // Episode classification
        if (!episode) {
          // No episode filter — include everything
          exactStreams.push(stream);
        } else if (fileIsPack) {
          // Packs always go to the pack bucket (shown as fallback or if they cover the ep)
          if (!filename || torrentCoversEpisode(filename, episode)) {
            stream.description = `📦 PACK · ${stream.description.replace('📦 PACK · ', '')}`;
          }
          packStreams.push(stream);
        } else if (torrentCoversEpisode(filename, episode)) {
          // Exact episode match via filename
          exactStreams.push(stream);
        } else {
          // Check context text for episode number
          const ctxEp = ctx.match(/(?:E|Ep\.?\s*|Epis[óo]dio\s*)(\d+)/i);
          if (ctxEp && parseInt(ctxEp[1], 10) === episode) {
            exactStreams.push(stream);
          }
        }
      }
    } catch { /* malformed JSON — skip */ }
  });

  // ── Legacy: bare magnet anchors ──
  if (exactStreams.length === 0 && packStreams.length === 0) {
    $('a[href^="magnet:"]').each((_i, el) => {
      const href = $(el).attr('href');
      const hash = href.match(/btih:([a-fA-F0-9]{32,})/i);
      if (hash) {
        const text = $(el).closest('li, tr, p, div').text().trim();
        const stream = {
          name: 'YTSBR Torrent',
          description: text.slice(0, 80),
          infoHash: hash[1],
        };

        if (!episode) {
          exactStreams.push(stream);
        } else {
          const dn = href.match(/dn=([^&]+)/i);
          const fn = dn ? decodeURIComponent(dn[1]) : text;
          if (torrentCoversEpisode(fn, episode)) {
            exactStreams.push(stream);
          } else {
            packStreams.push(stream);
          }
        }
      }
    });
  }

  // Return exact matches first, then packs as fallback
  const result = [...exactStreams, ...packStreams];
  return result;
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
 * For series, includes slug-fallback logic: if the primary season URL
 * returns zero streams, tries alternate slugs from search results and
 * scrapes the main series page for season links.
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
    let allSlugs  = [];

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

      // Step 2 — Search YTSBR (collect ALL matching slugs for fallback)
      const match = await findBestMatch(enTitle || brTitle, brTitle, year);
      if (!match) {
        console.log(`[scraper] ✗ no YTSBR results for ${imdbId}`);
        return [];
      }

      // Collect alternate slugs for series fallback
      if (type === 'series' && season) {
        const queries = [brTitle, enTitle].filter(Boolean);
        const rawBatches = await Promise.all(
          [...new Set(queries)].flatMap(q => [search(q, 'pt-br'), search(q, 'global')])
        );
        const seriesResults = rawBatches.flat().filter(r =>
          r.tp === 'serie' || r.tp === 'tvshow'
        );
        const slugSet = new Set();
        slugSet.add(match.s);
        seriesResults.forEach(r => slugSet.add(r.s));
        allSlugs = [...slugSet];
      }

      // Step 3 — Build page URL
      targetUrl = (type === 'series' && season)
        ? `${BASE_URL}/${season}-temporada/${match.s}/`
        : pageUrl(match);
    }

    // Step 4 — Fetch & extract
    console.log(`[scraper] ↓ ${targetUrl}`);
    let streams = [];

    try {
      const { data: html } = await axios.get(targetUrl, { ...HTTP, timeout: T_PAGE });
      const $ = cheerio.load(html);
      streams = extractStreams($, episode);
    } catch (fetchErr) {
      console.log(`[scraper] ⚠ primary URL failed: ${fetchErr.message}`);
    }

    // Step 5 — Slug fallback for series (try alternate slugs)
    if (streams.length === 0 && allSlugs.length > 1) {
      const [, season] = id.split(':');
      for (const altSlug of allSlugs.slice(1)) {
        const altUrl = `${BASE_URL}/${season}-temporada/${altSlug}/`;
        console.log(`[scraper] ↓ fallback: ${altUrl}`);
        try {
          const { data: html } = await axios.get(altUrl, { ...HTTP, timeout: T_PAGE });
          const $ = cheerio.load(html);
          streams = extractStreams($, episode);
          if (streams.length > 0) break;
        } catch { /* try next slug */ }
      }
    }

    // Step 6 — Series page fallback (scrape season links from main page)
    if (streams.length === 0 && type === 'series' && allSlugs.length > 0) {
      const [, season] = id.split(':');
      for (const slug of allSlugs) {
        try {
          const mainUrl = `${BASE_URL}/serie/${slug}/`;
          console.log(`[scraper] ↓ checking main page: ${mainUrl}`);
          const { data: html } = await axios.get(mainUrl, { ...HTTP, timeout: T_PAGE });
          const $ = cheerio.load(html);
          const seasonPattern = new RegExp(`/${season}-temporada/([^/]+)/`);
          let seasonUrl = null;
          $('a[href]').each((_i, el) => {
            const href = $(el).attr('href') || '';
            const m = href.match(seasonPattern);
            if (m) { seasonUrl = href; return false; }
          });
          if (seasonUrl) {
            const fullUrl = seasonUrl.startsWith('http') ? seasonUrl : `${BASE_URL}${seasonUrl}`;
            console.log(`[scraper] ↓ discovered season link: ${fullUrl}`);
            const { data: shtml } = await axios.get(fullUrl, { ...HTTP, timeout: T_PAGE });
            const $s = cheerio.load(shtml);
            streams = extractStreams($s, episode);
            if (streams.length > 0) break;
          }
        } catch { /* try next slug */ }
      }
    }

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
