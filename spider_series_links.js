const fs = require('fs');
const ch = require('cheerio');
const html = fs.readFileSync('test_series.html', 'utf8');
const $ = ch.load(html);
$('a').each((i, e) => {
    let h = $(e).attr('href');
    if (h && !h.includes('#') && !h.includes('wp-admin')) {
        console.log($(e).text().trim().substring(0,30), h.substring(0, 50));
    }
});
