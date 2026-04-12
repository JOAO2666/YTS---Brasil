const axios = require('axios');
const ch = require('cheerio');

async function testSlugSearch() {
    try {
        const query = 'inside-out-2';
        const r = await axios.get('https://ytsbr.com/search/?q=' + query, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const $ = ch.load(r.data);
        const results = $('a[href*="/filme/"], a[href*="/serie/"]');
        console.log('Results for', query, ':', results.length);
        results.each((i, el) => {
            console.log('Result:', $(el).text().trim(), $(el).attr('href'));
        });
    } catch (e) {
        console.log('Error:', e.message);
    }
}
testSlugSearch();
