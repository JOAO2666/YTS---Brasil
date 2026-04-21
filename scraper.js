/**
 * YTSBR Pro — Multi-Provider Scraper & Search Engine
 *
 * Agrega torrents de múltiplas fontes (YTSBR, Nyaa.si, NerdFilmes,
 * XFilmes, HDR Torrent, Apache Torrent, BluDV e BaixaFilmesHDR) em
 * paralelo.  Cada provider implementa uma função `searchStreams({
 * enTitle, brTitle, year, type, season, episode })` que retorna um
 * array de streams no formato Stremio.
 *
 * Pipeline:
 *   1. **Translate** — TMDB converte o título IMDb EN → pt-BR.
 *   2. **Cinemeta**  — obtém título original + ano.
 *   3. **Providers** — rodam todos em paralelo, com timeout curto.
 *   4. **Aggregate** — dedup por infoHash e ranking (pt-BR primeiro).
 *
 * @module scraper
 * @author JOAO2666
 * @license MIT
 */

'use strict';

const axios   = require('axios');
const cheerio = require('cheerio');
const Cache   = require('node-cache');
const db      = require('./db');
const debrid  = require('./debrid');

// ─── Constants ───────────────────────────────────────────────────────────────

const BASE_URL  = 'https://ytsbr.com';
const TMDB_KEY  = '8265bd1679663a7ea12ac168da84d2e8';   // public community key
const CINEMETA  = 'https://v3-cinemeta.strem.io/meta';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const HTTP = { headers: { 'User-Agent': USER_AGENT } };

/** Cache em memória compartilhado entre invocações warm. */
const cache = new Cache({ stdTTL: 7_200, checkperiod: 600 });

// ─── Timeouts (ms) ──────────────────────────────────────────────────────────
//
// Vercel hobby plan tem limite de 10 s. Todos os providers devem terminar
// dentro desse orçamento somados com TMDB + Cinemeta.

const T_TMDB      = 3_000;
const T_CINEMETA  = 3_500;
const T_SEARCH    = 4_000;
const T_PAGE      = 5_500;
const T_REDIRECT  = 3_500;

// ─── HTTP helpers ───────────────────────────────────────────────────────────

/**
 * GET simples com User-Agent e timeout padronizados.
 * @param {string} url
 * @param {object} [opts]
 * @returns {Promise<string>} HTML body
 */
async function httpGet(url, opts = {}) {
  const { data } = await axios.get(url, {
    ...HTTP,
    timeout: opts.timeout || T_PAGE,
    headers: { ...HTTP.headers, ...(opts.headers || {}) },
    responseType: 'text',
    transformResponse: [(d) => d],
  });
  return data;
}

/**
 * Segue um único redirect manualmente e devolve a Location.
 * Útil para sites que intermediam magnets via `/?go=HASH`.
 * @param {string} url
 * @returns {Promise<string|null>}
 */
async function resolveRedirect(url) {
  try {
    const res = await axios.get(url, {
      ...HTTP,
      timeout: T_REDIRECT,
      maxRedirects: 0,
      validateStatus: (s) => s >= 200 && s < 400,
    });
    return res.headers?.location || null;
  } catch (err) {
    // axios lança erro em 3xx quando maxRedirects:0 em algumas versões
    return err.response?.headers?.location || null;
  }
}

/**
 * Resolve o "protetor de links" systemads.xyz (usado por BluDV,
 * BaixaFilmesHDR e similares) para o magnet URI real.
 *
 * O HTML da página expõe um `redirect = "...receber.php?id=TOKEN"`
 * onde TOKEN é `base64(magnet)` com a string invertida.  Decodificamos
 * localmente — não precisamos seguir redirects, aguardar timer nem
 * bypass de ads.  Tempo médio: ~1 s (único GET).
 *
 * @param {string} url
 * @returns {Promise<string|null>}
 */
