const axios = require('axios');
const ch = require('cheerio');

async function checkAnime() {
    try {
        const url = 'https://ytsbr.com/anime/fullmetal-alchemist-brotherhood/';
        const r = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }});
        const $ = ch.load(r.data);
        const packs = $('[data-downloads]');
        console.log('Anime URL:', url);
        console.log('Data-Downloads found:', packs.length);
        
        packs.each((i, el) => {
            const data = $(el).attr('data-downloads');
            console.log('Data:', data.substring(0, 50));
        });
        
        const magnets = r.data.match(/magnet:\?xt=urn:btih:[a-zA-Z0-9]+/gi) || [];
        console.log('Magnets count:', magnets.length);
    } catch (e) {
        console.log('Error:', e.message);
    }
}
checkAnime();
