const axios = require('axios');
const cheerio = require('cheerio');

async function testMatrix() {
    const res = await axios.get('https://ytsbr.com/search/?q=Matrix');
    const $ = cheerio.load(res.data);
    const links = [];
    $('a[href*="/filme/"]').each((i, el) => {
        links.push({
            href: $(el).attr('href'),
            title: $(el).find('img').attr('alt') || $(el).text().trim()
        });
    });
    console.log(links[0]);
}
testMatrix();
