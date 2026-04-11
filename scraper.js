const axios = require('axios');
const cheerio = require('cheerio');

const BASE_URL = 'https://ytsbr.com';

async function getCatalog(type) {
    let url = '';
    if (type === 'movie') url = `${BASE_URL}/filmes-torrent/`;
    else if (type === 'series') url = `${BASE_URL}/series-torrent/`;
    else return [];

    try {
        const res = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const $ = cheerio.load(res.data);
        const metas = [];

        $('a').each((i, el) => {
            const href = $(el).attr('href');
            const img = $(el).find('img').attr('src') || $(el).find('img').attr('data-src');
            
            // Only consider links to /filme/ or /serie/ or /anime/ that has an image
            if (href && (href.includes('/filme/') || href.includes('/serie/') || href.includes('/anime/')) && img) {
                const slug = href.replace(/^\//, '').replace(/\/$/, ''); // e.g. "filme/slug" or "serie/slug"
                
                // Avoid duplication
                if (!metas.find(m => m.id === slug)) {
                    metas.push({
                        id: slug,
                        type: type,
                        name: $(el).find('img').attr('alt') || $(el).text().trim().replace(/\s+/g, ' '),
                        poster: img.startsWith('http') ? img : `${BASE_URL}${img}`
                    });
                }
            }
        });
        
        return metas;
    } catch (err) {
        console.error('Catalog extract error', err.message);
        return [];
    }
}

async function getMeta(type, slug) {
    try {
        const url = `${BASE_URL}/${slug}/`;
        const res = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const $ = cheerio.load(res.data);

        // Standard OpenGraph tags
        const title = $('meta[property="og:title"]').attr('content') || $('h1').text().trim();
        const description = $('meta[property="og:description"]').attr('content') || '';
        const poster = $('meta[property="og:image"]').attr('content') || '';
        
        let background = poster;
        if (poster && poster.includes('-poster')) {
             background = poster.replace('-poster', '-backdrop'); 
        }

        return {
            id: slug,
            type: type,
            name: title,
            description: description,
            poster: poster.startsWith('http') ? poster : `${BASE_URL}${poster}`,
            background: background,
            logo: poster
        };
    } catch (err) {
        console.error('Meta extract error', err.message);
        return null;
    }
}

async function getStreams(type, id_or_slug) {
    try {
        let fetchUrl = `${BASE_URL}/${id_or_slug}/`;

        // Se o Stremio pedir um filme/série comum passando o ID do IMDB (tt...)
        let targetEpisode = null;

        if (id_or_slug.startsWith('tt')) {
            try {
                const parts = id_or_slug.split(':');
                const baseId = parts[0];
                const season = parts.length > 1 ? parts[1] : null;
                const episode = parts.length > 2 ? parts[2] : null;

                if (type === 'series' && episode) {
                     targetEpisode = parseInt(episode);
                }

                // Pega nome original via cinemeta
                const metaType = type === 'movie' ? 'movie' : 'series';
                const cinemeta = await axios.get(`https://v3-cinemeta.strem.io/meta/${metaType}/${baseId}.json`);
                const title = cinemeta.data.meta.name;
                
                // Pesquisa no YTSBR
                const searchRes = await axios.get(`https://ytsbr.com/search/?q=${encodeURIComponent(title)}`, { headers: { 'User-Agent': 'Mozilla/5.0' }});
                const $search = cheerio.load(searchRes.data);
                
                // Pega o primeiro link de filme/serie
                let firstMatch = $search('a[href*="/filme/"], a[href*="/serie/"]').first().attr('href');
                if (!firstMatch) {
                     console.log(`Title '${title}' not found on YTSBR`);
                     return []; // Filme não encontrado no site
                }

                // Se for série, precisamos ir para a página da temporada!
                if (type === 'series' && season) {
                     const slug = firstMatch.split('/').filter(Boolean).pop(); // extrai 'invencivel' de '/serie/invencivel/'
                     fetchUrl = `${BASE_URL}/${season}-temporada/${slug}/`;
                } else {
                     if(firstMatch.startsWith('http')) fetchUrl = firstMatch;
                     else fetchUrl = `${BASE_URL}${firstMatch.startsWith('/') ? firstMatch : '/' + firstMatch}`;
                }
            } catch (e) {
                console.error('Failed to resolve IMDB to YTSBR slug:', e.message);
                return [];
            }
        }

        console.log(`Buscando link no YTSBR: ${fetchUrl}`);
        let res;
        try {
            res = await axios.get(fetchUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        } catch (err) {
            console.log(`Página YTSBR não retornou sucesso (404?): ${fetchUrl}`);
            return [];
        }

        const $ = cheerio.load(res.data);
        const html = res.data;
        
        const streams = [];
        let foundStreams = false;

        $('[data-downloads]').each((i, el) => {
            let isPack = false;
            // Se for série, checamos a qual episódio esse bloco se refere
            if (type === 'series' && targetEpisode !== null) {
                let parentText = $(el).closest('.episodiotitle, .ep, li').text() || $(el).parent().parent().text();
                // Verifica se é um pack (Full Season ou Animes com episódios "01 ~ 64")
                isPack = parentText.match(/PACK/i) || parentText.match(/Temporada Completa/i) || parentText.match(/\d+\s*~\s*\d+/);
                
                // Tenta achar E1, E01, Ep 1, Episodio 1
                let epMatch = parentText.match(/E(\d+)/i) || parentText.match(/Epis[óo]dio\s*(\d+)/i) || parentText.match(/Ep\s*(\d+)/i);
                
                if (!isPack) {
                    if (!epMatch) return; // Não conseguiu determinar o episódio
                    if (parseInt(epMatch[1]) !== targetEpisode) return; // Não é o episódio que queremos
                }
            }
            
            const dataAttr = $(el).attr('data-downloads');
            if (dataAttr) {
                try {
                    const parsed = JSON.parse(dataAttr);
                    parsed.forEach(item => {
                        if (item.magnet) {
                            let desc = [];
                            if (isPack) desc.push('📦 PACK (Série/Temporada Completa)');
                            if (item.audio) desc.push(item.audio);
                            if (item.quality) desc.push(item.quality);
                            if (item.imagemcinema_label) desc.push(item.imagemcinema_label);
                            if (item.size) desc.push(item.size);
                            if (item.seeders) desc.push(`👥 ${item.seeders}`);
                            
                            let resName = item.quality || 'Torrent';
                            if (String(item.magnet).toLowerCase().includes('1080p') || String(item.label).includes('1080p')) resName = '1080p';
                            if (String(item.magnet).toLowerCase().includes('2160p') || String(item.label).includes('4K')) resName = '4K';
                            if (String(item.magnet).toLowerCase().includes('720p') || String(item.label).includes('720p')) resName = '720p';

                            const infoHashMatch = item.magnet.match(/urn:btih:([a-zA-Z0-9]+)/i);
                            if (infoHashMatch) {
                                streams.push({
                                    name: `YTSBR ${resName}`,
                                    description: desc.join(' | ') || item.label || 'Torrent HD',
                                    infoHash: infoHashMatch[1]
                                });
                                foundStreams = true;
                            }
                        }
                    });
                } catch (e) {}
            }
        });

        if (!foundStreams) {
            const magnetMatches = html.match(/magnet:\?xt=urn:btih:[a-zA-Z0-9&%=\-\.]+/gi);
            if (magnetMatches) {
                const uniqueMagnets = [...new Set(magnetMatches)];
                uniqueMagnets.forEach(magnet => {
                    let name = 'Torrent';
                    if (magnet.toLowerCase().includes('1080p') || html.toLowerCase().includes('1080p')) name = '1080p';
                    if (magnet.toLowerCase().includes('2160p') || magnet.toLowerCase().includes('4k') || html.toLowerCase().includes('4k')) name = '4K';
                    if (magnet.toLowerCase().includes('720p') || html.toLowerCase().includes('720p')) name = '720p';

                    streams.push({
                        name: `YTSBR`,
                        description: `${name} - Torrent`,
                        infoHash: magnet.match(/urn:btih:([a-zA-Z0-9]+)/i)[1]
                    });
                });
            }
        }
        
        return streams;
    } catch (err) {
        console.error('Stream extract error', err.message);
        return [];
    }
}

module.exports = { getCatalog, getMeta, getStreams };
