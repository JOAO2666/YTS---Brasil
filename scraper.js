const axios = require('axios');
const cheerio = require('cheerio');
const NodeCache = require('node-cache');

const BASE_URL = 'https://ytsbr.com';
const TMDB_KEY = '8265bd1679663a7ea12ac168da84d2e8'; // Chave pública compartilhada
const cache = new NodeCache({ stdTTL: 7200 }); // 2h
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA };

// ─────────────────────────────────────────────
// TRADUÇÃO: TMDB (Gratuita, 100% confiável)
// ─────────────────────────────────────────────
async function getBrazilianTitle(imdbId, type) {
    const ck = `tmdb_${imdbId}`;
    const cached = cache.get(ck);
    if (cached) return cached;
    try {
        const mediaType = (type === 'series') ? 'tv' : 'movie';
        const url = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_KEY}&language=pt-BR&external_source=imdb_id`;
        const res = await axios.get(url, { timeout: 3000 });
        const results = res.data.movie_results || res.data.tv_results || [];
        if (results.length > 0) {
            const title = results[0].title || results[0].name;
            if (title) { cache.set(ck, title); return title; }
        }
    } catch (e) {}
    return null;
}

// ─────────────────────────────────────────────
// BUSCA: API interna do YTSBR
// ─────────────────────────────────────────────
async function searchYTSBR(query) {
    if (!query || query.length < 2) return [];
    try {
        const url = `${BASE_URL}/ajax/search_v2.php?q=${encodeURIComponent(query)}&lang=pt-br`;
        const res = await axios.get(url, { headers: { ...HEADERS, 'Referer': BASE_URL }, timeout: 4000 });
        return Array.isArray(res.data) ? res.data : [];
    } catch (e) { return []; }
}

async function searchYTSBRGlobal(query) {
    if (!query || query.length < 2) return [];
    try {
        const url = `${BASE_URL}/ajax/search_v2.php?q=${encodeURIComponent(query)}&lang=global`;
        const res = await axios.get(url, { headers: { ...HEADERS, 'Referer': BASE_URL }, timeout: 4000 });
        return Array.isArray(res.data) ? res.data : [];
    } catch (e) { return []; }
}

function buildPageUrl(match) {
    // Sempre constroi URL para a versão brasileira quando possível
    const prefix = match.l === 'en' ? '/en' : (match.l === 'es' ? '/es' : '');
    let tp = match.tp;
    if (match.l === 'en') {
        if (tp === 'filme') tp = 'movie';
        if (tp === 'serie') tp = 'tvshow';
    }
    return `${BASE_URL}${prefix}/${tp}/${match.s}/`;
}

// Encontra a melhor página no YTSBR para um dado título
async function findBestPage(englishTitle, brTitle, year, type) {
    // Estratégia: buscar TODOS os termos em paralelo e pegar o melhor
    const queries = [];
    if (brTitle) queries.push(brTitle);
    queries.push(englishTitle);
    // Variação: só primeira parte do título (antes do :)
    const shortEn = englishTitle.split(':')[0].trim();
    if (shortEn !== englishTitle) queries.push(shortEn);
    if (brTitle) {
        const shortBr = brTitle.split(':')[0].trim();
        if (shortBr !== brTitle) queries.push(shortBr);
    }

    // Dispara TODAS as buscas em paralelo (PT-BR e Global)
    const promises = [];
    for (const q of [...new Set(queries)]) {
        promises.push(searchYTSBR(q));
        promises.push(searchYTSBRGlobal(q));
    }

    const responses = await Promise.all(promises);
    let allResults = [];
    responses.forEach(r => { allResults = [...allResults, ...r]; });

    if (allResults.length === 0) return null;

    // Deduplica por slug
    const seen = new Set();
    allResults = allResults.filter(r => {
        const key = `${r.l}_${r.s}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    // Priorização inteligente:
    // 1. PT-BR sempre primeiro (tem magnet links reais)
    // 2. Ano bate
    // 3. Slug mais curto (geralmente é o principal)
    allResults.sort((a, b) => {
        const aPt = a.l === 'pt-br' ? 0 : 1;
        const bPt = b.l === 'pt-br' ? 0 : 1;
        if (aPt !== bPt) return aPt - bPt;
        const aY = (a.y == year) ? 0 : 1;
        const bY = (b.y == year) ? 0 : 1;
        if (aY !== bY) return aY - bY;
        return a.s.length - b.s.length;
    });

    const best = allResults[0];
    console.log(`[Search] Melhor resultado: "${best.t}" (${best.l}) → /${best.tp}/${best.s}/`);
    return best;
}