async function resolveSystemadsMagnet(url) {
  try {
    const body = await httpGet(url, { timeout: T_REDIRECT });
    const m = body.match(/redirect\s*=\s*["']([^"']+)["']/);
    if (!m) return null;

    const redirectUrl = m[1]
      .replace(/&#0*38;/g, '&')
      .replace(/&amp;/g, '&');

    let parsed;
    try { parsed = new URL(redirectUrl); } catch { return null; }

    const encoded = parsed.searchParams.get('id');
    if (!encoded) return null;

    const reversed = encoded.split('').reverse().join('');
    let decoded = '';
    try { decoded = Buffer.from(reversed, 'base64').toString('utf8'); }
    catch { return null; }

    return decoded.startsWith('magnet:') ? decoded : null;
  } catch {
    return null;
  }
}

// ─── String utils ───────────────────────────────────────────────────────────

/** Normaliza string: lowercase, sem acentos, só alfanumérico + espaço. */
function norm(s) {
  return (s || '')
    .toString()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Verifica se todas as palavras relevantes da query aparecem no texto. */
function titleMatches(candidateText, query) {
  const nc = norm(candidateText);
  const nq = norm(query);
  if (!nq) return false;
  const words = nq.split(' ').filter((w) => w.length >= 3);
  if (words.length === 0) return nc.includes(nq);
  return words.every((w) => nc.includes(w));
}

/** Tenta inferir a qualidade a partir do texto (1080p, 720p, 4K, …). */
function inferQuality(text) {
  const t = (text || '').toString();
  if (/2160p|4k|uhd/i.test(t)) return '4K';
  if (/1080p|fullhd|full hd/i.test(t)) return '1080p';
  if (/720p|hd/i.test(t)) return '720p';
  if (/480p|sd/i.test(t)) return '480p';
  if (/cam\b|telesync|ts\b/i.test(t)) return 'CAM';
  return 'HD';
}

/** Extrai o infoHash de um magnet URI. */
function extractInfoHash(magnet) {
  if (!magnet) return null;
  const m = magnet.match(/btih:([a-fA-F0-9]{32,40})/i);
  return m ? m[1].toLowerCase() : null;
}

/** Extrai o display-name de um magnet URI. */
function extractDn(magnet) {
  const m = magnet && magnet.match(/dn=([^&]+)/i);
  return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : '';
}

// ─── Translation Layer ──────────────────────────────────────────────────────

/**
 * Resolve o título pt-BR para um IMDb ID via TMDB.
 * @param   {string}  imdbId
 * @param   {string}  type  "movie" | "series"
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

// ─── Episode matching ───────────────────────────────────────────────────────

function torrentCoversEpisode(filename, episode) {
  if (!filename || !episode) return false;
  const upper = filename.toUpperCase();

  const singleEps = upper.match(/[SE]\d+E(\d+)/g);
  if (singleEps) {
    for (const m of singleEps) {
      const epNum = parseInt(m.match(/E(\d+)/)[1], 10);
      if (epNum === episode) return true;
    }
  }

  // "- 07 " ou "- 07.mkv" padrão anime
  const animeEp = upper.match(/(?:^|[\s\-\._\[])(?:E|EP|EPISODE)?\s*(\d{1,3})(?=\s|\.|\[|\]|$|-)/g);
  if (animeEp) {
    for (const m of animeEp) {
      const n = parseInt(m.replace(/\D/g, ''), 10);
      if (n === episode) return true;
    }
  }

  const multiDash = upper.match(/E(\d+(?:-\d+)+)/);
  if (multiDash) {
    const nums = multiDash[1].split('-').map((n) => parseInt(n, 10));
    if (nums.includes(episode)) return true;
    if (nums.length === 2 && episode >= nums[0] && episode <= nums[1]) return true;
  }

  const rangeMatch = upper.match(/E(\d+)\s*(?:-|\.?A\.?)\s*E(\d+)/);
  if (rangeMatch) {
    const start = parseInt(rangeMatch[1], 10);
    const end   = parseInt(rangeMatch[2], 10);
    if (episode >= start && episode <= end) return true;
  }

  return false;
}

function filenameIsPack(filename) {
  if (!filename) return false;
  return /pack|completa|temporada|batch|season|todos|complete/i.test(filename)
      || /E\d+-\d+/i.test(filename)
      || /E\d+\.?a\.?E\d+/i.test(filename)
      || /S\d+\s*(complete|batch|pack)/i.test(filename);
}

// ─── Provider: YTSBR ────────────────────────────────────────────────────────

async function ytsbrSearch(query, lang = 'pt-br') {
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

function ytsbrPageUrl(match) {
  const prefix = { en: '/en', es: '/es' }[match.l] || '';
  let tp = match.tp;
  if (match.l === 'en') {
    tp = { filme: 'movie', serie: 'tvshow' }[tp] || tp;
  }
  return `${BASE_URL}${prefix}/${tp}/${match.s}/`;
}

async function ytsbrFindBestMatch(enTitle, brTitle, year) {
  const raw = [brTitle, enTitle];
  const shortEn = enTitle?.split(':')[0].trim();
  if (shortEn && shortEn !== enTitle) raw.push(shortEn);
  if (brTitle) {
    const shortBr = brTitle.split(':')[0].trim();
    if (shortBr !== brTitle) raw.push(shortBr);
  }
  const queries = [...new Set(raw.filter(Boolean))];

  const batches = await Promise.all(
    queries.flatMap((q) => [ytsbrSearch(q, 'pt-br'), ytsbrSearch(q, 'global')])
  );
  let pool = batches.flat();
  if (pool.length === 0) return { best: null, all: [] };

  const seen = new Set();
  pool = pool.filter((r) => {
    const k = `${r.l}:${r.s}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  pool.sort((a, b) => {
    const langCmp = (a.l === 'pt-br' ? 0 : 1) - (b.l === 'pt-br' ? 0 : 1);
    if (langCmp) return langCmp;
    const yearCmp = (String(a.y) === String(year) ? 0 : 1) - (String(b.y) === String(year) ? 0 : 1);
    if (yearCmp) return yearCmp;
    return a.s.length - b.s.length;
  });

  return { best: pool[0], all: pool };
}

function ytsbrIsPack($, el, ctx) {
  if (/pack|completa|temporada|todos/i.test(ctx)) return true;
  const cls = $(el).attr('class') || '';
  const parentCls = $(el).parent().attr('class') || '';
  return /pack|semi/i.test(cls) || /pack|semi/i.test(parentCls);
}

function ytsbrExtractStreams($, episode) {
  const exactStreams = [];
  const packStreams  = [];

  $('[data-downloads]').each((_i, el) => {
    try {
      const raw = $(el).attr('data-downloads');
      if (!raw) return;
      const items = JSON.parse(raw);
      if (items.length === 0) return;

      const ctx      = $(el).closest('li, tr, div, section').text();
      const packFlag = ytsbrIsPack($, el, ctx);

      for (const item of items) {
        const magnet   = item.magnet || '';
        const hash     = extractInfoHash(magnet);
        const filename = extractDn(magnet);

        const fileIsPack = packFlag || filenameIsPack(filename);

        const label = [
          fileIsPack ? '📦 PACK' : null,
          item.audio || null,
          item.size  || null,
        ].filter(Boolean).join(' · ');

        let stream = null;
        if (hash) {
          stream = { name: `YTSBR ${item.quality || 'HD'}`, description: label, infoHash: hash };
        } else if (magnet.startsWith('http')) {
          stream = { name: `YTSBR ${item.quality || 'HD'}`, description: label, url: magnet };
        }
        if (!stream) continue;

        if (!episode) {
          exactStreams.push(stream);
        } else if (fileIsPack) {
          if (!filename || torrentCoversEpisode(filename, episode)) {
            stream.description = `📦 PACK · ${stream.description.replace('📦 PACK · ', '')}`;
          }
          packStreams.push(stream);
        } else if (torrentCoversEpisode(filename, episode)) {
          exactStreams.push(stream);
        } else {
          const ctxEp = ctx.match(/(?:E|Ep\.?\s*|Epis[óo]dio\s*)(\d+)/i);
          if (ctxEp && parseInt(ctxEp[1], 10) === episode) {
            exactStreams.push(stream);
          }
        }
      }
    } catch { /* malformed JSON */ }
  });

  if (exactStreams.length === 0 && packStreams.length === 0) {
    $('a[href^="magnet:"]').each((_i, el) => {
      const href = $(el).attr('href');
      const hash = extractInfoHash(href);
      if (!hash) return;
      const text = $(el).closest('li, tr, p, div').text().trim();
      const stream = {
        name: 'YTSBR Torrent',
        description: text.slice(0, 80),
        infoHash: hash,
      };
      if (!episode) return exactStreams.push(stream);
      const fn = extractDn(href) || text;
      if (torrentCoversEpisode(fn, episode)) exactStreams.push(stream);
      else packStreams.push(stream);
    });
  }

  return [...exactStreams, ...packStreams];
}

