const axios = require('axios');
const ch = require('cheerio');

async function checkImdbOnPage() {
    try {
        // First find the page for Divertida Mente 2
        const search = await axios.get('https://ytsbr.com/search/?q=' + encodeURIComponent('Divertida Mente 2'));
        const $s = ch.load(search.data);
        const url = 'https://ytsbr.com' + $s('a[href*="/filme/"]').first().attr('href');
        console.log('Found URL:', url);
        
        const page = await axios.get(url);
        const $ = ch.load(page.data);
        const html = page.data;
        
        console.log('Contains tt22022452?', html.includes('tt22022452'));
        // Look for IMDb links
        console.log('IMDb link:', $('a[href*="imdb.com"]').attr('href'));
        
    } catch (e) {
        console.log('Error:', e.message);
    }
}
checkImdbOnPage();