// ─────────────────────────────────────────────
// EXTRAÇÃO: Torrents de uma página YTSBR
// ─────────────────────────────────────────────
function extractStreams($, targetEp) {
    const streams = [];

    // Método 1: data-downloads (estrutura moderna)
    $('[data-downloads]').each((i, el) => {
        try {
            const raw = $(el).attr('data-downloads');
            if (!raw) return;
            const data = JSON.parse(raw);
            const context = $(el).closest('li, tr, div, section').text();
            const isPack = /PACK|Completa|Temporada|Todos/i.test(context);

            // Detecta episódio
            const epMatch = context.match(/(?:E|Ep\.?\s*|Epis[óo]dio\s*)(\d+)/i);

            if (targetEp && !isPack) {
                if (!epMatch || parseInt(epMatch[1]) !== targetEp) return;
            }

            data.forEach(item => {
                const magnet = item.magnet || '';

                // Magnet link com hash
                const hashMatch = magnet.match(/btih:([a-fA-F0-9]{32,})/i);
                if (hashMatch) {
                    streams.push({
                        name: `YTSBR ${item.quality || 'HD'}`,
                        description: `${isPack ? '📦 PACK | ' : ''}${item.audio || 'N/A'} | ${item.size || ''}`.trim(),
                        infoHash: hashMatch[1]
                    });
                    return;
                }

                // Link .torrent direto (páginas EN)
                if (magnet.includes('.torrent') || magnet.startsWith('http')) {
                    streams.push({
                        name: `YTSBR ${item.quality || 'HD'}`,
                        description: `${isPack ? '📦 PACK | ' : ''}${item.audio || 'N/A'} | ${item.size || ''}`.trim(),
                        url: magnet
                    });
                }
            });
        } catch (err) {}
    });

    // Método 2: Magnet links diretos no HTML (legacy/anime)
    if (streams.length === 0) {
        $('a[href^="magnet:"]').each((i, el) => {
            const href = $(el).attr('href');
            const hashMatch = href.match(/btih:([a-fA-F0-9]{32,})/i);
            if (hashMatch) {
                const text = $(el).closest('li, tr, p, div').text().trim();
                streams.push({
                    name: 'YTSBR Torrent',
                    description: text.substring(0, 80),
                    infoHash: hashMatch[1]
                });
            }
        });
    }

    return streams;
}

// ─────────────────────────────────────────────
// HANDLERS PRINCIPAIS
// ─────────────────────────────────────────────
async function getCatalog(type) {
    const ck = `catalog_${type}`;
    const cached = cache.get(ck);
    if (cached) return cached;

    const url = (type === 'movie') ? `${BASE_URL}/filmes-torrent/` : `${BASE_URL}/series-torrent/`;
    try {
        const res = await axios.get(url, { headers: HEADERS, timeout: 6000 });
        const $ = cheerio.load(res.data);
        const metas = [];
        const seen = new Set();
        $('a').each((i, el) => {
            const href = $(el).attr('href');
            const img = $(el).find('img').attr('src') || $(el).find('img').attr('data-src');
            if (href && (href.includes('/filme/') || href.includes('/serie/')) && img) {
                const id = href.replace(/^\//, '').replace(/\/$/, '');
                if (seen.has(id)) return;
                seen.add(id);
                metas.push({
                    id, type,
                    name: $(el).find('img').attr('alt') || 'Torrent',
                    poster: img.startsWith('http') ? img : `${BASE_URL}${img}`
                });
            }
        });
        cache.set(ck, metas);
        return metas;
    } catch (e) { return []; }
}

async function getMeta(type, slug) {
    try {
        const res = await axios.get(`${BASE_URL}/${slug}/`, { headers: HEADERS, timeout: 5000 });
        const $ = cheerio.load(res.data);
        const poster = $('meta[property="og:image"]').attr('content') || '';
        return {
            id: slug, type,
            name: $('meta[property="og:title"]').attr('content') || $('h1').text().trim(),
            description: $('meta[property="og:description"]').attr('content') || '',
            poster: poster.startsWith('http') ? poster : `${BASE_URL}${poster}`
        };
    } catch (e) { return null; }
}

async function getStreams(type, id) {
    const ck = `st3_${id}`;
    const cached = cache.get(ck);
    if (cached) return cached;

    try {
        let fetchUrl = `${BASE_URL}/${id}/`;
        let targetEp = null;

        if (id.startsWith('tt')) {
            const parts = id.split(':');
            const imdbId = parts[0];
            const season = parts[1] || null;
            const episode = parts[2] || null;
            if (episode) targetEp = parseInt(episode);

            // PASSO 1: Cinemeta + TMDB em paralelo (velocidade máxima)
            const cinemetaType = (type === 'movie') ? 'movie' : 'series';
            const [cinemetaRes, brTitle] = await Promise.all([
                axios.get(`https://v3-cinemeta.strem.io/meta/${cinemetaType}/${imdbId}.json`, { timeout: 3500 }).catch(() => null),
                getBrazilianTitle(imdbId, type)
            ]);

            const meta = cinemetaRes?.data?.meta;
            const englishTitle = meta?.name || null;
            const year = meta?.year || meta?.releaseInfo?.substring(0, 4) || '';

            // Se não temos nem título inglês nem brasileiro, impossível buscar
            if (!englishTitle && !brTitle) {
                console.log(`[Scraper] Sem título para ${imdbId}`);
                return [];
            }

            console.log(`[Scraper] EN: "${englishTitle}" | BR: "${brTitle}" | Ano: ${year}`);

            // PASSO 2: Buscar no YTSBR
            const bestMatch = await findBestPage(englishTitle || brTitle, brTitle, year, type);
            if (!bestMatch) {
                console.log(`[Scraper] Nenhum resultado no YTSBR para ${imdbId}`);
                return [];
            }

            // PASSO 3: Construir URL da página
            if (type === 'series' && season) {
                fetchUrl = `${BASE_URL}/${season}-temporada/${bestMatch.s}/`;
            } else {
                fetchUrl = buildPageUrl(bestMatch);
            }
        }

        // PASSO 4: Baixar e extrair torrents
        console.log(`[Scraper] Baixando: ${fetchUrl}`);
        const res = await axios.get(fetchUrl, { headers: HEADERS, timeout: 8000 });
        const $ = cheerio.load(res.data);
        const streams = extractStreams($, targetEp);

        console.log(`[Scraper] ${streams.length} streams extraídos`);
        if (streams.length > 0) cache.set(ck, streams);
        return streams;
    } catch (e) {
        console.error(`[Scraper] Erro: ${e.message}`);
        return [];
    }
}

module.exports = { getCatalog, getMeta, getStreams };