/**
 * Provider YTSBR — pt-BR first.
 * @param {{ enTitle, brTitle, year, type, season, episode }} ctx
 */
async function providerYTSBR({ enTitle, brTitle, year, type, season, episode }) {
  const query = enTitle || brTitle;
  if (!query) return [];

  const { best, all } = await ytsbrFindBestMatch(enTitle, brTitle, year);
  if (!best) return [];

  console.log(`[YTSBR] ✓ ${best.t} (${best.l}) → /${best.tp}/${best.s}/`);

  let targetUrl = (type === 'series' && season)
    ? `${BASE_URL}/${season}-temporada/${best.s}/`
    : ytsbrPageUrl(best);

  let streams = [];
  try {
    const html = await httpGet(targetUrl, { timeout: T_PAGE });
    const $ = cheerio.load(html);
    streams = ytsbrExtractStreams($, episode);
  } catch (err) {
    console.log(`[YTSBR] ⚠ primary URL failed: ${err.message}`);
  }

  // Fallback para séries — tenta outros slugs
  if (streams.length === 0 && type === 'series' && season && all.length > 1) {
    const slugs = [...new Set(all.map((r) => r.s).filter((s) => s !== best.s))];
    for (const slug of slugs.slice(0, 3)) {
      const altUrl = `${BASE_URL}/${season}-temporada/${slug}/`;
      try {
        const html = await httpGet(altUrl, { timeout: T_PAGE });
        const $ = cheerio.load(html);
        streams = ytsbrExtractStreams($, episode);
        if (streams.length > 0) { console.log(`[YTSBR] ✓ fallback slug ${slug}`); break; }
      } catch { /* next */ }
    }
  }

  // Fallback — tenta descobrir link da temporada na página principal
  if (streams.length === 0 && type === 'series' && season) {
    const slugs = [best.s, ...all.map((r) => r.s)];
    for (const slug of [...new Set(slugs)].slice(0, 3)) {
      try {
        const mainUrl = `${BASE_URL}/serie/${slug}/`;
        const html = await httpGet(mainUrl, { timeout: T_PAGE });
        const $ = cheerio.load(html);
        const pattern = new RegExp(`/${season}-temporada/([^/]+)/`);
        let seasonUrl = null;
        $('a[href]').each((_i, el) => {
          const href = $(el).attr('href') || '';
          if (pattern.test(href)) { seasonUrl = href; return false; }
        });
        if (!seasonUrl) continue;
        const full = seasonUrl.startsWith('http') ? seasonUrl : `${BASE_URL}${seasonUrl}`;
        const shtml = await httpGet(full, { timeout: T_PAGE });
        const $s = cheerio.load(shtml);
        streams = ytsbrExtractStreams($s, episode);
        if (streams.length > 0) break;
      } catch { /* next */ }
    }
  }

  return streams;
}

