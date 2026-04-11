const cheerio = require('cheerio');

async function run() {
    const url = 'https://ytsbr.com/filme/devoradores-de-estrelas/';
    const res = await fetch(url);
    const html = await res.text();
    
    // Find all magnet strings in the raw HTML
    const magnetMatch = html.match(/magnet:\?xt=urn:btih:[a-zA-Z0-9]+/g);
    console.log('Raw Magnets:', [...new Set(magnetMatch)]);

    const torrentMatch = html.match(/https?:\/\/[^\s"']+\.torrent/g);
    console.log('Raw Torrents:', [...new Set(torrentMatch)]);
    
    // Log the API path if it makes inner requests
    const apiMatch = html.match(/\/api\/[^\s"']+/g);
    console.log('API Paths:', [...new Set(apiMatch)]);
}
run();
