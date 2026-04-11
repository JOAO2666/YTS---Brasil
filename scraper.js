const axios = require('axios');
const cheerio = require('cheerio');
const NodeCache = require('node-cache');

const BASE_URL = 'https://ytsbr.com';
const myCache = new NodeCache({ stdTTL: 3600 * 24 });
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36';

async function getBrazilianTitle(imdbId, englishTitle) {
    try {
        const wikiSearch = `https://en.wikipedia.org/w/api.php?action=query&prop=langlinks&lllang=pt&titles=${encodeURIComponent(englishTitle)}&format=json&redirects=1`;
        const res = await axios.get(wikiSearch, { headers: { 'User-Agent': UA }, timeout: 3000 });
        const pages = res.data?.query?.pages;
        if (pages) {
            const page = Object.values(pages)[0];
            if (page.langlinks && page.langlinks[0]) return page.langlinks[0]['*'];
        }
    } catch (e) {}
    return null;
}

async function smartSearch(title, year = '') {
    const cleanTitle = title.split(':')[0].trim();
    const firstWord = cleanTitle.split(' ')[0].replace(/[^a-zA-Z0-9]/g, '');
    const queries = [...new Set([title, cleanTitle, `${firstWord} ${year}`])];

    try {
        const promises = [];
        queries.forEach(q => {
            promises.push(axios.get(`${BASE_URL}/ajax/search_v2.php?q=${encodeURIComponent(q)}&lang=pt-br`, { headers: { 'User-Agent': UA, 'Referer': BASE_URL }, timeout: 5000 }).catch(() => null));
            promises.push(axios.get(`${BASE_URL}/ajax/search_v2.php?q=${encodeURIComponent(q)}&lang=global`, { headers: { 'User-Agent': UA, 'Referer': BASE_URL }, timeout: 5000 }).catch(() => null));
        });

        const responses = await Promise.all(promises);
        let results = [];
        responses.forEach(r => { if (r && Array.isArray(r.data)) results = [...results, ...r.data]; });

        if (results.length === 0) return null;

        results.sort((a, b) => {
            const aY = a.y == year ? 0 : 1;
            const bY = b.y == year ? 0 : 1;
            if (aY !== bY) return aY - bY;
            const aPt = a.l === 'pt-br' ? 0 : 1;
            const bPt = b.l === 'pt-br' ? 0 : 1;
            if (aPt !== bPt) return aPt - bPt;
            return a.s.length - b.s.length;
        });

        const best = results[0];
        const prefix = best.l === 'en' ? '/en' : (best.l === 'es' ? '/es' : '');
        let tp = best.tp;
        if (best.l === 'en') {
            if (tp === 'filme') tp = 'movie';
            if (tp === 'serie') tp = 'tvshow';
        }
        return `${prefix}/${tp}/${best.s}/`;
    } catch (e) { return null; }
}

async function getCatalog(type) {
    const url = type === 'movie' ? `${BASE_URL}/filmes-torrent/` : `${BASE_URL}/series-torrent/`;
    try {
        const res = await axios.get(url, { headers: { 'User-Agent': UA } });
        const $ = cheerio.load(res.data);
        const metas = [];
        $('a').each((i, el) => {
            const href = $(el).attr('href');
            const img = $(el).find('img').attr('src') || $(el).find('img').attr('data-src');
            if (href && (href.includes('/filme/') || href.includes('/serie/')) && img) {
                metas.push({
                    id: href.replace(/^\//, '').replace(/\/$/, ''),
                    type: type,
                    name: $(el).find('img').attr('alt') || 'Torrent',
                    poster: img.startsWith('http') ? img : `${BASE_URL}${img}`
                });
            }
        });
        return metas;
    } catch (e) { return []; }
}

async function getMeta(type, slug) {
    try {
        const res = await axios.get(`${BASE_URL}/${slug}/`, { headers: { 'User-Agent': UA } });
        const $ = cheerio.load(res.data);
        const poster = $('meta[property="og:image"]').attr('content') || '';
        return {
            id: slug,
            type: type,
            name: $('meta[property="og:title"]').attr('content') || $('h1').text().trim(),
            description: $('meta[property="og:description"]').attr('content') || '',
            poster: poster.startsWith('http') ? poster : `${BASE_URL}${poster}`
        };
    } catch (e) { return null; }
}

async function getStreams(type, id) {
    const cacheKey = `streams_${id}`;
    const cached = myCache.get(cacheKey);
    if (cached) return cached;

    try {
        let fetchUrl = `${BASE_URL}/${id}/`;
        let targetEp = null;

        if (id.startsWith('tt')) {
            const [imdbId, s, e] = id.split(':');
            if (e) targetEp = parseInt(e);

            const cinemetaUrl = `https://v3-cinemeta.strem.io/meta/${type === 'movie' ? 'movie' : 'series'}/${imdbId}.json`;
            const cinemeta = await axios.get(cinemetaUrl).catch(() => null);
            if (!cinemeta || !cinemeta.data || !cinemeta.data.meta) return [];

            const meta = cinemeta.data.meta;
            const englishTitle = meta.name;
            const year = meta.year || '';

            let match = await smartSearch(englishTitle, year);
            const brTitle = await getBrazilianTitle(imdbId, englishTitle);
            if (brTitle && brTitle !== englishTitle) {
                const brMatch = await smartSearch(brTitle, year);
                if (brMatch) match = brMatch;
            }

            if (!match) return [];
            
            if (type === 'series' && s) {
                const slug = match.split('/').filter(Boolean).pop();
                fetchUrl = `${BASE_URL}/${s}-temporada/${slug}/`;
            } else {
                fetchUrl = match.startsWith('http') ? match : `${BASE_URL}${match.startsWith('/') ? '' : '/'}${match}`;
            }
        }

        const res = await axios.get(fetchUrl, { headers: { 'User-Agent': UA }, timeout: 10000 });
        const $ = cheerio.load(res.data);
        const streams = [];

        $('[data-downloads]').each((i, el) => {
            const data = JSON.parse($(el).attr('data-downloads') || '[]');
            const context = $(el).closest('li, tr, .episodiotitle, .ep').text();
            let isPack = /PACK|Completa|Temporada|Todos/i.test(context);
            let epMatch = context.match(/E(\d+)/i) || context.match(/Ep\s*(\d+)/i) || context.match(/Epis[óo]dio\s*(\d+)/i);
            if (targetEp && !isPack && (!epMatch || parseInt(epMatch[1]) !== targetEp)) return;
            data.forEach(item => {
                const hash = (item.magnet || '').match(/btih:([a-fA-F0-9]+)/i);
                if (hash) {
                    streams.push({
                        name: `YTSBR ${item.quality || 'HD'}`,
                        description: `${isPack ? '📦 PACK | ' : ''}${item.audio || ''} | ${item.size || ''}`,
                        infoHash: hash[1]
                    });
                }
            });
        });

        if (streams.length === 0) {
            $('a[href^="magnet:"]').each((i, el) => {
                const magnet = $(el).attr('href');
                const hash = magnet.match(/btih:([a-fA-F0-9]+)/i);
                if (hash) {
                    streams.push({
                        name: 'YTSBR Torrent',
                        description: $(el).closest('li, tr, p').text().trim().substring(0, 70),
                        infoHash: hash[1]
                    });
                }
            });
        }

        myCache.set(cacheKey, streams);
        return streams;
    } catch (e) { return []; }
}

module.exports = { getCatalog, getMeta, getStreams };