// ─── Provider: Nyaa.si ──────────────────────────────────────────────────────

/**
 * Builds Nyaa search URL.  Uses category 0_0 (all) + sort by seeders.
 */
function nyaaSearchUrl(query) {
  return `https://nyaa.si/?f=0&c=0_0&s=seeders&o=desc&q=${encodeURIComponent(query)}`;
}

async function providerNyaa({ enTitle, brTitle, year, type, season, episode }) {
  // Nyaa é majoritariamente anime/live-action asiático em inglês/romaji.
  // Usamos enTitle como principal e fazemos variações com S01, Season 1, etc.
  const title = enTitle || brTitle;
  if (!title) return [];

  const queries = new Set();
  const base = title.replace(/[:()!?,.]/g, '').trim();
  queries.add(base);
  if (season) {
    queries.add(`${base} S${String(season).padStart(2, '0')}`);
    queries.add(`${base} Season ${season}`);
  }
  const shortBase = base.split(' ').slice(0, 4).join(' ');
  if (shortBase !== base) queries.add(shortBase);

  const batches = await Promise.all(
    [...queries].slice(0, 3).map((q) =>
      httpGet(nyaaSearchUrl(q), { timeout: T_SEARCH }).catch(() => null)
    )
  );

  const streams = [];
  const seen = new Set();

  for (const html of batches) {
    if (!html) continue;
    const $ = cheerio.load(html);

    $('tr').each((_i, tr) => {
      const $tr = $(tr);
      const magnetA = $tr.find('a[href^="magnet:"]').attr('href');
      if (!magnetA) return;
      const hash = extractInfoHash(magnetA);
      if (!hash || seen.has(hash)) return;

      const title = $tr.find('td:nth-child(2) a:not(.comments)').last().attr('title')
                 || $tr.find('td:nth-child(2) a:not(.comments)').last().text().trim();
      if (!title) return;
      if (!titleMatches(title, shortBase || base)) return;

      // Episode / season filter (best-effort)
      if (episode) {
        const isPack = filenameIsPack(title);
        const covers = torrentCoversEpisode(title, episode);
        if (!covers && !isPack) return;
      } else if (season && type === 'series') {
        const sPattern = new RegExp(`S0?${season}[^0-9]|Season\\s*0?${season}|${season}(st|nd|rd|th)?\\s*Season`, 'i');
        if (!sPattern.test(title) && !filenameIsPack(title)) {
          // Skip if clearly a different season
          const otherSeason = title.match(/S(\d{1,2})E/i);
          if (otherSeason && parseInt(otherSeason[1], 10) !== parseInt(season, 10)) return;
        }
      }

      const size = $tr.find('td').eq(3).text().trim();
      const seeders = $tr.find('td').eq(5).text().trim();
      const quality = inferQuality(title);
      const desc = [
        filenameIsPack(title) ? '📦 PACK' : null,
        size || null,
        seeders ? `👥 ${seeders}` : null,
        title.length > 80 ? title.slice(0, 80) + '…' : title,
      ].filter(Boolean).join(' · ');

      seen.add(hash);
      streams.push({
        name: `Nyaa ${quality}`,
        description: desc,
        infoHash: hash,
      });
    });
  }

  console.log(`[Nyaa] ✓ ${streams.length} stream(s)`);
  return streams.slice(0, 30);
}

