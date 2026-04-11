const scraper = require('./scraper');

async function test() {
    console.log('--- TESTANDO DIVERTIDA MENTE 2 (tt22022452) ---');
    try {
        const streams = await scraper.getStreams('movie', 'tt22022452');
        console.log(`Resultados encontrados: ${streams.length}`);
        streams.forEach(s => console.log(`[${s.name}] ${s.description}`));
    } catch (e) {
        console.error('ERRO NO TESTE:', e);
    }

    console.log('\n--- TESTANDO FULLMETAL ALCHEMIST (tt1423028) ---');
    try {
        const animeStreams = await scraper.getStreams('series', 'tt1423028:1:1');
        console.log(`Resultados encontrados: ${animeStreams.length}`);
        animeStreams.forEach(s => console.log(`[${s.name}] ${s.description}`));
    } catch (e) {
        console.error('ERRO NO TESTE:', e);
    }
}

test();
