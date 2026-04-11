const axios = require('axios');
const ch = require('cheerio');

async function debugSearch() {
    const q = 'Fullmetal Alchemist';
    const r = await axios.get('https://ytsbr.com/search/?q=' + encodeURIComponent(q), { headers: { 'User-Agent': 'Mozilla/5.0' }});
    const $ = ch.load(r.data);
    
    console.log('--- SEARCH DEBUG ---');
    $('a').each((i, el) => {
        const h = $(el).attr('href');
        const text = $(el).text().trim();
        if (h && (h.includes('/anime/') || h.includes('/serie/'))) {
            console.log(`Found: [${text}] -> ${h}`);
        }
    });
}
debugSearch();