// ─── Provider: generic WordPress BR (magnets diretos) ───────────────────────

/**
 * Extrai candidatos de uma página de busca WordPress:
 * pega anchors internos cujo texto combine com a query + ano.
 */
function wpCollectCandidates($, base, query, year) {
  const out = [];
  const seen = new Set();

  $('a[href]').each((_i, el) => {
    const href = $(el).attr('href') || '';
    if (!href.startsWith('http')) return;
    try {
      const u = new URL(href);
      const baseHost = new URL(base).host;
      if (u.host !== baseHost) return;
      const p = u.pathname;
      if (!p || p === '/' || p.length < 4) return;
      if (/\/(categoria|category|tag|page|atores|atriz|diretor|diretora|genero|genre|author|feed|wp-)/i.test(p)) return;
      if (/sitemap\.xml$|\.jpg$|\.png$|\.webp$/i.test(p)) return;
    } catch { return; }

    const text = ($(el).attr('title') || $(el).text() || '').trim();
    if (text.length < 3) return;
    if (seen.has(href)) return;
    if (!titleMatches(text, query)) return;

    seen.add(href);
    out.push({ url: href, text });
  });

  out.sort((a, b) => {
    const ay = year && new RegExp(`\\b${year}\\b`).test(a.text) ? 0 : 1;
    const by = year && new RegExp(`\\b${year}\\b`).test(b.text) ? 0 : 1;
    if (ay !== by) return ay - by;
    return a.text.length - b.text.length;
  });

  return out;
}

/**
 * Provider genérico para sites WordPress brasileiros que expõem magnets
 * diretamente em `<a href="magnet:">` na página do post.
 */
