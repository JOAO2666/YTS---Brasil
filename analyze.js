const fs = require('fs');
const cheerio = require('cheerio');

const html = fs.readFileSync('ytsbr_index.html', 'utf-8');
const $ = cheerio.load(html);

const links = [];
$('a').each((i, el) => {
    const href = $(el).attr('href');
    links.push({ href: href ? href.substring(0, 50) : null, class: $(el).attr('class'), text: $(el).text().trim().substring(0, 30) });
});
console.log('Sample ALL links found:');
console.dir(links.slice(0, 20), { depth: null });
