const cheerio = require('cheerio');

async function run() {
    const res = await fetch('https://ytsbr.com/');
    const html = await res.text();
    const $ = cheerio.load(html);

    const posts = [];
    $('a').each((i, el) => {
        const href = $(el).attr('href');
        const text = $(el).text().trim().replace(/\s+/g, ' ').substring(0, 50);
        if (href && (href.includes('torrent') || href.includes('filme') || href.includes('serie') || href.includes('anime'))) {
           posts.push({ href, text, class: $(el).attr('class')});
        }
    });

    console.log('Total A tags:', $('a').length);
    console.log('Sample matching links:');
    console.dir(posts.slice(0, 15), { depth: null });
}
run();