/** Gera variantes de query para WordPress brasileiros, removendo pontuação. */
function buildWPQueries(brTitle, enTitle, year, type, season) {
  const out = [];
  const base = brTitle || enTitle;
  if (!base) return out;

  const clean = (s) => (s || '').replace(/[:;,!?"'`]/g, '').replace(/\s+/g, ' ').trim();

  const br = clean(base);
  const en = clean(enTitle || '');
  out.push(br);

  // Variante antes do primeiro "-" ou "–" (muitos sites BR omitem subtítulo)
  const hyphenSplit = br.split(/\s[-–]\s/)[0];
  if (hyphenSplit && hyphenSplit !== br) out.push(hyphenSplit);

  // Variante antes dos dois-pontos no título original
  const colonSplit = (brTitle || '').split(':')[0].trim();
  if (colonSplit && colonSplit !== base) out.push(clean(colonSplit));

  if (season && type === 'series') {
    out.push(`${br} ${season}ª Temporada`);
    out.push(`${br} temporada ${season}`);
  }
  if (en && en !== br) out.push(en);

  // Forma curta com primeiras 2-3 palavras se o título for longo
  const words = br.split(' ');
  if (words.length >= 3) out.push(words.slice(0, 2).join(' '));

  // Dedup preservando ordem
  return [...new Set(out.filter(Boolean))];
}

function makeWordPressProvider({ name, base, tag }) {
  return async function providerWP({ enTitle, brTitle, year, type, season, episode }) {
    const queries = buildWPQueries(brTitle, enTitle, year, type, season);
    if (queries.length === 0) return [];

    const allCandidates = [];
    for (const q of queries.slice(0, 4)) {
      try {
        const searchUrl = `${base}/?s=${encodeURIComponent(q)}`;
        const html = await httpGet(searchUrl, { timeout: T_SEARCH });
        const $ = cheerio.load(html);
        const candidates = wpCollectCandidates($, base, q, year);
        for (const c of candidates) {
          if (!allCandidates.some((x) => x.url === c.url)) allCandidates.push(c);
        }
        if (allCandidates.length >= 2) break;
      } catch { /* next query */ }
    }

    if (allCandidates.length === 0) return [];

    const top = allCandidates.slice(0, 2);
    const streams = [];
    const seen = new Set();

    for (const c of top) {
      try {
        const html = await httpGet(c.url, { timeout: T_PAGE });
        const $ = cheerio.load(html);

        $('a[href^="magnet:"]').each((_i, el) => {
          const href  = $(el).attr('href');
          const hash  = extractInfoHash(href);
          if (!hash || seen.has(hash)) return;

          const label = ($(el).text() || '').replace(/🧲/g, '').trim();
          const filename = extractDn(href) || label;
          const quality = inferQuality(label + ' ' + filename);
          const isPack = filenameIsPack(label) || filenameIsPack(filename);

          // Filter by episode for series
          if (episode) {
            const covers = torrentCoversEpisode(filename, episode)
                        || torrentCoversEpisode(label, episode);
            if (!covers && !isPack) return;
          }

          seen.add(hash);
          const desc = [
            isPack ? '📦 PACK' : null,
            label || filename.slice(0, 80),
          ].filter(Boolean).join(' · ');

          streams.push({
            name: `${name} ${quality}`,
            description: desc || name,
            infoHash: hash,
          });
        });
      } catch { /* next */ }
    }

    console.log(`[${tag}] ✓ ${streams.length} stream(s)`);
    return streams;
  };
}

const providerNerdFilmes = makeWordPressProvider({
  name: 'NerdFilmes',
  base: 'https://nerdfilmes.net',
  tag:  'NerdFilmes',
});

const providerHDR = makeWordPressProvider({
  name: 'HDR',
  base: 'https://hdrtorrent.com',
  tag:  'HDR',
});

const providerApache = makeWordPressProvider({
  name: 'Apache',
  base: 'https://apachetorrent.com',
  tag:  'Apache',
});

// ─── Provider: sites protegidos por systemads.xyz (BluDV, BaixaFilmesHDR) ──
//
// O HTML do post NÃO tem magnets diretos; em vez disso, cada "Magnet-Link"
// é um `<a>` apontando para `systemads.xyz/get.php?id=...`.  Resolvemos cada
// um localmente (sem seguir redirects → sem timer/ads).

function makeSystemadsProvider({ name, base, tag }) {
  return async function providerSA({ enTitle, brTitle, year, type, season, episode }) {
    const queries = buildWPQueries(brTitle, enTitle, year, type, season);
    if (queries.length === 0) return [];

    // Sites com systemads têm search lenta (3-4s).  Rodamos no máx 2 queries
    // e paramos assim que acharmos pelo menos 1 candidato — a primeira
    // query já costuma trazer o resultado com match exato.
    const allCandidates = [];
    for (const q of queries.slice(0, 2)) {
      try {
        const html = await httpGet(`${base}/?s=${encodeURIComponent(q)}`, { timeout: T_SEARCH });
        const $ = cheerio.load(html);
        const cands = wpCollectCandidates($, base, q, year);
        for (const c of cands) {
          if (!allCandidates.some((x) => x.url === c.url)) allCandidates.push(c);
        }
        if (allCandidates.length >= 1) break;
      } catch { /* next */ }
    }

    if (allCandidates.length === 0) return [];

    // Processa até 2 candidatos em PARALELO para caber no budget de 7.5s.
    // Cada candidato: post fetch + até 6 protetores em paralelo.
    const perCandidate = await Promise.all(
      allCandidates.slice(0, 2).map(async (c) => {
        let html;
        try { html = await httpGet(c.url, { timeout: T_PAGE }); }
        catch { return []; }
        const $ = cheerio.load(html);

        const protLinks = [];
        $('a[href*="systemads"]').each((_i, el) => {
          const href = $(el).attr('href') || '';
          if (!/systemads\.[a-z]+\/get\.php\?id=/i.test(href)) return;
          const label = $(el).closest('p, li, div, td, strong').text().trim().slice(0, 160)
                     || $(el).text().trim();
          protLinks.push({ url: href, label });
        });

        const resolved = await Promise.all(
          protLinks.slice(0, 6).map(async (p) => ({
            ...p,
            magnet: await resolveSystemadsMagnet(p.url),
          }))
        );

        return resolved.filter((r) => r.magnet);
      })
    );

    const streams = [];
    const seen = new Set();

    for (const list of perCandidate) {
      for (const r of list) {
        const hash = extractInfoHash(r.magnet);
        if (!hash || seen.has(hash)) continue;

        const filename = extractDn(r.magnet) || r.label;
        const quality = inferQuality(r.label + ' ' + filename);
        const isPack = filenameIsPack(r.label) || filenameIsPack(filename);

        if (episode) {
          const covers = torrentCoversEpisode(filename, episode)
                      || torrentCoversEpisode(r.label, episode);
          if (!covers && !isPack) continue;
        }

        seen.add(hash);
        streams.push({
          name: `${name} ${quality}`,
          description: [isPack ? '📦 PACK' : null, (r.label || '').slice(0, 80)]
            .filter(Boolean).join(' · ') || name,
          infoHash: hash,
        });
      }
    }

    console.log(`[${tag}] ✓ ${streams.length} stream(s)`);
    return streams;
  };
}

const providerBluDV = makeSystemadsProvider({
  name: 'BluDV',
  base: 'https://bludv1.com',
  tag:  'BluDV',
});

const providerBaixaHDR = makeSystemadsProvider({
  name: 'BaixaHDR',
  base: 'https://baixafilmeshdr.net',
  tag:  'BaixaHDR',
});

// ─── Provider: XFilmes (redirect-based) ─────────────────────────────────────

/**
 * XFilmes expõe magnets via endpoint intermediário `/?go=HASH` que
 * responde 302 com Location = magnet:?xt=…
 */
async function providerXFilmes({ enTitle, brTitle, year, type, season, episode }) {
  const base = 'https://www.xfilmetorrenthd.com.br';
  const queries = buildWPQueries(brTitle, enTitle, year, type, season);
  if (queries.length === 0) return [];

  const allCandidates = [];
  for (const q of queries.slice(0, 4)) {
    try {
      const html = await httpGet(`${base}/?s=${encodeURIComponent(q)}`, { timeout: T_SEARCH });
      const $ = cheerio.load(html);
      const cands = wpCollectCandidates($, base, q, year);
      for (const c of cands) {
        if (!allCandidates.some((x) => x.url === c.url)) allCandidates.push(c);
      }
      if (allCandidates.length >= 2) break;
    } catch { /* next */ }
  }

  if (allCandidates.length === 0) return [];

  const streams = [];
  const seen = new Set();

  for (const c of allCandidates.slice(0, 2)) {
    let html;
    try { html = await httpGet(c.url, { timeout: T_PAGE }); }
    catch { continue; }
    const $ = cheerio.load(html);

    // Coleta pares (label, goUrl)
    const goLinks = [];
    $('a[href]').each((_i, el) => {
      const href = $(el).attr('href') || '';
      if (!/\/\?go=[a-f0-9]+/i.test(href)) return;
      const label = $(el).closest('p, li, div, td').text().trim().slice(0, 160)
                 || $(el).text().trim();
      goLinks.push({ url: href.startsWith('http') ? href : `${base}${href.startsWith('/') ? '' : '/'}${href}`, label });
    });

    // Resolve redirects em paralelo (máx 8)
    const resolved = await Promise.all(
      goLinks.slice(0, 8).map(async (g) => {
        const target = await resolveRedirect(g.url);
        return { ...g, target };
      })
    );

    for (const r of resolved) {
      if (!r.target || !r.target.startsWith('magnet:')) continue;
      const hash = extractInfoHash(r.target);
      if (!hash || seen.has(hash)) continue;

      const filename = extractDn(r.target) || r.label;
      const quality = inferQuality(r.label + ' ' + filename);
      const isPack = filenameIsPack(r.label) || filenameIsPack(filename);

      if (episode) {
        const covers = torrentCoversEpisode(filename, episode)
                    || torrentCoversEpisode(r.label, episode);
        if (!covers && !isPack) continue;
      }

      seen.add(hash);
      streams.push({
        name: `XFilmes ${quality}`,
        description: [isPack ? '📦 PACK' : null, r.label.slice(0, 80)].filter(Boolean).join(' · '),
        infoHash: hash,
      });
    }
  }

  console.log(`[XFilmes] ✓ ${streams.length} stream(s)`);
  return streams;
}

// ─── Provider registry ──────────────────────────────────────────────────────

const PROVIDERS = [
  { key: 'ytsbr',       fn: providerYTSBR,      priority: 1 },
  { key: 'bludv',       fn: providerBluDV,      priority: 2 },
  { key: 'nerdfilmes',  fn: providerNerdFilmes, priority: 3 },
  { key: 'xfilmes',     fn: providerXFilmes,    priority: 4 },
  { key: 'baixahdr',    fn: providerBaixaHDR,   priority: 5 },
  { key: 'apache',      fn: providerApache,     priority: 6 },
  { key: 'hdr',         fn: providerHDR,        priority: 7 },
  { key: 'nyaa',        fn: providerNyaa,       priority: 8 },
];

/** Executa provider com timeout hard para não estourar o orçamento total. */
function runWithTimeout(fn, ctx, ms, label) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      console.log(`[${label}] ⏱ timeout`);
      resolve([]);
    }, ms);
    if (timer.unref) timer.unref();
  });
  const work = Promise.resolve()
    .then(() => fn(ctx))
    .catch((e) => { console.log(`[${label}] ✗ ${e.message}`); return []; })
    .finally(() => clearTimeout(timer));
  return Promise.race([work, timeout]);
}

// ─── Public: Catalog & Meta (YTSBR) ─────────────────────────────────────────

async function getCatalog(type) {
  const key = `cat_${type}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const url = type === 'movie'
    ? `${BASE_URL}/filmes-torrent/`
    : `${BASE_URL}/series-torrent/`;

  try {
    const html = await httpGet(url, { timeout: 6_000 });
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

async function getMeta(type, slug) {
  try {
    const html = await httpGet(`${BASE_URL}/${slug}/`, { timeout: 5_000 });
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

// ─── Public: Streams (multi-provider) ───────────────────────────────────────

/**
 * Resolve torrent streams agregando todos os providers em paralelo.
 *
 * @param   {string} type  "movie" | "series"
 * @param   {string} id    IMDb ID com sufixo ":season:episode" opcional
 * @returns {Promise<Array<object>>}
 */
async function getStreams(type, id) {
  const key = `str_${id}`;
  const hit = cache.get(key);
  if (hit) return hit;

  try {
    // YTSBR catalog slugs também são aceitos (não-tt IDs)
    if (!id.startsWith('tt')) {
      const streams = await providerYTSBR({
        enTitle: null, brTitle: null, year: '', type, season: null, episode: null,
      }).catch(() => []);
      return streams;
    }

    const [imdbId, seasonStr, epStr] = id.split(':');
    const season  = seasonStr ? parseInt(seasonStr, 10) : null;
    const episode = epStr     ? parseInt(epStr, 10)     : null;

    // ─── FAST PATH ─ Supabase cache lookup ─────────────────────────────
    //
    // Se o indexer já pré-populou esse título, devolvemos em ~50-200ms
    // sem tocar em nenhum site externo. 95% das requests em tempo real
    // caem neste caminho depois do banco estar aquecido.
    if (db.ENABLED) {
      const cached = await db.readCache(imdbId, season, episode);
      if (cached && cached.length > 0) {
        console.log(`[scraper] ⚡ cache hit: ${cached.length} streams for ${id}`);
        const finalStreams = await debrid.transform(cached);
        cache.set(key, finalStreams);
        return finalStreams;
      }
    }

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

    console.log(`[scraper] "${enTitle}" / "${brTitle}" (${year}) s${season ?? ''}e${episode ?? ''}`);

    const ctx = { enTitle, brTitle, year, type, season, episode };

    // Nyaa é mais útil para animes; ainda assim rodamos para filmes porque
    // não conseguimos detectar anime 100% sem metadata extra.
    const results = await Promise.all(
      PROVIDERS.map((p) => runWithTimeout(p.fn, ctx, 9_000, p.key))
    );

    // Agrega + dedup por infoHash
    const combined = [];
    const seen = new Set();

    results.forEach((list, idx) => {
      const provider = PROVIDERS[idx];
      for (const s of list) {
        const k = s.infoHash || s.url;
        if (!k || seen.has(k)) continue;
        seen.add(k);
        combined.push({ ...s, __priority: provider.priority });
      }
    });

    // Ordena: prioridade do provider → pack por último
    combined.sort((a, b) => {
      const aPack = /📦/.test(a.description || '') ? 1 : 0;
      const bPack = /📦/.test(b.description || '') ? 1 : 0;
      if (aPack !== bPack) return aPack - bPack;
      return (a.__priority || 9) - (b.__priority || 9);
    });

    const streams = combined.map(({ __priority, ...s }) => s);

    console.log(`[scraper] ✓ total ${streams.length} stream(s)`);

    // Write-behind: salva no Supabase sem bloquear a resposta.
    if (db.ENABLED && streams.length > 0) {
      db.writeCache(imdbId, season, episode, streams).catch((e) =>
        console.log(`[db] background write failed: ${e.message}`)
      );
    }

    // Converte magnets em links HTTP via Real-Debrid (se habilitado).
    const finalStreams = await debrid.transform(streams);

    if (finalStreams.length > 0) cache.set(key, finalStreams);
    return finalStreams;
  } catch (err) {
    console.error(`[scraper] ✗ ${err.message}`);
    return [];
  }
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = { getCatalog, getMeta, getStreams };
